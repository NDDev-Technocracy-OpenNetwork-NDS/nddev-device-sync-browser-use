// Console messages and page errors of every page the session sees, kept from the moment the
// executor first sees the page, so an agent reads what happened before it looked.
import type { BrowserContext, Page } from "playwright-core";
import { matches, type Search } from "./text";

const LIMIT = 5000;

type Log = { entries: string[]; read: number };
const logs = new WeakMap<Page, Log>();
// Errors and new tabs of the pages an agent keeps in `state`, printed with its next result.
let notices: string[] = [];

/** Starts recording a page; `watched` names the pages whose errors and popups are reported. */
export function attach(page: Page, context: BrowserContext, watched: () => Set<Page>): void {
  if (logs.has(page)) return;
  const log: Log = { entries: [], read: 0 };
  logs.set(page, log);
  const push = (entry: string) => {
    log.entries.push(entry);
    if (log.entries.length > LIMIT) {
      log.entries.shift();
      log.read = Math.max(0, log.read - 1);
    }
  };
  page.on("console", (message) => {
    const { url, lineNumber } = message.location();
    push(`[${message.type()}] ${message.text()}${url ? ` (${url}:${lineNumber})` : ""}`);
  });
  page.on("pageerror", (error) => {
    push(`[pageerror] ${error.stack ?? error.message}`);
    if (watched().has(page)) notices.push(`[PAGE ERROR] ${page.url()}: ${error.message}`);
  });
  page.on("popup", (popup) => {
    if (!watched().has(page)) return;
    const index = context.pages().indexOf(popup);
    notices.push(
      `[WARNING] New page opened from ${page.url()} (index ${index}, initial url: ${popup.url()}); it is context.pages()[${index}]`,
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

export function getLatestLogs({ page, count, search, sinceLastCall }: LogOptions): string {
  const log = logs.get(page);
  if (!log) return "No logs for this page";
  let lines = sinceLastCall ? log.entries.slice(log.read) : log.entries;
  if (sinceLastCall) log.read = log.entries.length;
  if (search !== undefined) lines = lines.filter(matches(search));
  if (count !== undefined) lines = lines.slice(-count);
  if (lines.length > 0) return lines.join("\n");
  return sinceLastCall ? "No new logs since last call" : "No logs";
}

/** The notices collected since the last execution, which its output carries. */
export function notified(): string[] {
  const current = notices;
  notices = [];
  return current;
}
