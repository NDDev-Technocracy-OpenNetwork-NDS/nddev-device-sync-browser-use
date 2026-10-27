// Load detection that waits for a page's own requests, not for analytics, ads, long polls or
// media streams, which may never finish.
import type { Page, Request } from "playwright-core";

const IGNORED =
  /google-analytics|googletagmanager|doubleclick|googlesyndication|google\.com\/(ads|pagead)|facebook\.(net|com)\/(tr|signals)|connect\.facebook|hotjar|segment\.(io|com)|mixpanel|sentry|clarity\.ms|mc\.yandex|bat\.bing|amplitude|intercom|fullstory|newrelic|nr-data|datadoghq|optimizely|analytics\.tiktok|sc-static|ct\.pinterest|px\.ads\.linkedin/i;
const STREAMING = new Set(["websocket", "eventsource", "media", "texttrack", "manifest"]);
// A request open this long is a long poll or a stream, not part of the page loading.
const LONG_LIVED_MS = 5000;

const inflight = new WeakMap<Page, Map<Request, number>>();

export function attach(page: Page): void {
  if (inflight.has(page)) return;
  const open = new Map<Request, number>();
  inflight.set(page, open);
  page.on("request", (request) => {
    if (!IGNORED.test(request.url()) && !STREAMING.has(request.resourceType())) {
      open.set(request, Date.now());
    }
  });
  page.on("requestfinished", (request) => open.delete(request));
  page.on("requestfailed", (request) => open.delete(request));
}

export type LoadOptions = {
  page: Page;
  timeout?: number | undefined;
  pollInterval?: number | undefined;
  /** The page counts as loaded no earlier than this. */
  minWait?: number | undefined;
};

export type Load = {
  success: boolean;
  readyState: string;
  pendingRequests: number;
  waitTimeMs: number;
  timedOut: boolean;
};

export async function waitForPageLoad({
  page,
  timeout = 10_000,
  pollInterval = 100,
  minWait = 500,
}: LoadOptions): Promise<Load> {
  const started = Date.now();
  for (;;) {
    const waitTimeMs = Date.now() - started;
    const readyState = await page.evaluate(() => document.readyState).catch(() => "unknown");
    const now = Date.now();
    let pendingRequests = 0;
    for (const opened of inflight.get(page)?.values() ?? []) {
      if (now - opened < LONG_LIVED_MS) pendingRequests++;
    }
    const loaded = readyState === "complete" && pendingRequests === 0;
    if (loaded && waitTimeMs >= minWait) {
      return { success: true, readyState, pendingRequests, waitTimeMs, timedOut: false };
    }
    if (waitTimeMs >= timeout) {
      return { success: false, readyState, pendingRequests, waitTimeMs, timedOut: true };
    }
    await new Promise((done) => setTimeout(done, pollInterval));
  }
}
