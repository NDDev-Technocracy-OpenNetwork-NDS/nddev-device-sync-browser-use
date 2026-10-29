// Video of agent tabs: CDP screencast frames encoded by ffmpeg, which must be on PATH, with a
// ghost cursor that follows the mouse events that agent actions dispatch, and a demo cut that
// speeds up the time between executions.
//
// The fixed-size filter and the static-page start are adapted from Playwriter's
// playwriter/src/screen-recording.ts (MIT License, Copyright (c) 2026 Tommy D. Rossi,
// https://github.com/remorses/playwriter).
import { type ChildProcess, spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CDPSession, Page } from "playwright-core";

type Span = { start: number; end: number };

type Recording = {
  cdp: CDPSession;
  ffmpeg: ChildProcess;
  path: string;
  started: number;
  executions: Span[];
  last?: Buffer | undefined;
  timer: ReturnType<typeof setTimeout>;
  encoded: Promise<number>;
};

const recordings = new Map<Page, Recording>();
let running: number | undefined;

/** The executor marks each execution, so a demo cut can tell work from waiting. */
export function executing(active: boolean): void {
  if (active) {
    running = Date.now();
    return;
  }
  const start = running ?? Date.now();
  running = undefined;
  for (const recording of recordings.values()) {
    recording.executions.push({
      start: Math.max(0, start - recording.started),
      end: Date.now() - recording.started,
    });
  }
}

export type RecordingOptions = {
  page: Page;
  outputPath: string;
  frameRate?: number | undefined;
  /** The longest edge of the frames in pixels. */
  maxSize?: number | undefined;
  /** JPEG quality of the frames, 0 to 100. */
  quality?: number | undefined;
  /** Stops by itself after this long; 0 never does. */
  maxDurationMs?: number | undefined;
};

export type RecordingResult = {
  path: string;
  duration: number;
  size: number;
  executionTimestamps: Span[];
};

async function start({
  page,
  outputPath,
  frameRate = 30,
  maxSize = 1920,
  quality = 90,
  maxDurationMs = 15 * 60 * 1000,
}: RecordingOptions): Promise<void> {
  if (recordings.has(page)) throw new Error("this page is already recording");
  if (!isAbsolute(outputPath)) throw new Error("outputPath must be an absolute path");
  // The video keeps the size the page has now: later frames of another size are scaled into it
  // and padded, with square pixels, so a resized viewport never reconfigures the encoder.
  const { width, height } = await frameSize(page, maxSize);
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`;
  const codec = outputPath.endsWith(".webm")
    ? ["-c:v", "libvpx", "-b:v", "4M"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-y", "-loglevel", "error", "-f", "image2pipe", "-use_wallclock_as_timestamps", "1"],
      ...["-c:v", "mjpeg", "-i", "-"],
      ...["-vf", `fps=${frameRate},${fit}`, ...codec, outputPath],
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let errors = "";
  ffmpeg.stderr?.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk}`.slice(-2000);
  });
  const encoded = new Promise<number>((done, failed) => {
    ffmpeg.on("error", () => failed(new Error("recording needs ffmpeg on PATH")));
    ffmpeg.on("close", (code) =>
      code === 0 ? done(code) : failed(new Error(`ffmpeg failed: ${errors.trim()}`)),
    );
  });
  encoded.catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  const recording: Recording = {
    cdp,
    ffmpeg,
    path: outputPath,
    started: Date.now(),
    executions: [],
    timer: setTimeout(() => void stop({ page }).catch(() => {}), maxDurationMs || 2 ** 31 - 1),
    encoded,
  };
  recordings.set(page, recording);
  let frames = 0;
  let firstFrame!: () => void;
  const first = new Promise<void>((done) => {
    firstFrame = done;
  });
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    frames += 1;
    recording.last = Buffer.from(data, "base64");
    ffmpeg.stdin?.write(recording.last);
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    firstFrame();
  });
  page.once("close", () => void stop({ page }).catch(() => {}));
  // The screencast starts first: it wakes the compositor where a screenshot would stall. A page
  // that never paints sends no frame, so a screenshot seeds one, unless a live frame came first.
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality,
    maxWidth: maxSize,
    maxHeight: maxSize,
  });
  if (frames === 0) {
    const seed = cdp
      .send("Page.captureScreenshot", { format: "jpeg", quality })
      .then(({ data }) => {
        if (frames === 0 && recordings.get(page) === recording) {
          recording.last = Buffer.from(data, "base64");
          ffmpeg.stdin?.write(recording.last);
        }
      })
      .catch(() => {});
    await Promise.race([first, seed]);
  }
  await ghostCursor.show({ page }).catch(() => {});
}

/** The frame size of the page now, as the screencast delivers it: CSS pixels times the device
 * scale, fitted into `maxSize`, with even sides for yuv420p. */
async function frameSize(page: Page, maxSize: number): Promise<{ width: number; height: number }> {
  const viewport = await page
    .evaluate(() => [innerWidth, innerHeight, devicePixelRatio] as const)
    .catch(() => [1280, 720, 1] as const);
  const [cssWidth, cssHeight, scale] = viewport;
  const width = Math.max(2, cssWidth * scale);
  const height = Math.max(2, cssHeight * scale);
  const fit = Math.min(1, maxSize / Math.max(width, height));
  const even = (value: number) => Math.max(2, 2 * Math.round((value * fit) / 2));
  return { width: even(width), height: even(height) };
}

async function stop({ page }: { page: Page }): Promise<RecordingResult> {
  const recording = recordings.get(page);
  if (!recording) throw new Error("this page is not recording");
  recordings.delete(page);
  clearTimeout(recording.timer);
  await recording.cdp.send("Page.stopScreencast").catch(() => {});
  await recording.cdp.detach().catch(() => {});
  // A page that stood still since its last frame keeps that frame until the end.
  if (recording.last) recording.ffmpeg.stdin?.write(recording.last);
  recording.ffmpeg.stdin?.end();
  await recording.encoded;
  const { size } = await stat(recording.path);
  return {
    path: recording.path,
    duration: Date.now() - recording.started,
    size,
    executionTimestamps: recording.executions,
  };
}

async function cancel({ page }: { page: Page }): Promise<void> {
  const recording = recordings.get(page);
  if (!recording) return;
  await stop({ page }).catch(() => {});
  await unlink(recording.path).catch(() => {});
}

export const recording = {
  start,
  stop,
  cancel,
  isRecording: ({ page }: { page: Page }) => recordings.has(page),
};

type CursorStyle = "minimal" | "dot" | "screenstudio";

// Drawn in the page itself, so that it follows the DOM mouse events that CDP input produces.
function install(style: CursorStyle): void {
  const id = "nds-ghost-cursor";
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
      const host = document.getElementById("nds-ghost-cursor") as
        | (HTMLElement & { stop?: () => void })
        | null;
      host?.stop?.();
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
