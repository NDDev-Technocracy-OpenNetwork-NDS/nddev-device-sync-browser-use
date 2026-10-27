// Per-session Playwright executor for ADR 0015. The Rust host spawns it with a
// session-scoped CDP endpoint on its private socket and talks JSON lines over
// stdio. The vm context only keeps per-session state; it is not a sandbox.
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { chromium, type Page } from "playwright-core";
import { checks, owner } from "./agent/checks";
import { getCleanHTML, getPageMarkdown } from "./agent/content";
import {
  createDebugger,
  createEditor,
  formatStylesAsText,
  getCDPSession,
  getReactComponentInfo,
  getReactSource,
  getStylesForLocator,
} from "./agent/devtools";
import { bounded, type Console, compose, describeError } from "./agent/format";
import { inspect as describe } from "./agent/inspect";
import { waitForPageLoad, attach as watchLoad } from "./agent/load";
import { getLocatorStringForElement, pinnedElements } from "./agent/locators";
import { getLatestLogs, notified, attach as watchLogs } from "./agent/logs";
import { recorderFor } from "./agent/recorder";
import { createDemoVideo, executing, ghostCursor, recording } from "./agent/recording";
import { resizeImageForAgent, screenshotWithAccessibilityLabels } from "./agent/screens";
import { ref, refToLocator, snapshot, attach as watchSnapshots } from "./agent/snapshot";

const LOG_LIMIT = 200;
// Playwright's waits end this long before an execution's deadline.
const WAIT_MARGIN_MS = 1_000;

type Request = { id: number; code: string; timeout_ms?: number };
type Failure = "script_error" | "target_closed" | "browser_disconnected" | "invalid_request";
const [endpoint, artifacts] = process.argv.slice(2);
if (!endpoint || !artifacts) process.exit(2);

const write = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
const context = browser.contexts()[0] ?? process.exit(3);
browser.on("disconnected", () => process.exit(4));

let logs: Console[] = [];
const recorder =
  (method: string) =>
  (...values: unknown[]): void => {
    if (logs.length < LOG_LIMIT) logs.push({ method, values });
  };
const captured = Object.fromEntries(
  ["log", "info", "warn", "error", "debug"].map((method) => [method, recorder(method)]),
);

const state: Record<string, unknown> = {};

// The `state` keys that hold a page; results report the errors, new tabs and closing of such pages.
function keys(page: Page): string[] {
  return Object.entries(state)
    .filter(([, value]) => value === page)
    .map(([key]) => key);
}

// Every page the session sees is recorded from the moment the executor sees it.
function observe(page: Page): void {
  watchLogs(page, context, keys);
  watchLoad(page);
  watchSnapshots(page);
}
for (const page of context.pages()) observe(page);
context.on("page", observe);

const sandbox = vm.createContext({
  browser,
  context,
  state,
  artifacts,
  console: captured,
  snapshot,
  ref,
  refToLocator,
  getLatestLogs,
  waitForPageLoad,
  inspect: describe,
  getCleanHTML,
  getPageMarkdown,
  getLocatorStringForElement,
  pinnedElements,
  require: createRequire(join(artifacts, "agent.js")),
  screenshotWithAccessibilityLabels: (options: { page: Page }) =>
    screenshotWithAccessibilityLabels(options, artifacts),
  resizeImageForAgent,
  resizeImage: resizeImageForAgent,
  recording,
  ghostCursor,
  createDemoVideo,
  getCDPSession,
  createDebugger,
  createEditor,
  getStylesForLocator,
  formatStylesAsText,
  getReactComponentInfo,
  getReactSource,
  recorder: recorderFor(context, artifacts),
  checks,
  notifyOwner: (page: Page, reason: string) => owner(page, "NDS.notifyOwner", { reason }),
  clearOwner: (page: Page) => owner(page, "NDS.clearOwner", {}),
  fetch,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  AbortController,
  setTimeout,
  clearTimeout,
  structuredClone,
});

// A single expression returns its value; statements need an explicit return.
// `import()` in agent code loads modules as the executor does; relative paths resolve in the
// session's artifacts, the executor's working directory.
const modules = {
  filename: join(artifacts, "agent.js"),
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
};

function compile(code: string): vm.Script {
  try {
    return new vm.Script(`(async () => (\n${code.trim().replace(/;+$/, "")}\n))()`, modules);
  } catch {
    return new vm.Script(`(async () => {\n${code}\n})()`, modules);
  }
}

function classify(error: unknown): Failure {
  if (!browser.isConnected()) return "browser_disconnected";
  const message = error instanceof Error ? error.message : "";
  return /Target page, context or browser has been closed|Target closed/.test(message)
    ? "target_closed"
    : "script_error";
}

async function run(request: Request): Promise<void> {
  logs = [];
  executing(true);
  const wait = Math.max(1_000, (request.timeout_ms ?? 10_000) - WAIT_MARGIN_MS);
  context.setDefaultTimeout(wait);
  context.setDefaultNavigationTimeout(wait);
  try {
    const value = await compile(request.code).runInContext(sandbox);
    const text = compose({ notices: notified(), console: logs, value });
    write({ id: request.id, ok: true, ...bounded(text) });
  } catch (error) {
    const text = compose({ notices: notified(), console: logs, error: describeError(error) });
    write({ id: request.id, ok: false, error: classify(error), ...bounded(text) });
  } finally {
    executing(false);
  }
}

write({ ready: true });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    write({ id: 0, ok: false, error: "invalid_request", output: "", truncated: false });
    continue;
  }
  await run(request);
}
process.exit(0);
