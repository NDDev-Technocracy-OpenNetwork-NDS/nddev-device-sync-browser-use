import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { attach, clearAllLogs, getLatestLogs, notified } from "../agent/logs";

// A page that emits console messages the way Playwright reports them.
function fakePage(held: string[] = []): {
  page: Page;
  log: (type: string, text: string, url?: string) => void;
  events: EventEmitter;
} {
  const events = new EventEmitter();
  const page = Object.assign(events, {
    url: () => "https://example.com/",
    close: async () => {
      events.emit("close");
    },
  }) as unknown as Page;
  attach(page, { pages: () => [page] } as unknown as BrowserContext, () => held);
  const log = (type: string, text: string, url = "") =>
    events.emit("console", {
      type: () => type,
      text: () => text,
      args: () => [],
      location: () => ({ url, lineNumber: 7, columnNumber: 0 }),
    });
  return { page, log, events };
}

test("logs are an array, empty when there is nothing new", () => {
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

test("a page the agent closes itself is no news; one closed by someone else is", async () => {
  notified();
  const own = fakePage(["page"]);
  await own.page.close();
  expect(notified()).toEqual([]);
  const other = fakePage(["page"]);
  other.events.emit("close");
  expect(notified()).toEqual([
    "[WARNING] Page closed (url: https://example.com/) for state.page. Assign an open page to state.page before using it again, for example with await context.newPage().",
  ]);
});
