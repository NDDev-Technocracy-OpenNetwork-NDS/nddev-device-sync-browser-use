// The search and diff views that keep agent output small.
import { expect, test } from "bun:test";
import { diffed, searched, Views } from "../agent/text";

const page = [
  "- banner:",
  '  - link "Home" [ref=e1]',
  "- main:",
  '  - button "Save" [ref=e2]',
  '  - button "Cancel" [ref=e3]',
].join("\n");

test("a search shows the matching lines, with context ranges merged", () => {
  expect(searched(page, /button/)).toBe('  - button "Save" [ref=e2]\n  - button "Cancel" [ref=e3]');
  expect(searched(page, "HOME")).toBe('  - link "Home" [ref=e1]');
  expect(searched(page, "Save", 1)).toBe(
    '- main:\n  - button "Save" [ref=e2]\n  - button "Cancel" [ref=e3]',
  );
  expect(searched(page, /missing/)).toBe("No matches found");
  // A global flag would make the pattern skip lines.
  expect(searched(page, /button/g)).toContain("Cancel");
});

test("a diff shows what changed, or nothing when printing the view again is shorter", () => {
  expect(diffed(page, page)).toBe("No changes since last call");
  const changed = page.replace('"Cancel" [ref=e3]', '"Close" [ref=e4]');
  expect(diffed(page, changed)).toBe(
    '    - button "Save" [ref=e2]\n-   - button "Cancel" [ref=e3]\n+   - button "Close" [ref=e4]',
  );
  expect(diffed("a", "b")).toBeUndefined();
});

test("views show in full first, then changes, and a search turns the diff off", () => {
  const views = new Views<object>(0);
  const key = {};
  expect(views.show(key, "page", "URL: u", page, {})).toBe(`URL: u\n\n${page}`);
  expect(views.show(key, "page", "URL: u", page, {})).toBe("URL: u\n\nNo changes since last call");
  expect(views.show(key, "page", "URL: u", page, { search: "Save" })).toBe(
    'URL: u\n\n  - button "Save" [ref=e2]',
  );
  expect(views.show(key, "page", "URL: u", page, { showDiffSinceLastCall: false })).toBe(
    `URL: u\n\n${page}`,
  );
  // Each scope has its own baseline, and forgetting the page shows it in full again.
  expect(views.show(key, "form", "URL: u", "x", {})).toBe("URL: u\n\nx");
  views.forget(key);
  expect(views.show(key, "page", "URL: u", page, {})).toBe(`URL: u\n\n${page}`);
});
