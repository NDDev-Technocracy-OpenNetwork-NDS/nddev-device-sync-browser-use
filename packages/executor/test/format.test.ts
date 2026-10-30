// How an execution's result reads to an agent.
import { expect, test } from "bun:test";
import {
  bounded,
  compose,
  describeError,
  errorParts,
  OUTPUT_LIMIT,
  render,
  shortUrl,
  shown,
  tag,
  waitBudget,
} from "../agent/format.js";

// A stand-in for a Playwright client object: a channel owner with a type and a guid.
function page(url: string) {
  return { _type: "Page", _guid: "page@1", url: () => url, _connection: { env: { SECRET: "x" } } };
}

test("results read in a fixed order and an empty run says so", () => {
  expect(compose({ notices: [], console: [] })).toBe("Code executed successfully (no output)");
  expect(
    compose({
      notices: ["[WARNING] Page closed"],
      console: [
        { method: "log", values: ["loaded", 2] },
        { method: "error", values: [{ a: 1 }] },
      ],
      value: "done",
    }),
  ).toBe(
    "[WARNING] Page closed\n\nConsole output:\n[log] loaded 2\n[error] { a: 1 }\n\n[return value] done",
  );
  expect(compose({ notices: [], console: [{ method: "log", values: ["x"] }], error: "boom" })).toBe(
    "Console output (before error):\n[log] x\n\nError: boom",
  );
});

test("results carry no terminal escapes or control characters", () => {
  const text = compose({
    notices: [],
    console: [
      {
        method: "log",
        values: [
          "\u001B[31mred\u001B[0m\r\n\u001B]8;;https://x.test\u0007link\u001B]8;;\u0007\u0000\tend",
        ],
      },
    ],
    value: "\u001B[1mdone\u001B[22m",
  });
  expect(text).toBe("Console output:\n[log] red\nlink\tend\n\n[return value] done");
});

test("Playwright objects print as tags, never their internals", () => {
  expect(tag(page("https://example.test/a"))).toBe("<Page https://example.test/a>");
  const response = {
    _type: "Response",
    _guid: "r",
    url: () => "https://e.test/",
    status: () => 200,
  };
  expect(tag(response)).toBe("<Response 200 https://e.test/>");
  const locator = { _selector: "role=button", _frame: {}, toString: () => "getByRole('button')" };
  expect(tag(locator)).toBe("<Locator getByRole('button')>");
  const nested = render({ page: page("https://example.test/"), items: [page("https://b.test/")] });
  expect(nested).toContain("<Page https://example.test/>");
  expect(nested).not.toContain("SECRET");
  // An action's own result, such as goto's Response, is not printed as the value.
  expect(compose({ notices: [], console: [], value: response })).toBe(
    "Code executed successfully (no output)",
  );
});

test("long URLs keep their origin and path and only the size of the query", () => {
  const query = `?${"x".repeat(1500)}`;
  expect(shortUrl(`https://accounts.example.test/signin${query}`)).toBe(
    "https://accounts.example.test/signin?… (1501 characters)",
  );
  expect(shortUrl("https://example.test/short")).toBe("https://example.test/short");
});

test("long output is cut at the limit with a hint", () => {
  const { output, truncated } = bounded("a".repeat(OUTPUT_LIMIT + 50));
  expect(truncated).toBe(true);
  expect(output.startsWith("a".repeat(OUTPUT_LIMIT))).toBe(true);
  expect(output).toContain(
    `[Truncated: ${OUTPUT_LIMIT} of ${OUTPUT_LIMIT + 50} characters, 1 of 1 lines.`,
  );
  expect(bounded("short")).toEqual({ output: "short", truncated: false });
  // Lines end where they end: a cut near the limit falls on the last whole line.
  const lines = Array.from({ length: 2000 }, (_, index) => `- line ${index}`).join("\n");
  const cut = bounded(lines).output;
  const shown = cut.slice(0, cut.indexOf("\n\n[Truncated"));
  expect(shown.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
  expect(lines.startsWith(`${shown}\n`)).toBe(true);
  expect(cut).toContain(`of ${lines.length} characters`);
});

test("a timeout names why the action could not proceed and keeps its last call log lines", () => {
  const error = new Error(
    [
      "locator.click: Timeout 5000ms exceeded.",
      "Call log:",
      "  - waiting for getByRole('button', { name: 'Play' })",
      "    - locator resolved to <button>Play</button>",
      "  - attempting click action",
      "    - element is not visible",
      "  - retrying click action",
      "    - element is not visible",
    ].join("\n"),
  );
  error.name = "TimeoutError";
  const text = describeError(error);
  expect(text.split("\n")[0]).toBe(
    "locator.click: Timeout 5000ms exceeded. (element is not visible)",
  );
  expect(text.match(/element is not visible/g)?.length).toBe(2);
  const missing = new Error(
    "locator.click: Timeout 1000ms exceeded.\nCall log:\n  - waiting for locator('#gone')",
  );
  missing.name = "TimeoutError";
  expect(describeError(missing).split("\n")[0]).toContain("no element matched the locator");
  // Playwright dims call log lines where it detects a color terminal, as on Windows runners.
  const colored = new Error(
    "click: Timeout 2999ms exceeded.\nCall log:\n\u001B[2m  - waiting for locator('#missing')\u001B[22m\n\n",
  );
  colored.name = "TimeoutError";
  expect(describeError(colored)).toBe(
    "click: Timeout 2999ms exceeded. (no element matched the locator; take a fresh snapshot)\nCall log:\n  - waiting for locator('#missing')",
  );
  expect(describeError(new TypeError("x is not a function"))).toBe(
    "TypeError: x is not a function",
  );
});

test("no edge of a value lets inspect reach a Playwright object's internals", () => {
  const marker = "SECRET-ENV-MARKER";
  const secret = () => ({
    _type: "Page",
    _guid: "page@2",
    url: () => "https://example.test/",
    _connection: { _platform: { env: { TOKEN: marker } } },
  });
  class Wrapper {
    constructor(readonly page: object) {}
  }
  const cyclic: Record<string, unknown> = { page: secret() };
  cyclic.self = cyclic;
  let read = false;
  const getter = {
    get page() {
      read = true;
      return secret();
    },
  };
  const failed = Object.assign(new Error("boom"), { page: secret() });
  // Built-ins and functions carrying a page in a field of their own.
  const carrying = <T extends object>(value: T): T => Object.assign(value, { page: secret() });
  const builtIns = [
    carrying(new Date(0)),
    carrying(/pattern/g),
    carrying(new Uint8Array([1, 2])),
    carrying(new ArrayBuffer(4)),
    carrying(Buffer.from("ab")),
    carrying(new URL("https://example.test/")),
    carrying(new DataView(new ArrayBuffer(2))),
    carrying(function named() {}),
    carrying(() => 1),
  ];
  for (const value of [
    ...builtIns,
    { nested: builtIns },
    new Map([[secret(), 1]]),
    new Map([[1, secret()]]),
    new Set([secret()]),
    new Wrapper(secret()),
    [new Wrapper(new Wrapper(secret()))],
    cyclic,
    getter,
    failed,
    Promise.resolve(secret()),
  ]) {
    const text = render(value);
    expect(text).not.toContain(marker);
    expect(text).not.toContain("_connection");
  }
  expect(read).toBe(false);
  expect(render(new Wrapper(secret()))).toBe("Wrapper { page: <Page https://example.test/> }");
  expect(render(cyclic)).toContain("[Circular]");
  expect(render(new Map([[secret(), 1]]))).toContain("<Page https://example.test/> => 1");
  expect(render({ when: new Date(0), pattern: /a/ })).toContain("1970-01-01");
  expect(render(carrying(new Date(0)))).toContain("1970-01-01");
  expect(render(carrying(new Uint8Array([7])))).toContain("7");
  expect(render(carrying(function named() {}))).toBe("[Function: named]");
});

test("subclasses of built-ins never construct what inspect walks", () => {
  const marker = "SECRET-SPECIES-MARKER";
  const secret = () => ({
    _type: "Page",
    _guid: "page@3",
    url: () => "https://example.test/",
    _connection: { _platform: { env: { TOKEN: marker } } },
  });
  // Ordinary subclasses with a class field: their species would build a new instance with a page.
  class PageBytes extends Uint8Array {
    page = secret();
  }
  class PageBuffer extends ArrayBuffer {
    page = secret();
  }
  class PageArray extends Array<unknown> {
    page = secret();
  }
  class PageMap extends Map<unknown, unknown> {
    page = secret();
  }
  class PageSet extends Set<unknown> {
    page = secret();
  }
  class PageDate extends Date {
    page = secret();
  }
  class PageRegExp extends RegExp {
    page = secret();
  }
  class PageUrl extends URL {
    page = secret();
  }
  class PageError extends Error {
    page = secret();
  }
  class PageNodeBuffer extends Buffer {
    page = secret();
  }
  const indexed: unknown[] = [];
  Object.defineProperty(indexed, 0, { get: secret, enumerable: true });
  const cases: unknown[] = [
    new PageBytes([1, 2]),
    new PageBuffer(2),
    new PageArray(1, 2),
    new PageMap([["a", 1]]),
    new PageSet([1]),
    new PageDate(0),
    new PageRegExp("a", "g"),
    new PageUrl("https://example.test/"),
    new PageError("boom"),
    Object.setPrototypeOf(Buffer.from("ab"), PageNodeBuffer.prototype),
    new Proxy({ page: secret() }, {}),
    indexed,
    Object.create(Date.prototype),
    Object.create(Uint8Array.prototype),
    Object.create(URL.prototype),
  ];
  for (const value of [...cases, { nested: cases }]) {
    const text = render(value);
    expect(text).not.toContain(marker);
    expect(text).not.toContain("_connection");
  }
  expect(render(new PageBytes([1, 2]))).toBe("Uint8Array(2) [ 1, 2 ]");
  expect(render(new PageArray(1, 2))).toBe("[ 1, 2 ]");
  expect(render(new PageMap([["a", 1]]))).toBe("Map(1) { 'a' => 1 }");
  expect(render(new PageDate(0))).toBe("1970-01-01T00:00:00.000Z");
  expect(render(new PageRegExp("a", "gi"))).toBe("/a/gi");
  expect(render(new PageUrl("https://example.test/"))).toBe(
    "URL { href: 'https://example.test/' }",
  );
  expect(render(new PageError("boom"))).toBe("[Error: boom]");
  expect(render(Buffer.from("ab"))).toBe("<Buffer 61 62>");
  expect(render(indexed)).toBe("[ [Getter] ]");
  const detached = new ArrayBuffer(2);
  const view = new Uint8Array(detached);
  structuredClone(detached, { transfer: [detached] });
  expect(render([detached, view, Object.create(URL.prototype)])).toBe(
    "[ [detached], [detached], [URL] ]",
  );
  expect(render(Array.from({ length: 150 }, (_, index) => index))).toContain("... 50 more items");
});

test("reading a value for its text runs none of the agent's code", () => {
  let runs = 0;
  // Every trap counts and throws, as hostile code would.
  const trapping = (target: object) =>
    new Proxy(target, {
      has() {
        runs += 1;
        throw new Error("has trap");
      },
      get() {
        runs += 1;
        throw new Error("get trap");
      },
      getPrototypeOf() {
        runs += 1;
        throw new Error("getPrototypeOf trap");
      },
      getOwnPropertyDescriptor() {
        runs += 1;
        throw new Error("getOwnPropertyDescriptor trap");
      },
      ownKeys() {
        runs += 1;
        throw new Error("ownKeys trap");
      },
      apply() {
        runs += 1;
        throw new Error("apply trap");
      },
    });
  const root = trapping({});
  expect(compose({ notices: [], console: [], value: root })).toBe("[return value] [Proxy]");
  expect(compose({ notices: [], console: [{ method: "log", values: [root] }] })).toBe(
    "Console output:\n[log] [Proxy]",
  );
  expect(shown(root)).toBe(true);
  expect(tag(root)).toBeUndefined();
  expect(render(root)).toBe("[Proxy]");
  expect(describeError(root)).toBe("[Proxy]");
  expect(errorParts(root)).toBeUndefined();
  expect(render(trapping(() => 1))).toBe("[Proxy]");
  // A proxy prototype ends every walk up the chain before it.
  const inheriting = Object.create(trapping(Object.create(null)));
  expect(render(inheriting)).toBe("Object {}");
  expect(tag(inheriting)).toBeUndefined();
  expect(describeError(inheriting)).toBe("Object {}");
  const error = Object.setPrototypeOf(new Error("boom"), trapping(Object.create(null)));
  expect(describeError(error)).toBe("boom");
  // A Playwright object's method that is itself a proxy is not called.
  expect(tag({ _type: "Page", _guid: "page@1", url: trapping(() => "x") })).toBe("<Page>");
  expect(runs).toBe(0);
  // Accessors are never markers, names or messages, and are never called.
  let reads = 0;
  const read = () => {
    reads += 1;
    return "Page";
  };
  const marker = Object.create(null);
  Object.defineProperty(marker, "_type", { enumerable: true, get: read });
  Object.defineProperty(marker, "_guid", { enumerable: true, value: "page@1" });
  expect(tag(marker)).toBeUndefined();
  expect(render(marker)).toBe("{ _type: [Getter], _guid: 'page@1' }");
  const located = { _selector: "#a", _frame: {} };
  Object.defineProperty(located, "toString", { get: read });
  expect(tag(located)).toBe("<Locator #a>");
  const failed = new Error("kept");
  Object.defineProperty(failed, "message", { get: read });
  Object.defineProperty(failed, "name", { get: read });
  expect(describeError(failed)).toBe("");
  expect(errorParts(failed)).toEqual({ name: "Error", message: "" });
  expect(reads).toBe(0);
});

test("Playwright waits always end inside the execution's remaining budget", () => {
  expect(waitBudget(10_000)).toBe(9_000);
  expect(waitBudget(2_000)).toBe(1_000);
  expect(waitBudget(1_000)).toBe(500);
  expect(waitBudget(100)).toBe(50);
  expect(waitBudget(1)).toBe(1);
  for (const budget of [1, 2, 10, 999, 1_000, 1_999, 25_000]) {
    expect(waitBudget(budget)).toBeGreaterThan(0);
    expect(waitBudget(budget) <= budget).toBe(true);
  }
});
