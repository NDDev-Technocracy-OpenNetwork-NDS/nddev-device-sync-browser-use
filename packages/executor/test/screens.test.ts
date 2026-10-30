import { expect, test } from "bun:test";
import { labels } from "../agent/screens";

const view = [
  '- heading "Title" [level=1] [ref=e2] [box=10,10,200,30]',
  '- link "Home" [ref=e3] [box=10,50,40,16]',
  '- button "Far away" [ref=e4] [box=10,5000,40,16]',
  '- img "Logo" [ref=e5] [box=300,10,64,64]',
].join("\n");

test("labels mark interactive elements by default and every element on request", () => {
  expect(labels(view, 800, 600).map((label) => label.ref)).toEqual(["e3"]);
  const all = labels(view, 800, 600, false);
  expect(all.map((label) => label.ref)).toEqual(["e2", "e3", "e5"]);
  expect(all.find((label) => label.ref === "e2")?.color).toBe("#d9d9d9");
  // Each label is listed by role, name and ref, without its box.
  expect(all.map((label) => label.line)).toEqual([
    '- heading "Title" [ref=e2]',
    '- link "Home" [ref=e3]',
    '- img "Logo" [ref=e5]',
  ]);
});
