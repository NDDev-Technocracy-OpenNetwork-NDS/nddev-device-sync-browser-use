// What the executor sees for the activity journal (docs/observability.md): executions, the agent's
// Playwright actions, and each page's navigations, requests, console messages, errors and
// downloads. It collects only in the full observation profile and hands raw records to the host,
// whose Rust policy removes secrets, leaves noise out, folds repeats and writes the journal. No
// Playwright listener here changes a page's behavior: dialogs, which a listener would keep open,
// are journaled by the host from the browser's own events.
import type { BrowserContext, ConsoleMessage, Page, Request } from "playwright-core";
import { hostCommand, observation, onObservation } from "./host";

const BATCH = 32;
// The host takes a command of at most 1 MiB, the native messaging bound; a larger one ends the
// executor's connection. A batch of records with their envelope stays below it.
const BATCH_BYTES = 900 * 1024;
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
let queued = 0;
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
  let full: Raw = {
    at: new Date().toISOString(),
    ...(exec === undefined ? {} : { exec }),
    ...record,
  };
  let size = Buffer.byteLength(JSON.stringify(full));
  // A body that JSON escaping grows past a batch on its own is left out, as a large one is.
  if (size > BATCH_BYTES && "body" in full) {
    const { body: _, ...rest } = full;
    full = { ...rest, bodyOmitted: "too-large" };
    size = Buffer.byteLength(JSON.stringify(full));
  }
  if (size > BATCH_BYTES) return;
  if (queued + size > BATCH_BYTES) void send(false);
  queue.push(full);
  queued += size;
  if (queue.length >= BATCH) void send(false);
  else timer ??= setTimeout(() => void send(false), SEND_MS);
}

async function send(flush: boolean): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const records = queue;
  queue = [];
  queued = 0;
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

type Zone = { owner?: object };
type Wrap = (
  this: object,
  func: (zone: Zone) => Promise<unknown>,
  options?: object,
) => Promise<unknown>;

// Playwright's instrumentation names no page for an action. The object whose outermost call
// starts it does, a frame or a page, so each call's zone keeps that object; the journal then
// knows which page, and so which site, an action is of. Without this, the journal treats an
// action as of any private site open.
function namePages(context: BrowserContext): void {
  const owner = Object.getPrototypeOf(Object.getPrototypeOf(context)) as {
    _wrapApiCall?: Wrap & { named?: true };
  };
  const wrap = owner._wrapApiCall;
  if (typeof wrap !== "function" || wrap.named) return;
  const named: Wrap & { named?: true } = function (this: object, func, options) {
    return wrap.call(
      this,
      (zone) => {
        zone.owner ??= this;
        return func(zone);
      },
      options,
    );
  };
  named.named = true;
  owner._wrapApiCall = named;
}

function pageOf(owner: object | undefined): Page | undefined {
  const target = owner as { page?: () => Page; mainFrame?: () => unknown } | undefined;
  if (typeof target?.page === "function") return target.page();
  if (typeof target?.mainFrame === "function") return target as unknown as Page;
  return undefined;
}

/** Starts collecting; the host keeps the journal of this executor's session. */
export function start(context: BrowserContext): void {
  started = true;
  namePages(context);
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
    const page = pageOf((zone as Zone).owner);
    const record: Raw = {
      type: "action",
      ...(page && pages.has(page) ? { page: pageId(page) } : {}),
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
