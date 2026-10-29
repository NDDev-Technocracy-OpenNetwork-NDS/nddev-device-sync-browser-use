import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { attach, clearAllLogs, getLatestLogs } from "../agent/logs";

// A page that emits console messages the way Playwright reports them.
function fakePage(): { page: Page; log: (type: string, text: string, url?: string) => void } {
  const events = new EventEmitter();
  const page = Object.assign(events, { url: () => "https://example.com/" }) as unknown as Page;
  attach(page, { pages: () => [page] } as unknown as BrowserContext, () => []);
  const log = (type: string, text: string, url = "") =>
    events.emit("console", {
      type: () => type,
      text: () => text,
      args: () => [],
      location: () => ({ url, lineNumber: 7, columnNumber: 0 }),
    });
  return { page, log };
}

test("logs are an array, as in Playwriter, and empty when there is nothing new", () => {
  const { page, log } = fakePage();
  expect(getLatestLogs({ page, sinceLastCall: true })).toEqual([]);
  log("log", "first");
  log("error", "broke", "https://example.com/app.js");
  log(
    "error",
    "wrapped",
    "chrome-extension://fmkadmapgofadopljbjfkapdkoienihi/build/installHook.js",
  );
  expect(getLatestLogs({ page, sinceLastCall: true })).toEqual([
    "[log] first",
    "[error] broke (example.com/…/app.js:7)",
    "[error] wrapped",
  ]);
  expect(getLatestLogs({ page, sinceLastCall: true })).toEqual([]);
  expect(getLatestLogs({ page, count: 1 })).toEqual(["[error] wrapped"]);
  clearAllLogs();
  expect(getLatestLogs({ page })).toEqual([]);
});

test("a log search keeps five lines around each match and marks gaps", () => {
  const { page, log } = fakePage();
  for (let index = 0; index < 20; index++)
    log("log", index === 2 || index === 17 ? `hit ${index}` : `line ${index}`);
  const found = getLatestLogs({ page, search: /hit/ });
  expect(found.slice(0, 2)).toEqual(["[log] line 0", "[log] line 1"]);
  expect(found).toContain("---");
  expect(found.indexOf("---")).toBe(8);
  expect(found.at(-1)).toBe("[log] line 19");
  expect(getLatestLogs({ page, search: "nothing" })).toEqual([]);
});
