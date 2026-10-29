// What the executor sees for the activity journal (docs/observability.md): executions, the agent's
// Playwright actions, and each page's navigations, requests, console messages, errors and
// downloads. It collects only in the full observation profile and hands raw records to the host,
// whose Rust policy removes secrets, leaves noise out, folds repeats and writes the journal. No
// Playwright listener here changes a page's behavior: dialogs, which a listener would keep open,
// are journaled by the host from the browser's own events.
import type { BrowserContext, ConsoleMessage, Page, Request } from "playwright-core";
import { hostCommand, observation, onObservation } from "./host";

const BATCH = 32;
const SEND_MS = 250;
// Bodies the host may keep: textual and at most this large.
const BODY_BYTES = 256 * 1024;
const TEXTUAL = /json|text|xml|x-www-form-urlencoded|graphql|javascript/i;
// Agent actions worth a record; helpers' own evaluations and waits are not actions.
const ACTIONS = new Set([
  "check",
  "click",
  "close",
  "dblclick",
  "dispatchEvent",
  "dragAndDrop",
  "fill",
  "goBack",
  "goForward",
  "goto",
  "hover",
  "keyboardInsertText",
  "keyboardPress",
  "keyboardType",
  "mouseClick",
  "press",
  "reload",
  "selectOption",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
]);

type Raw = { [field: string]: unknown };

let started = false;
let exec: number | undefined;
let queue: Raw[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
const pages = new WeakMap<Page, number>();
let nextPage = 0;
const calls = new WeakMap<object, { at: number; record: Raw }>();

function collecting(): boolean {
  return started && observation() === "full";
}

/** Queues one raw record for the host, when the profile collects. */
export function emit(record: Raw): void {
  if (!collecting()) return;
  queue.push({ at: new Date().toISOString(), ...(exec === undefined ? {} : { exec }), ...record });
  if (queue.length >= BATCH) void send(false);
  else timer ??= setTimeout(() => void send(false), SEND_MS);
}

async function send(flush: boolean): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const records = queue;
  queue = [];
  if (records.length > 0 || flush) await hostCommand("NDS.activity", { records, flush });
}

/** Sends everything queued at once and asks the host to write what it holds back. */
export function flush(): Promise<void> {
  return collecting() ? send(true) : Promise.resolve();
}

/** The journal's number of a page, 0 for one it never saw. */
export function pageId(page: Page): number {
  return pages.get(page) ?? 0;
}

/** Starts collecting; the host keeps the journal of this executor's session. */
export function start(context: BrowserContext): void {
  started = true;
  // Off and standard collect nothing: records not yet sent are dropped.
  onObservation((profile) => {
    if (profile !== "full") queue = [];
  });
  context.on("close", () => void send(true));
}

/** The execution the following records belong to, until the next one starts. */
export function executing(id: number): void {
  exec = id;
}

/** One execution's end, sent at once with everything before it. */
export async function execution(record: Raw): Promise<void> {
  emit({ type: "execution", ...record });
  if (collecting()) await send(true);
}

/** Playwright's instrumentation listener: the agent's actions with their raw values. */
export const actions = {
  onApiCallBegin(zone: object, channel: { type: string; method: string; params?: Raw }): void {
    if (!collecting() || !ACTIONS.has(channel.method)) return;
    const params = channel.params ?? {};
    const value = ["value", "text"]
      .map((name) => params[name])
      .find((each) => typeof each === "string");
    const record: Raw = {
      type: "action",
      api: (zone as { apiName?: string }).apiName ?? channel.method,
      ...(typeof params.selector === "string" ? { locator: params.selector } : {}),
      ...(typeof params.url === "string" ? { url: params.url } : {}),
      ...(typeof params.key === "string" ? { key: params.key } : {}),
      ...(typeof value === "string" ? { value } : {}),
      ...(Array.isArray(params.localPaths) ? { files: params.localPaths } : {}),
    };
    calls.set(zone, { at: Date.now(), record });
  },
  onApiCallEnd(zone: object): void {
    const call = calls.get(zone);
    if (!call) return;
    calls.delete(zone);
    const error = (zone as { error?: Error }).error;
    emit({ ...call.record, ms: Date.now() - call.at, ...(error ? { error: error.message } : {}) });
  },
};

async function network(page: Page, id: number, request: Request, failure?: string): Promise<void> {
  if (!collecting()) return;
  const response = failure ? null : await request.response().catch(() => null);
  const type = response?.headers()["content-type"] ?? "";
  const record: Raw = {
    type: "network",
    page: id,
    pageUrl: page.url(),
    method: request.method(),
    url: request.url(),
    resource: request.resourceType(),
    status: response?.status() ?? 0,
    ...(failure ? { failure } : {}),
    ...(type ? { contentType: type } : {}),
    headers: request.headers(),
  };
  const post = request.postData();
  if (post !== null) {
    record.postData = post;
    record.requestType = request.headers()["content-type"] ?? "";
  }
  if (response && TEXTUAL.test(type) && request.resourceType() !== "document") {
    if (Number(response.headers()["content-length"] ?? 0) > BODY_BYTES) {
      record.bodyOmitted = "too-large";
    } else {
      const body = await response.text().catch(() => undefined);
      if (body !== undefined && body.length <= BODY_BYTES) record.body = body;
      else if (body !== undefined) record.bodyOmitted = "too-large";
    }
  }
  emit(record);
}

/** Collects one page's navigations, requests, console, errors, downloads and closing. */
export function attach(page: Page): void {
  if (pages.has(page) || !started) return;
  const id = ++nextPage;
  pages.set(page, id);
  emit({ type: "page", page: id, event: "opened", url: page.url() });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) emit({ type: "navigation", page: id, url: frame.url() });
  });
  page.on("close", () => emit({ type: "page", page: id, event: "closed" }));
  page.on("console", (message: ConsoleMessage) =>
    emit({ type: "console", page: id, level: message.type(), text: message.text() }),
  );
  page.on("pageerror", (error) =>
    emit({ type: "page-error", page: id, message: String(error.message ?? error) }),
  );
  page.on("download", (download) =>
    emit({ type: "download", page: id, url: download.url(), name: download.suggestedFilename() }),
  );
  page.on("requestfinished", (request) => void network(page, id, request));
  page.on(
    "requestfailed",
    (request) => void network(page, id, request, request.failure()?.errorText ?? "failed"),
  );
}
