// What a snapshot's refs and locators name, and what it leaves behind, against inert stand-ins for
// a page, its CDP session and its elements.
import { expect, test } from "bun:test";
import type { Frame, Locator, Page } from "playwright-core";
import { getAriaSnapshot } from "../agent/aria.js";
import { refToLocator, snapshot } from "../agent/snapshot.js";

type Fixture = {
  page: Page;
  attributes: Record<string, string>;
  detached: () => number;
  element: {
    getAttribute(key: string): string | null;
    setAttribute(key: string, value: string): void;
    removeAttribute(key: string): void;
  };
};

// A page of two equal Save buttons in a container whose element carries the page's own
// data-pw-scope attribute; `failing` names a CDP method that fails.
function fixture(failing?: string): Fixture {
  let detached = 0;
  const attributes: Record<string, string> = { "data-pw-scope": "page-own" };
  const session = {
    async detach() {
      detached += 1;
    },
    async send(method: string) {
      if (method === failing) throw new Error(`${method} failed`);
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", url: "https://main.test/", name: "" } } };
      }
      if (method === "DOM.getFlattenedDocument") {
        return {
          nodes: [
            {
              nodeId: 1,
              backendNodeId: 1,
              nodeName: "DIV",
              attributes: Object.entries(attributes).flat(),
            },
            { nodeId: 2, parentId: 1, backendNodeId: 2, nodeName: "BUTTON", attributes: [] },
            { nodeId: 3, parentId: 1, backendNodeId: 3, nodeName: "BUTTON", attributes: [] },
          ],
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        const button = (nodeId: string, backendDOMNodeId: number) => ({
          nodeId,
          parentId: "root",
          ignored: false,
          role: { value: "button" },
          name: { value: "Save" },
          backendDOMNodeId,
        });
        return {
          nodes: [
            {
              nodeId: "root",
              ignored: false,
              role: { value: "RootWebArea" },
              childIds: ["a", "b"],
              backendDOMNodeId: 1,
            },
            button("a", 2),
            button("b", 3),
          ],
        };
      }
      return {};
    },
  };
  const main = { parentFrame: () => null };
  const page = {
    goto() {},
    mainFrame: () => main,
    context: () => ({ newCDPSession: async () => session }),
    evaluate: async () => undefined,
    url: () => "https://main.test/",
    on() {},
  } as unknown as Page;
  const element = {
    getAttribute(key: string) {
      return attributes[key] ?? null;
    },
    setAttribute(key: string, value: string) {
      attributes[key] = value;
    },
    removeAttribute(key: string) {
      delete attributes[key];
    },
  };
  return { page, attributes, detached: () => detached, element };
}

// A child frame of the page that its session cannot reach, whose element the page finds by name.
function child(page: Page): Frame {
  return {
    url: () => "https://child.test/",
    name: () => "child",
    page: () => page,
    parentFrame: () => page.mainFrame(),
    frameElement: async () => ({
      evaluate: async () => 'iframe[name="child"]',
      dispose: async () => undefined,
    }),
    evaluate: async () => undefined,
    locator: () => ({ ariaSnapshot: async () => '- button "Child" [ref=e1]' }),
  } as unknown as Frame;
}

test("the CDP session is detached whichever setup step fails", async () => {
  for (const failing of ["DOM.enable", "Page.getFrameTree", "DOM.getFlattenedDocument"]) {
    const { page, detached } = fixture(failing);
    const frame = failing === "Page.getFrameTree" ? child(page) : undefined;
    await expect(getAriaSnapshot({ page, frame })).rejects.toThrow();
    expect(detached()).toBe(1);
  }
});

test("equal locators keep their nth in both the lines and the ref selectors", async () => {
  const { page } = fixture();
  const result = await getAriaSnapshot({ page });
  expect(result.snapshot).toBe(
    '- role=button[name="Save"i] >> nth=0\n- role=button[name="Save"i] >> nth=1',
  );
  expect(result.refs.map((entry) => result.getSelectorForRef(entry.ref))).toEqual([
    'role=button[name="Save"i] >> nth=0',
    'role=button[name="Save"i] >> nth=1',
  ]);
});

test("a part's ref selectors start with the frames and the part they are inside", async () => {
  const { page, element } = fixture();
  const frame = child(page);
  const locator = {
    _frame: frame,
    _selector: "#first",
    evaluate: async <A>(run: (target: typeof element, argument: A) => void, argument: A) =>
      run(element, argument),
  } as unknown as Locator;
  const result = await getAriaSnapshot({ page, locator });
  expect(result.refs.map((entry) => result.getSelectorForRef(entry.ref))[1]).toBe(
    'iframe[name="child"] >> internal:control=enter-frame >> #first >> role=button[name="Save"i] >> nth=1',
  );
});

test("a part's snapshot marks it with its own attribute and leaves the page's own", async () => {
  const { page, attributes, element } = fixture();
  const marks: string[] = [];
  const locator = {
    evaluate: async <A>(run: (target: typeof element, argument: A) => void, argument: A) => {
      run(element, argument);
      marks.push(...Object.keys(attributes).filter((key) => key.startsWith("data-nds-scope-")));
    },
  } as unknown as Locator;
  await getAriaSnapshot({ page, locator });
  expect(marks.length).toBeGreaterThan(0);
  expect(attributes).toEqual({ "data-pw-scope": "page-own" });
});

test("refs resolve through the last view that showed them, never an earlier one", async () => {
  const { page } = fixture();
  await snapshot({ page });
  // Snapshot lines show locators, so Playwright's own refs keep their meaning.
  expect(refToLocator({ page, ref: "e1" })).toBe("aria-ref=e1");
  const view = await snapshot({ page, frame: child(page) });
  expect(view).toContain('- button "Child" [ref=e1]');
  expect(view).toContain("Locators are inside the frame");
  expect(refToLocator({ page, ref: "e1" })).toBe(
    'iframe[name="child"] >> internal:control=enter-frame >> aria-ref=e1',
  );
});
