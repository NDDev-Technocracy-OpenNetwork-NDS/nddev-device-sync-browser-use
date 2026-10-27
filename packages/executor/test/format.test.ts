// How an execution's result reads to an agent.
import { expect, test } from "bun:test";
import {
  bounded,
  compose,
  describeError,
  OUTPUT_LIMIT,
  render,
  shortUrl,
  tag,
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
  expect(output).toContain(`[Truncated to ${OUTPUT_LIMIT} characters`);
  expect(bounded("short")).toEqual({ output: "short", truncated: false });
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
  expect(describeError(new TypeError("x is not a function"))).toBe(
    "TypeError: x is not a function",
  );
});
