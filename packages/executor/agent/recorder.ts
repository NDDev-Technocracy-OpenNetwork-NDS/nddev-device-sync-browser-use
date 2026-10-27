// Records what a person does in agent tabs, so an agent can turn a workflow into a skill: actions
// with locators, navigations, failed and API requests, errors, dialogs and toasts, and a frame of
// each visual change. Secrets typed into password and payment fields are redacted, and request
// and response bodies are never recorded.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

const FRAME_INTERVAL_MS = 500;
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_MS = 20 * 60 * 1000;

type Event = { id: number; at: number; page: number; type: string; [field: string]: unknown };

type Recording = {
  id: string;
  dir: string;
  started: number;
  events: Event[];
  frames: { at: number; path: string }[];
  bytes: number;
  sessions: CDPSession[];
  // Writes each page's last frame that the rate limit held back, when the recording stops.
  flushes: (() => Promise<void>)[];
  pages: Map<Page, number>;
  timer: ReturnType<typeof setTimeout>;
  stopped?: string | undefined;
};

let current: Recording | undefined;
const finished = new Map<string, Recording>();
const bound = new WeakSet<Page>();

// Runs in the page: reports actions, live-region text and form submissions to the executor.
function listen(): void {
  const page = window as unknown as { __ndsRecord?: (json: string) => void; __ndsRecorder?: true };
  if (page.__ndsRecorder) return;
  page.__ndsRecorder = true;
  const send = (event: object) => {
    try {
      page.__ndsRecord?.(JSON.stringify(event));
    } catch {}
  };
  const quote = (text: string) => JSON.stringify(text);
  const roles: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    SUMMARY: "button",
  };
  const inputs: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    submit: "button",
    button: "button",
    reset: "button",
    range: "slider",
  };
  const locate = (target: EventTarget | null): string => {
    if (!(target instanceof Element)) return "";
    const testId = target.getAttribute("data-testid");
    if (testId) return `getByTestId(${quote(testId)})`;
    const role =
      target.getAttribute("role") ||
      roles[target.tagName] ||
      (target instanceof HTMLInputElement ? (inputs[target.type] ?? "textbox") : "");
    const labelled = target as HTMLInputElement;
    const name = (
      target.getAttribute("aria-label") ||
      labelled.labels?.[0]?.innerText ||
      (target instanceof HTMLInputElement ? target.placeholder : "") ||
      (target as HTMLElement).innerText ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (role && name && name.length <= 60)
      return `getByRole(${quote(role)}, { name: ${quote(name)} })`;
    if (target.id) return `locator(${quote(`#${CSS.escape(target.id)}`)})`;
    return `locator(${quote(target.tagName.toLowerCase())})`;
  };
  const control = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.closest("a,button,input,select,textarea,summary,label,[role]") ?? target)
      : target;
  addEventListener(
    "click",
    (event) => {
      const target = control(event.target);
      const text = target instanceof HTMLElement ? target.innerText.trim().slice(0, 80) : "";
      send({ type: "action", action: "click", locator: locate(target), text });
    },
    true,
  );
  addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (
        !(
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement ||
          target instanceof HTMLTextAreaElement
        )
      )
        return;
      const secret =
        (target instanceof HTMLInputElement && target.type === "password") ||
        /cc-|one-time-code|current-password|new-password/.test(target.autocomplete ?? "");
      const toggle =
        target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type);
      send({
        type: "action",
        action: toggle
          ? (target as HTMLInputElement).checked
            ? "check"
            : "uncheck"
          : target instanceof HTMLSelectElement
            ? "select"
            : "fill",
        locator: locate(target),
        value: toggle ? undefined : secret ? "[redacted]" : target.value.slice(0, 200),
      });
    },
    true,
  );
  addEventListener(
    "keydown",
    (event) => {
      if (["Enter", "Escape", "Tab"].includes(event.key)) {
        send({ type: "action", action: "press", key: event.key, locator: locate(event.target) });
      }
    },
    true,
  );
  addEventListener(
    "submit",
    (event) => send({ type: "action", action: "submit", locator: locate(event.target) }),
    true,
  );
  const said = new WeakMap<Element, string>();
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const node =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const region = node?.closest(
        '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"])',
      );
      if (!(region instanceof HTMLElement)) continue;
      const text = region.innerText.trim().slice(0, 200);
      if (text && said.get(region) !== text) {
        said.set(region, text);
        send({ type: "toast", text });
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

async function record(recording: Recording, page: Page, event: Omit<Event, "id" | "at" | "page">) {
  if (current !== recording) return;
  const full = {
    id: recording.events.length + 1,
    at: Date.now() - recording.started,
    page: recording.pages.get(page) ?? 0,
    ...event,
  } as Event;
  recording.events.push(full);
  await appendFile(join(recording.dir, "events.jsonl"), `${JSON.stringify(full)}\n`);
}

async function follow(recording: Recording, page: Page): Promise<void> {
  if (recording.pages.has(page)) return;
  recording.pages.set(page, recording.pages.size + 1);
  if (!bound.has(page)) {
    bound.add(page);
    await page.exposeBinding("__ndsRecord", ({ page: source }, json: string) => {
      if (current) void record(current, source as Page, JSON.parse(json));
    });
    await page.addInitScript(listen);
  }
  await page.evaluate(listen).catch(() => {});
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      void record(recording, page, { type: "navigation", url: frame.url() });
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 || type === "fetch" || type === "xhr" || type === "document") {
      void record(recording, page, {
        type: "network",
        method: response.request().method(),
        status: response.status(),
        url: response.url().slice(0, 300),
        resource: type,
        contentType: response.headers()["content-type"] ?? "",
      });
    }
  });
  page.on("requestfailed", (request) => {
    void record(recording, page, {
      type: "network",
      method: request.method(),
      status: 0,
      url: request.url().slice(0, 300),
      failure: request.failure()?.errorText ?? "failed",
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error")
      void record(recording, page, { type: "console", text: message.text().slice(0, 300) });
  });
  page.on(
    "pageerror",
    (error) =>
      void record(recording, page, { type: "page-error", text: error.message.slice(0, 300) }),
  );
  page.on(
    "dialog",
    (dialog) =>
      void record(recording, page, {
        type: "dialog",
        kind: dialog.type(),
        text: dialog.message().slice(0, 200),
      }),
  );
  const cdp = await page.context().newCDPSession(page);
  recording.sessions.push(cdp);
  // Chrome sends a frame only when the screen changes. At most one per interval is written, and
  // a frame held back is written with the next one or when the recording stops, so the latest
  // screen is never lost.
  let last = Number.NEGATIVE_INFINITY;
  let held: { at: number; bytes: Buffer } | undefined;
  const save = async ({ at, bytes }: { at: number; bytes: Buffer }) => {
    recording.bytes += bytes.length;
    if (recording.bytes > MAX_BYTES) {
      void stop("max-size");
      return;
    }
    const path = join(
      recording.dir,
      "frames",
      `${String(at).padStart(8, "0")}-p${recording.pages.get(page)}.jpg`,
    );
    recording.frames.push({ at, path });
    await writeFile(path, bytes);
  };
  recording.flushes.push(async () => {
    if (held) await save(held);
    held = undefined;
  });
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (current !== recording) return;
    const frame = { at: Date.now() - recording.started, bytes: Buffer.from(data, "base64") };
    if (frame.at - last < FRAME_INTERVAL_MS) {
      held = frame;
      return;
    }
    last = frame.at;
    held = undefined;
    void save(frame);
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    maxWidth: 1280,
    maxHeight: 1280,
  });
}

async function start(
  { outputDir }: { outputDir?: string } = {},
  context: BrowserContext,
  artifacts: string,
): Promise<{ id: string; path: string }> {
  if (current) throw new Error(`recording ${current.id} is already active`);
  const id = String(finished.size + 1);
  const dir = outputDir ?? join(artifacts, "recordings", id);
  await mkdir(join(dir, "frames"), { recursive: true });
  const recording: Recording = {
    id,
    dir,
    started: Date.now(),
    events: [],
    frames: [],
    bytes: 0,
    sessions: [],
    flushes: [],
    pages: new Map(),
    timer: setTimeout(() => void stop("max-duration"), MAX_MS),
  };
  current = recording;
  for (const page of context.pages()) await follow(recording, page);
  const added = (page: Page) => {
    if (current === recording) void follow(recording, page);
    else context.off("page", added);
  };
  context.on("page", added);
  return { id, path: dir };
}

async function stop(reason = "stopped") {
  const recording = current;
  if (!recording) throw new Error("no recording is active");
  current = undefined;
  recording.stopped = reason;
  clearTimeout(recording.timer);
  for (const cdp of recording.sessions) {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  for (const flush of recording.flushes) await flush();
  finished.set(recording.id, recording);
  return {
    id: recording.id,
    path: recording.dir,
    reason,
    events: recording.events.length,
    frames: recording.frames.length,
  };
}

function find(id?: string): Recording {
  const recording = id
    ? (finished.get(id) ?? (current?.id === id ? current : undefined))
    : ([...finished.values()].at(-1) ?? current);
  if (!recording) throw new Error("no recording found");
  return recording;
}

const ERRORS = (event: Event) =>
  (event.type === "network" && Number(event.status) >= 400) ||
  (event.type === "network" && event.status === 0) ||
  ["console", "page-error", "toast"].includes(event.type);

function line(event: Event): string {
  const at = `#${event.id} +${(event.at / 1000).toFixed(1)}s [p${event.page}]`;
  switch (event.type) {
    case "action":
      return `${at} ${event.action} ${event.locator}${event.key ? ` ${event.key}` : ""}${event.value !== undefined ? ` = ${JSON.stringify(event.value)}` : ""}`;
    case "network":
      return `${at} ${event.method} ${event.status || String(event.failure)} ${event.url}`;
    case "navigation":
      return `${at} navigation ${event.url}`;
    default:
      return `${at} ${event.type} ${String(event.text ?? event.kind ?? "")}`;
  }
}

/**
 * The events of a recording, the latest by default: a thin timeline, only one type, only
 * errors (failed requests, console and page errors, toasts), or the full records of some ids.
 */
function events({
  id,
  type,
  errors,
  full,
  ids,
}: {
  id?: string;
  type?: string;
  errors?: boolean;
  full?: boolean;
  ids?: number[];
} = {}): string {
  let selected = find(id).events;
  if (ids) selected = selected.filter((event) => ids.includes(event.id));
  if (type) selected = selected.filter((event) => event.type === type);
  if (errors) selected = selected.filter(ERRORS);
  if (selected.length === 0) return "No events";
  return selected.map((event) => (full || ids ? JSON.stringify(event) : line(event))).join("\n");
}

/** The frame closest to an event plus `offset` milliseconds, to see the screen at that moment. */
function frame({
  eventId,
  offset = 0,
  id,
}: {
  eventId: number;
  offset?: number;
  id?: string;
}): string {
  const recording = find(id);
  const event = recording.events.find((each) => each.id === eventId);
  if (!event) throw new Error(`no event ${eventId}`);
  const target = event.at + offset;
  const closest = recording.frames
    .filter((each) => each.path.endsWith(`-p${event.page}.jpg`))
    .reduce<{ at: number; path: string } | undefined>(
      (best, each) =>
        !best || Math.abs(each.at - target) < Math.abs(best.at - target) ? each : best,
      undefined,
    );
  if (!closest) throw new Error("no frame was recorded for that page");
  return closest.path;
}

export function recorderFor(context: BrowserContext, artifacts: string) {
  return {
    start: (options: { outputDir?: string } = {}) => start(options, context, artifacts),
    stop: () => stop(),
    status: () =>
      current ? { id: current.id, events: current.events.length, path: current.dir } : null,
    events,
    frame,
  };
}
