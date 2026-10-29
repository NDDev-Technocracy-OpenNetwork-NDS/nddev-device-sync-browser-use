// Video of agent tabs (agent/capture.ts encodes it) with a ghost cursor that follows the mouse
// events that agent actions dispatch, and a demo cut that speeds up the time between executions.
// `recording.start()` returns a handle to keep in `state`: `stop()`, `cancel()`, `setPage(page)`
// to film another tab, and `wait(ms)` for the manual clock.
//
// The handle API and the viewport fit are adapted from MIT-licensed code by Tommy D. Rossi (THIRD_PARTY_NOTICES.md).
import { spawn } from "node:child_process";
import { inspect } from "node:util";
import type { Page } from "playwright-core";
import { Capture, type Clock, fitToAspectRatio } from "./capture";

type Span = { start: number; end: number };

const handles = new Set<RecordingHandle>();
let running: number | undefined;

/** The executor marks each execution, so a demo cut can tell work from waiting. */
export function executing(active: boolean): void {
  if (active) {
    running = Date.now();
    return;
  }
  const start = running ?? Date.now();
  running = undefined;
  for (const handle of handles) handle.executed(start, Date.now());
}

export type RecordingOptions = {
  page: Page;
  outputPath: string;
  frameRate?: number | undefined;
  /** The page's sound too, with the real clock only. */
  audio?: boolean | undefined;
  /** `real` films all time; `manual` only the time inside `handle.wait(ms)`. */
  clock?: Clock | undefined;
  /** The longest edge of the frames in pixels. */
  maxSize?: number | undefined;
  /** JPEG quality of the frames, 0 to 100. */
  quality?: number | undefined;
  /** Shrinks the viewport to this aspect ratio while recording, such as 16:9; restored after. */
  aspectRatio?: { width: number; height: number } | null | undefined;
  /** Stops by itself after this long; 0 never does. */
  maxDurationMs?: number | undefined;
};

export type RecordingResult = {
  path: string;
  duration: number;
  size: number;
  executionTimestamps: Span[];
};

/** Shrinks the viewport to the aspect ratio and returns what restores it. A tab of the owner's
 * window has no emulated viewport: it is fitted from its window's size through CDP, and the
 * override is cleared afterwards, so the tab is as it was. */
async function fit(
  page: Page,
  ratio: { width: number; height: number } | null | undefined,
): Promise<() => Promise<void>> {
  if (!ratio) return async () => {};
  const emulated = page.viewportSize();
  const current =
    emulated ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null));
  if (!current) return async () => {};
  const fitted = fitToAspectRatio(current, ratio);
  if (fitted.width === current.width && fitted.height === current.height) return async () => {};
  if (emulated) {
    await page.setViewportSize(fitted);
    return async () => {
      if (!page.isClosed()) await page.setViewportSize(emulated).catch(() => {});
    };
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...fitted,
    deviceScaleFactor: 0,
    mobile: false,
  });
  return async () => {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  };
}

/** A running recording; keep it in `state` to stop it or move it in later executions. */
export class RecordingHandle {
  private readonly executions: Span[] = [];
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private done: Promise<RecordingResult> | undefined;

  constructor(
    private readonly capture: Capture,
    private readonly ratio: { width: number; height: number } | null | undefined,
    private restore: () => Promise<void>,
    maxDurationMs: number,
  ) {
    handles.add(this);
    this.timer =
      maxDurationMs > 0
        ? setTimeout(() => void this.stop().catch(() => {}), maxDurationMs)
        : undefined;
  }

  get page(): Page {
    return this.capture.page;
  }
  get clock(): Clock {
    return this.capture.clock;
  }
  get outputPath(): string {
    return this.capture.outputPath;
  }
  get startedAt(): number {
    return this.capture.startedAt;
  }
  get isRecording(): boolean {
    return this.capture.recording;
  }

  /** @internal */
  executed(start: number, end: number): void {
    this.executions.push({
      start: Math.max(0, start - this.startedAt),
      end: end - this.startedAt,
    });
  }

  /** Films another tab from now on; the viewport fit and the ghost cursor move with it. */
  async setPage(page: Page): Promise<void> {
    if (page === this.page) return;
    const restore = await fit(page, this.ratio);
    try {
      await this.capture.setPage(page);
    } catch (error) {
      await restore();
      throw error;
    }
    await this.restore();
    this.restore = restore;
    await ghostCursor.show({ page }).catch(() => {});
  }

  /** The manual clock only: films the next `ms` of real time. */
  wait(ms: number): Promise<void> {
    return this.capture.wait(ms);
  }

  /** Finishes the file; the real clock also returns the executions' times for a demo cut. */
  stop(): Promise<RecordingResult> {
    this.done ??= (async () => {
      clearTimeout(this.timer);
      handles.delete(this);
      try {
        const result = await this.capture.stop();
        return { ...result, executionTimestamps: this.clock === "real" ? this.executions : [] };
      } finally {
        await this.restore();
      }
    })();
    return this.done;
  }

  /** Stops without keeping the file. */
  async cancel(): Promise<void> {
    clearTimeout(this.timer);
    handles.delete(this);
    await this.capture.cancel();
    await this.restore();
  }

  [inspect.custom](): object {
    return {
      outputPath: this.outputPath,
      clock: this.clock,
      isRecording: this.isRecording,
      page: this.page.isClosed() ? "(closed)" : this.page.url(),
    };
  }
}

async function start({
  page,
  outputPath,
  aspectRatio,
  maxDurationMs = 15 * 60 * 1000,
  ...options
}: RecordingOptions): Promise<RecordingHandle> {
  if ([...handles].some((handle) => handle.page === page)) {
    throw new Error("this page is already recording");
  }
  const restore = await fit(page, aspectRatio);
  let capture: Capture;
  try {
    capture = await Capture.start({ page, outputPath, ...options });
  } catch (error) {
    await restore();
    throw error;
  }
  const handle = new RecordingHandle(capture, aspectRatio, restore, maxDurationMs);
  await ghostCursor.show({ page }).catch(() => {});
  return handle;
}

function find(page: Page): RecordingHandle | undefined {
  return [...handles].find((handle) => handle.page === page);
}

export const recording = {
  start,
  /** The handle's own `stop()`, by its page. */
  stop: async ({ page }: { page: Page }): Promise<RecordingResult> => {
    const handle = find(page);
    if (!handle) throw new Error("this page is not recording");
    return handle.stop();
  },
  cancel: async ({ page }: { page: Page }): Promise<void> => {
    await find(page)?.cancel();
  },
  isRecording: ({ page }: { page: Page }) => find(page) !== undefined,
};

type CursorStyle = "minimal" | "dot" | "screenstudio";

// Drawn in the page itself, so that it follows the DOM mouse events that CDP input produces.
function install(style: CursorStyle): void {
  const id = "nds-ghost-cursor";
  // Replaces the extension's cursor of agent mouse actions, which then stays off until hidden.
  delete (globalThis as { __ndsCursorOff?: boolean }).__ndsCursorOff;
  document.getElementById(id)?.remove();
  const host = document.createElement("div");
  host.id = id;
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const cursor = document.createElement("div");
  const size = style === "dot" ? 14 : style === "screenstudio" ? 26 : 18;
  cursor.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;margin:-${size / 2}px 0 0 -${size / 2}px;border-radius:50%;background:${style === "dot" ? "#ff3b30" : "rgba(0,0,0,.55)"};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:0;transition:opacity .3s,transform .1s`;
  root.append(cursor);
  document.documentElement.append(host);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const move = (event: MouseEvent) => {
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    cursor.style.opacity = "1";
    clearTimeout(idle);
    idle = setTimeout(() => {
      cursor.style.opacity = "0";
    }, 5000);
  };
  const press = (event: MouseEvent) => {
    move(event);
    cursor.style.transform = "scale(.7)";
    setTimeout(() => {
      cursor.style.transform = "";
    }, 150);
  };
  addEventListener("mousemove", move, true);
  addEventListener("mousedown", press, true);
  (host as HTMLElement & { stop?: () => void }).stop = () => {
    removeEventListener("mousemove", move, true);
    removeEventListener("mousedown", press, true);
    host.remove();
  };
}

const shown = new WeakMap<Page, (frame: unknown) => void>();

export const ghostCursor = {
  /** Shows a cursor that follows agent mouse actions, also after navigations, until hidden. */
  async show({ page, style = "minimal" }: { page: Page; style?: CursorStyle }): Promise<void> {
    const previous = shown.get(page);
    if (previous) page.off("framenavigated", previous);
    const again = (frame: unknown) => {
      if (frame === page.mainFrame()) void page.evaluate(install, style).catch(() => {});
    };
    shown.set(page, again);
    page.on("framenavigated", again);
    await page.evaluate(install, style);
  },
  async hide({ page }: { page: Page }): Promise<void> {
    const again = shown.get(page);
    if (again) page.off("framenavigated", again);
    shown.delete(page);
    await page.evaluate(() => {
      // The extension's cursor of agent mouse actions stays off too, until the next show().
      (globalThis as { __ndsCursorOff?: boolean }).__ndsCursorOff = true;
      const host = document.getElementById("nds-ghost-cursor") as
        | (HTMLElement & { stop?: () => void })
        | null;
      if (host?.stop) host.stop();
      else host?.remove();
    });
  },
};

export type DemoOptions = {
  recordingPath: string;
  durationMs: number;
  executionTimestamps: Span[];
  /** How much faster the time between executions plays. */
  speed?: number | undefined;
  outputPath?: string | undefined;
};

/**
 * A copy of a recording in which executions play at normal speed and the time between them
 * faster. It can outlast one execution: keep the promise in `state` and await it in a later one.
 */
export function createDemoVideo({
  recordingPath,
  durationMs,
  executionTimestamps,
  speed = 6,
  outputPath,
}: DemoOptions): Promise<string> {
  const target = outputPath ?? recordingPath.replace(/(\.[^./]+)?$/, "-demo$1");
  const spans: (Span & { fast: boolean })[] = [];
  let at = 0;
  for (const { start, end } of [...executionTimestamps].sort((a, b) => a.start - b.start)) {
    if (start > at) spans.push({ start: at, end: start, fast: true });
    if (end > Math.max(start, at)) spans.push({ start: Math.max(start, at), end, fast: false });
    at = Math.max(at, end);
  }
  if (durationMs > at) spans.push({ start: at, end: durationMs, fast: true });
  const parts = spans.filter(({ start, end }) => end - start >= 40);
  const filters = parts.map(
    ({ start, end, fast }, index) =>
      `[0:v]trim=start=${start / 1000}:end=${end / 1000},setpts=(PTS-STARTPTS)${fast ? `/${speed}` : ""}[v${index}]`,
  );
  const graph = `${filters.join(";")};${parts.map((_, index) => `[v${index}]`).join("")}concat=n=${parts.length}:v=1:a=0[out]`;
  return new Promise((done, failed) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        recordingPath,
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        target,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      errors = `${errors}${chunk}`.slice(-2000);
    });
    ffmpeg.on("error", () => failed(new Error("createDemoVideo needs ffmpeg on PATH")));
    ffmpeg.on("close", (code) =>
      code === 0 ? done(target) : failed(new Error(`ffmpeg failed: ${errors.trim()}`)),
    );
  });
}
