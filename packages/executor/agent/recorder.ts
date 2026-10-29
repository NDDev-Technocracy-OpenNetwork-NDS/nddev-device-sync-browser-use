// The recorder: what a person does in agent tabs, so an agent can turn a workflow into a skill.
// Playwright's own recorder, the one behind codegen, reports each action with the locator and the
// code codegen would write. They go into the activity journal (docs/observability.md) beside what
// the pages did meanwhile, live-region messages such as toasts, and a frame of each visual change.
// The host's Rust policy keeps a value typed into a secret field out of the journal; the executor
// tells it which fields are secret by what they are, not by their name. Reading is the host's:
// `recorder events` and `recorder frame`, also `recorder.events()` and `recorder.frame()` in code.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { emit, flush, pageId } from "./activity";
import { hostCommand, observation } from "./host";

const FRAME_INTERVAL_MS = 500;
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_MS = 20 * 60 * 1000;
const TOASTS = "__ndsRecorderToast";

// Playwright 1.64 reports the action itself, with an aria snapshot of the page at that moment.
type Action = {
  name: string;
  ariaSnapshot?: string;
  selector?: string;
  text?: string;
  key?: string;
  options?: string[];
  files?: string[];
  clickCount?: number;
  button?: string;
  url?: string;
};
type Reported = Partial<Action> & {
  action?: Action;
  signal?: { name?: string; url?: string };
};
type Sink = {
  actionAdded(page: Page, data: Reported, code: string): void;
  actionUpdated(page: Page, data: Reported, code: string): void;
  signalAdded(page: Page, data: Reported): void;
};
type Recordable = BrowserContext & {
  _startRecording(params: { language: string }, sink: Sink): Promise<void>;
  _stopRecording(): Promise<void>;
};

type Recording = {
  id: string;
  dir: string;
  started: number;
  events: number;
  frames: number;
  bytes: number;
  sessions: CDPSession[];
  // Writes each page's last frame that the rate limit held back, when the recording stops.
  flushes: (() => Promise<void>)[];
  pages: Set<Page>;
  timer: ReturnType<typeof setTimeout>;
  // Reports go out in the order Playwright gave them, also when a secret check waits.
  order: Promise<void>;
  secrets: Map<string, Promise<boolean>>;
  added: (page: Page) => void;
};

let current: Recording | undefined;
let next = 0;
const toasting = new WeakSet<Page>();

// Runs in the page: reports the text of live regions (alerts, status messages, toasts) once each.
function toasts(binding: string): void {
  const page = window as unknown as Record<string, unknown>;
  if (page.__ndsToasts) return;
  page.__ndsToasts = true;
  const said = new WeakMap<Element, string>();
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const node =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const region = node?.closest(
        '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"])',
      );
      if (!(region instanceof HTMLElement)) continue;
      const text = (region.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      const report = page[binding];
      if (text && said.get(region) !== text && typeof report === "function") {
        said.set(region, text);
        report(text);
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

// A field whose value is a secret by what it is: a password, a one-time code or a card number.
function secretField(element: Element): boolean {
  const input = element as HTMLInputElement;
  const fill = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  return (
    input.type === "password" ||
    /one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/.test(fill)
  );
}

function secret(recording: Recording, page: Page, selector: string): Promise<boolean> {
  const key = `${pageId(page)} ${selector}`;
  let known = recording.secrets.get(key);
  if (!known) {
    known = page
      .locator(selector)
      .first()
      .evaluate(secretField)
      .catch(() => false);
    recording.secrets.set(key, known);
  }
  return known;
}

function person(recording: Recording, page: Page, data: Reported, code: string, update: boolean) {
  const action = data.action ?? (typeof data.name === "string" ? (data as Action) : undefined);
  if (!action || current !== recording) return;
  recording.order = recording.order.then(async () => {
    const hidden =
      action.name === "fill" && action.selector
        ? await secret(recording, page, action.selector)
        : false;
    recording.events += update ? 0 : 1;
    emit({
      type: "person-action",
      recording: recording.id,
      page: pageId(page),
      action: action.name,
      code: code.trim(),
      update,
      secret: hidden,
      ...(action.ariaSnapshot && !hidden ? { aria: action.ariaSnapshot } : {}),
      ...(action.selector ? { locator: action.selector } : {}),
      ...(action.text === undefined ? {} : { value: action.text }),
      ...(action.key ? { key: action.key } : {}),
      ...(action.options ? { options: action.options } : {}),
      ...(action.files ? { files: action.files } : {}),
      ...(action.clickCount === undefined ? {} : { clickCount: action.clickCount }),
      ...(action.button ? { button: action.button } : {}),
      ...(action.url ? { url: action.url } : {}),
    });
  });
}

async function follow(recording: Recording, page: Page): Promise<void> {
  if (recording.pages.has(page)) return;
  recording.pages.add(page);
  if (!toasting.has(page)) {
    toasting.add(page);
    await page
      .exposeBinding(TOASTS, ({ page: source }, text: string) => {
        if (current) emit({ type: "toast", page: pageId(source as Page), text });
      })
      .catch(() => {});
    await page.addInitScript(toasts, TOASTS).catch(() => {});
  }
  await page.evaluate(toasts, TOASTS).catch(() => {});
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
    recording.frames += 1;
    const path = join(
      recording.dir,
      "frames",
      `${String(at).padStart(8, "0")}-p${pageId(page)}.jpg`,
    );
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
  if (observation() !== "full") {
    throw new Error(
      "The recorder keeps what a person does in agent tabs, which only the full observation profile collects; the owner chooses it in the extension's popup",
    );
  }
  const id = `${Date.now().toString(36)}${++next}`;
  const dir = outputDir ?? join(artifacts, "recordings", id);
  await mkdir(join(dir, "frames"), { recursive: true });
  const recording: Recording = {
    id,
    dir,
    started: Date.now(),
    events: 0,
    frames: 0,
    bytes: 0,
    sessions: [],
    flushes: [],
    pages: new Set(),
    timer: setTimeout(() => void stop("max-duration"), MAX_MS),
    order: Promise.resolve(),
    secrets: new Map(),
    added: (page) => {
      if (current === recording) void follow(recording, page);
    },
  };
  current = recording;
  emit({ type: "recording", event: "started", recording: id, dir });
  await (context as Recordable)._startRecording(
    { language: "javascript" },
    {
      actionAdded: (page, data, code) => person(recording, page, data, code, false),
      actionUpdated: (page, data, code) => person(recording, page, data, code, true),
      signalAdded: (page, data) => {
        if (current !== recording) return;
        emit({
          type: "person-signal",
          recording: id,
          page: pageId(page),
          ...((data.signal?.name ?? data.name) ? { signal: data.signal?.name ?? data.name } : {}),
          ...((data.signal?.url ?? data.url) ? { url: data.signal?.url ?? data.url } : {}),
        });
      },
    },
  );
  for (const page of context.pages()) await follow(recording, page);
  context.on("page", recording.added);
  return { id, path: dir };
}

async function stop(reason = "stopped") {
  const recording = current;
  if (!recording) throw new Error("no recording is active");
  current = undefined;
  clearTimeout(recording.timer);
  const context = [...recording.pages][0]?.context();
  context?.off("page", recording.added);
  await (context as Recordable | undefined)?._stopRecording().catch(() => {});
  for (const cdp of recording.sessions) {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  for (const write of recording.flushes) await write();
  await recording.order;
  emit({ type: "recording", event: "stopped", recording: recording.id, reason });
  await flush();
  return {
    id: recording.id,
    path: recording.dir,
    reason,
    events: recording.events,
    frames: recording.frames,
  };
}

type Lines = { lines?: string[]; error?: string };

async function ask(frame: boolean, words: string[]): Promise<string[]> {
  if (current) await flush();
  const answer = await hostCommand<Lines>("NDS.recording", { frame, words });
  if (!answer?.lines) {
    throw new Error(
      answer?.error === "not_found"
        ? "the activity journal holds no such recording, event or frame"
        : "the activity journal could not be read",
    );
  }
  return answer.lines;
}

/**
 * The events of a recording, the latest by default: a thin timeline, only one type, only errors
 * (failed requests, console and page errors), without requests matching `exclude`, or the full
 * records of some ids. One JSON object per line.
 */
async function events({
  id,
  type,
  errors,
  full,
  ids,
  exclude,
}: {
  id?: string;
  type?: string;
  errors?: boolean;
  full?: boolean;
  ids?: number[];
  exclude?: string;
} = {}): Promise<string> {
  const words = [
    ...(id ? ["--recording", id] : []),
    ...(type ? ["--type", type] : []),
    ...(errors ? ["--errors"] : []),
    ...(full ? ["--full"] : []),
    ...(exclude ? ["--exclude", exclude] : []),
    ...(ids ?? []).map(String),
  ];
  return (await ask(false, words)).join("\n") || "No events";
}

/** The frame of an event's page at the event plus `offset` milliseconds, to see that screen. */
async function frame({
  eventId,
  offset = 0,
  id,
}: {
  eventId: number;
  offset?: number;
  id?: string;
}): Promise<string> {
  const lines = await ask(true, [
    String(eventId),
    "--offset",
    String(offset),
    ...(id ? ["--recording", id] : []),
  ]);
  return lines[0] ?? "";
}

export function recorderFor(context: BrowserContext, artifacts: string) {
  return {
    start: (options: { outputDir?: string } = {}) => start(options, context, artifacts),
    stop: () => stop(),
    status: () => (current ? { id: current.id, events: current.events, path: current.dir } : null),
    events,
    frame,
  };
}
