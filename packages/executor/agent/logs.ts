// Console messages and page errors of every page the session sees, kept from the moment the
// executor first sees the page, so an agent reads what happened before it looked.
import type { BrowserContext, Page } from "playwright-core";
import { consoleText, shortSource, shortUrl } from "./format";
import { matches, type Search } from "./text";

const LIMIT = 5000;

type Log = { entries: string[]; read: number };
const logs = new WeakMap<Page, Log>();
// Every page's log, so all of them can be cleared at once; a closed page's goes with it.
const all = new Set<Log>();
// Errors and new tabs of the pages an agent keeps in `state`, printed with its next result.
let notices: string[] = [];

/** Starts recording a page; `keys` names the `state` keys that hold a page, whose errors, popups
 * and closing an agent's results report. */
export function attach(page: Page, context: BrowserContext, keys: (page: Page) => string[]): void {
  if (logs.has(page)) return;
  const log: Log = { entries: [], read: 0 };
  logs.set(page, log);
  all.add(log);
  page.on("close", () => all.delete(log));
  const push = (entry: string) => {
    log.entries.push(entry);
    if (log.entries.length > LIMIT) {
      log.entries.shift();
      log.read = Math.max(0, log.read - 1);
    }
  };
  page.on("console", (message) => {
    const type = message.type();
    const previews = message.args().map(String);
    const text = previews.length > 0 ? consoleText(previews) : consoleText([message.text()]);
    // Only errors and warnings say where they came from; that is where an agent looks next. A
    // location in another extension is its console wrapper (React DevTools wraps every call), not
    // the page's code, so it is left out.
    const { url, lineNumber } = message.location();
    const source =
      (type === "error" || type === "warning") && /^(https?|file):/.test(url)
        ? ` (${shortSource(url, lineNumber)})`
        : "";
    push(`[${type}] ${text}${source}`);
  });
  page.on("pageerror", (error) => {
    push(`[pageerror] ${consoleText([error.message])}`);
    if (keys(page).length > 0)
      notices.push(`[PAGE ERROR] ${shortUrl(page.url())}: ${error.message}`);
  });
  page.on("popup", (popup) => {
    if (keys(page).length === 0) return;
    const index = context.pages().indexOf(popup);
    notices.push(
      `[WARNING] New page opened from ${shortUrl(page.url())} (index ${index}, initial url: ${shortUrl(popup.url())}); it is context.pages()[${index}]`,
    );
  });
  page.on("close", () => {
    const held = keys(page);
    if (held.length === 0) return;
    const names = held.map((key) => `state.${key}`).join(", ");
    notices.push(
      `[WARNING] Page closed (url: ${shortUrl(page.url())}) for ${names}. Assign an open page to ${names.split(", ")[0]} before using it again, for example with await context.newPage().`,
    );
  });
}

export type LogOptions = {
  page: Page;
  /** Only the last this many lines. */
  count?: number | undefined;
  search?: Search | undefined;
  /** Only lines since the previous call with this flag; the first call returns everything. */
  sinceLastCall?: boolean | undefined;
};

/** Lines of context kept around each search match. */
const CONTEXT = 5;

/**
 * The page's log lines: an array, empty when there is nothing, so
 * `logs.length` and `logs.filter()` mean what they say. A search keeps five lines around each
 * match and marks a gap with `---`.
 */
export function getLatestLogs({ page, count, search, sinceLastCall }: LogOptions): string[] {
  const log = logs.get(page);
  if (!log) return [];
  let lines = sinceLastCall ? log.entries.slice(log.read) : [...log.entries];
  if (sinceLastCall) log.read = log.entries.length;
  if (search !== undefined) {
    const match = matches(search);
    const kept = new Set<number>();
    lines.forEach((line, index) => {
      if (!match(line)) return;
      for (let near = Math.max(0, index - CONTEXT); near <= index + CONTEXT; near++) kept.add(near);
    });
    const found: string[] = [];
    let previous = -1;
    for (const index of [...kept].filter((index) => index < lines.length).sort((a, b) => a - b)) {
      if (previous >= 0 && index !== previous + 1) found.push("---");
      found.push(lines[index] ?? "");
      previous = index;
    }
    lines = found;
  }
  return count !== undefined ? lines.slice(-count) : lines;
}

/** Forgets the logs of every page the session sees, so later reads start empty. */
export function clearAllLogs(): void {
  for (const log of all) {
    log.entries = [];
    log.read = 0;
  }
}

/** The notices collected since the last execution, which its output carries. */
export function notified(): string[] {
  const current = notices;
  notices = [];
  return current;
}
