// Per-session Playwright executor for ADR 0015. The Rust host spawns it with a
// session-scoped CDP endpoint on its private socket and talks JSON lines over
// stdio. The vm context only keeps per-session state; it is not a sandbox.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { chromium, type Page } from "playwright-core";
import {
  actions,
  executing as journalExecuting,
  execution as journalExecution,
  start as startJournal,
  attach as watchActivity,
} from "./agent/activity";
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
import { attach as watchDownloads } from "./agent/downloads";
import { bounded, compose, describeError, errorParts, waitBudget } from "./agent/format";
import { connect as connectHost } from "./agent/host";
import { inspect as describe } from "./agent/inspect";
import { waitForPageLoad, attach as watchLoad } from "./agent/load";
import { getLocatorStringForElement, inspectPinnedElement, pinnedElements } from "./agent/locators";
import { clearAllLogs, getLatestLogs, notified, attach as watchLogs } from "./agent/logs";
import { recorderFor } from "./agent/recorder";
import { createDemoVideo, executing, ghostCursor, recording } from "./agent/recording";
import { resizeImageForAgent, screenshotWithAccessibilityLabels } from "./agent/screens";
import { ref, refToLocator, snapshot, attach as watchSnapshots } from "./agent/snapshot";
import { bindEmitter, bindPage, definer, type Execution, scope, withdraw } from "./execution";

const LOG_LIMIT = 200;

type Request = { id: number; code: string; timeout_ms?: number };
// The host asks the executor to abort the script of one request once it passed its deadline.
type Abort = { abort: number };
type Failure = "script_error" | "target_closed" | "browser_disconnected" | "invalid_request";
const [endpoint, artifacts] = process.argv.slice(2);
if (!endpoint || !artifacts) process.exit(2);

const write = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
const context = browser.contexts()[0] ?? process.exit(3);
browser.on("disconnected", () => process.exit(4));
// The owner's observation profile is known before the first execution; the activity journal
// records what the profile allows (docs/observability.md).
await connectHost(browser);
startJournal(context);

// Callbacks agent code hands to Playwright stay in its execution (./execution): the event emitter
// every client object shares and the context now, each page's class once a page is seen.
const emitter = definer(browser, "prependOnceListener");
if (!emitter) process.exit(3);
bindEmitter(emitter);
bindPage(Object.getPrototypeOf(context));

// Playwright calls of an aborted script, and of the callbacks it registered, throw before they
// reach the browser (ADR 0015).
(
  browser as unknown as { _instrumentation: { addListener(listener: object): void } }
)._instrumentation.addListener({
  onApiCallBegin: () => {
    if (scope.getStore()?.signal.aborted)
      throw new Error("This execution timed out and was aborted");
  },
});
(
  browser as unknown as { _instrumentation: { addListener(listener: object): void } }
)._instrumentation.addListener(actions);

const recorder =
  (method: string) =>
  (...values: unknown[]): void => {
    const execution = scope.getStore();
    if (!execution || execution.signal.aborted || execution.logs.length >= LOG_LIMIT) return;
    execution.logs.push({ method, values });
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
  bindPage(Object.getPrototypeOf(page));
  watchLogs(page, context, keys);
  watchLoad(page);
  watchSnapshots(page);
  watchDownloads(page);
  watchActivity(page);
}
for (const page of context.pages()) observe(page);
context.on("page", observe);

// The executor's own process with what would stop it or move it refused, its working directory
// being the session's artifacts. `require("node:process")` still gives the real one.
const refused = (name: string) => () => {
  throw new Error(`process.${name} is not available to agent code; the session owns its process`);
};
const agentProcess = new Proxy(process, {
  get(target, key, receiver) {
    if (key === "exit" || key === "abort" || key === "chdir" || key === "reallyExit") {
      return refused(String(key));
    }
    if (key === "cwd") return () => artifacts;
    return Reflect.get(target, key, receiver);
  },
});

// An interval of an aborted execution stops with it; a timeout fires once and can no longer act.
const agentSetInterval = (
  handler: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) => {
  const handle = setInterval(handler, ms, ...args);
  scope.getStore()?.withdraw.push(() => clearInterval(handle));
  return handle;
};

const sandbox = vm.createContext({
  browser,
  context,
  state,
  artifacts,
  console: captured,
  process: agentProcess,
  snapshot,
  // An earlier name of `snapshot`, kept for scripts written with it.
  accessibilitySnapshot: snapshot,
  ref,
  refToLocator,
  getLatestLogs,
  clearAllLogs,
  waitForPageLoad,
  inspect: describe,
  getCleanHTML,
  getPageMarkdown,
  getLocatorStringForElement,
  pinnedElements,
  inspectPinnedElement: (pageUrl: string, expression: string) =>
    inspectPinnedElement(pageUrl, expression, context.pages(), state, getReactComponentInfo),
  require: createRequire(join(artifacts, "agent.js")),
  // `import()` by another name; relative specifiers resolve in the artifacts, as with `import()`.
  importModule: (specifier: string) =>
    import(
      specifier.startsWith(".") || specifier.startsWith("/")
        ? pathToFileURL(resolve(artifacts, specifier)).href
        : specifier
    ),
  screenshotWithAccessibilityLabels: (
    options: Parameters<typeof screenshotWithAccessibilityLabels>[0],
  ) => screenshotWithAccessibilityLabels(options, artifacts),
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
  AbortSignal,
  Buffer,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  setInterval: agentSetInterval,
  clearInterval,
  structuredClone,
});
// No default page: a bare `page` says how to get one. It is defined inside the context, because a
// host-side getter's error would only read as "page is not defined".
vm.runInContext(
  `Object.defineProperty(globalThis, "page", { get() { throw new ReferenceError(${JSON.stringify(
    'There is no global `page`. Open one with `state.page = await context.newPage()`, or reuse one with `state.page = context.pages().findLast((page) => page.url().includes("example.com"))`, and keep it in `state.page` across executions.',
  )}); }, configurable: true })`,
  sandbox,
);
// `signal` is the calling script's own: aborted once its execution timed out.
Object.defineProperty(sandbox, "signal", {
  get: () => scope.getStore()?.signal,
  enumerable: true,
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
  const message = errorParts(error)?.message ?? "";
  return /Target page, context or browser has been closed|Target closed/.test(message)
    ? "target_closed"
    : "script_error";
}

// The running execution; the host sends the next one only after this one answered.
let running: { id: number; abort: () => void } | undefined;

async function run(request: Request): Promise<void> {
  const controller = new AbortController();
  const execution: Execution = { signal: controller.signal, logs: [], withdraw: [] };
  const budget = request.timeout_ms ?? 10_000;
  let answered = false;
  const started = Date.now();
  journalExecuting(request.id);
  // Exactly one answer per request: the script's own, or the abort's, whichever comes first.
  const answer = (message: {
    id: number;
    ok: boolean;
    error?: string;
    output?: string;
    truncated?: boolean;
  }): void => {
    if (answered) return;
    answered = true;
    void journalExecution({
      id: request.id,
      code: request.code,
      ok: message.ok,
      ...(message.error ? { error: message.error } : {}),
      ms: Date.now() - started,
      output: message.output ?? "",
    });
    if (running?.id === request.id) running = undefined;
    executing(false);
    write(message);
  };
  running = {
    id: request.id,
    abort: () => {
      controller.abort();
      withdraw(execution);
      const error =
        "Code execution reached its deadline and was aborted: its later Playwright calls throw, its listeners, routes and locator handlers are removed, and `signal` is aborted. An action already in progress may still complete, so check the page before retrying. The session keeps its state.";
      const text = compose({ notices: notified(), console: execution.logs, error });
      answer({ id: request.id, ok: false, error: "aborted", ...bounded(text) });
    },
  };
  executing(true);
  const wait = waitBudget(budget);
  context.setDefaultTimeout(wait);
  context.setDefaultNavigationTimeout(wait);
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
  try {
    const value = await scope.run(execution, () => compile(request.code).runInContext(sandbox));
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // An aborted script that ends later was answered already: it neither formats nor takes the
  // notices that belong to the result of the script running now.
  if (answered) return;
  if (outcome.ok) {
    const text = compose({ notices: notified(), console: execution.logs, value: outcome.value });
    answer({ id: request.id, ok: true, ...bounded(text) });
    return;
  }
  const text = compose({
    notices: notified(),
    console: execution.logs,
    error: describeError(outcome.error),
  });
  answer({ id: request.id, ok: false, error: classify(outcome.error), ...bounded(text) });
}

write({ ready: true });
// Reading never waits for a script, so an abort reaches the one that is running.
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message: Request | Abort;
  try {
    message = JSON.parse(line) as Request | Abort;
  } catch {
    write({ id: 0, ok: false, error: "invalid_request", output: "", truncated: false });
    continue;
  }
  if ("abort" in message) {
    if (running?.id === message.abort) running.abort();
    continue;
  }
  void run(message);
}
process.exit(0);
