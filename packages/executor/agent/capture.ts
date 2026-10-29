// Video of one agent tab: CDP screencast frames and, with `audio`, the page's sound, encoded by
// ffmpeg, which must be on PATH.
//
//   Page.captureScreenshot (seed) --+
//   Page.screencastFrame (jpeg) ----+--> latest frame
//                                           |  a ticker writes the latest frame once per output
//                                           v  frame slot, so a still page keeps its duration
//   audio tap -- binding -- PCM queue -- ffmpeg fd 3 (s16le 48 kHz)
//                                           v
//                   ffmpeg -f image2pipe -c:v mjpeg -i pipe:0 -> temporary file -> outputPath
//
// The `real` clock records all wall-clock time; the `manual` one only the time inside `wait(ms)`,
// so an agent's thinking stays out of the video. The output keeps its first size: later frames of
// another size, also from another page after `setPage`, are scaled into it and padded with
// square pixels. The file appears at `outputPath` only when it is complete.
//
// Adapted from MIT-licensed code by Tommy D. Rossi (THIRD_PARTY_NOTICES.md).
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { CDPSession, Page } from "playwright-core";
import { startAudioTap, stopAudioTap } from "./audio-tap";

export type Clock = "real" | "manual";

const SAMPLE_RATE = 48000;
// s16le stereo.
const SAMPLE_BYTES = 4;
// Audio is written this far behind the clock, so the page's chunks (4096 samples, about 85 ms)
// arrive before their slot; more audio queued than the bound means the page ran ahead.
const AUDIO_LATENCY_MS = 150;
const AUDIO_QUEUE_MS = 400;
// The encoder is too slow or stuck once this much waits in the pipes.
const PIPE_BYTES = 64 * 1024 * 1024;
const STDERR_LINES = 20;
const EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
const HARDWARE: Record<string, string[]> = {
  darwin: ["h264_videotoolbox"],
  win32: ["h264_nvenc", "h264_qsv", "h264_amf"],
  linux: ["h264_nvenc", "h264_qsv"],
};

/** The largest size inside `current` with the aspect ratio of `ratio`; it never grows. */
export function fitToAspectRatio(
  current: { width: number; height: number },
  ratio: { width: number; height: number },
): { width: number; height: number } {
  const target = ratio.width / ratio.height;
  if (current.width / current.height > target) {
    return { width: Math.round(current.height * target), height: current.height };
  }
  return { width: current.width, height: Math.round(current.width / target) };
}

/** Output size in device pixels, the longest edge at most `maxSize`, even sides for yuv420p. */
export function captureSize(
  css: { width: number; height: number; scale: number },
  maxSize: number,
) {
  const scale = Math.min(css.scale || 1, maxSize / Math.max(css.width, css.height));
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(css.width), height: even(css.height) };
}

let encoder: Promise<string> | undefined;

/** The platform's hardware H.264 encoder that actually encodes a frame here, else libx264. */
export function h264(): Promise<string> {
  encoder ??= (async () => {
    for (const codec of HARDWARE[platform()] ?? []) {
      const works = await new Promise<boolean>((done) => {
        const child = spawn(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "nullsrc=s=64x64:d=0.01",
          ].concat(["-c:v", codec, "-f", "null", "-"]),
          { stdio: "ignore" },
        );
        const timer = setTimeout(() => {
          child.kill();
          done(false);
        }, 5000);
        child.on("close", (code) => {
          clearTimeout(timer);
          done(code === 0);
        });
        child.on("error", () => {
          clearTimeout(timer);
          done(false);
        });
      });
      if (works) return codec;
    }
    return "libx264";
  })();
  return encoder;
}

/** ffmpeg's arguments for a file: H.264 and AAC in .mp4, .mov and .mkv, VP8 and Opus in .webm. */
export function ffmpegArguments(options: {
  width: number;
  height: number;
  fps: number;
  audio: boolean;
  codec: string;
  outputPath: string;
}): string[] {
  const { width, height, fps, audio, codec, outputPath } = options;
  const extension = extname(outputPath).toLowerCase();
  const kbps = Math.min(20000, Math.max(2000, Math.round((width * height * fps * 0.1) / 1000)));
  let encoding: string[];
  if (extension === ".webm") {
    encoding = [
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      `${kbps}k`,
    ].concat(["-crf", "10"], audio ? ["-c:a", "libopus", "-b:a", "128k"] : []);
  } else {
    const video =
      codec === "libx264"
        ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        : codec === "h264_videotoolbox"
          ? ["-c:v", codec, "-b:v", `${kbps}k`, "-realtime", "true"]
          : ["-c:v", codec, "-b:v", `${kbps}k`];
    encoding = video.concat(
      audio ? ["-c:a", "aac", "-b:a", "160k"] : [],
      extension === ".mkv" ? [] : ["-movflags", "+faststart"],
    );
  }
  const input = ["-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps)]
    .concat(["-thread_queue_size", "512", "-i", "pipe:0"])
    .concat(
      audio
        ? [
            "-f",
            "s16le",
            "-ar",
            String(SAMPLE_RATE),
            "-ac",
            "2",
            "-thread_queue_size",
            "512",
          ].concat(["-i", "pipe:3"])
        : [],
    );
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`;
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"].concat(
    input,
    ["-vf", fit, "-r", String(fps)],
    encoding,
    [outputPath],
  );
}

export type CaptureOptions = {
  page: Page;
  outputPath: string;
  frameRate?: number | undefined;
  audio?: boolean | undefined;
  clock?: Clock | undefined;
  maxSize?: number | undefined;
  quality?: number | undefined;
};

export type CaptureResult = { path: string; duration: number; size: number };

/** One running video. Its file appears at `outputPath` once `stop()` resolves. */
export class Capture {
  readonly outputPath: string;
  readonly fps: number;
  readonly clock: Clock;
  readonly audio: boolean;
  readonly startedAt = Date.now();
  private current: Page;
  private session: CDPSession;
  private readonly ffmpeg: ChildProcess;
  private readonly video: Writable;
  private readonly sound: Writable | undefined;
  private readonly temporary: string;
  private readonly quality: number;
  private readonly size: { width: number; height: number };
  private readonly stderr: string[] = [];
  private readonly result: Promise<CaptureResult>;
  private finished!: (result: { error?: Error }) => void;
  private latest = Buffer.alloc(0);
  private frames = 0;
  private captured = 0;
  private samples = 0;
  private queue: Buffer[] = [];
  private queued = 0;
  private started = performance.now();
  // The manual clock's finished waits, and the one running now.
  private waited = 0;
  private window: { at: number; ms: number } | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private cleanups: (() => Promise<unknown>)[] = [];
  private failure: Error | undefined;
  private finishing = false;
  private cancelled = false;
  private nth = 1;
  private rate = { at: performance.now(), frames: 0 };

  private constructor(
    options: CaptureOptions & { codec: string },
    session: CDPSession,
    size: { width: number; height: number },
  ) {
    this.outputPath = resolve(options.outputPath);
    this.fps = Math.min(60, Math.max(1, Math.round(options.frameRate ?? 30)));
    this.clock = options.clock ?? "real";
    this.audio = options.audio ?? false;
    this.quality = options.quality ?? 90;
    this.current = options.page;
    this.session = session;
    this.size = size;
    const extension = extname(this.outputPath);
    this.temporary = join(
      dirname(this.outputPath),
      `.${basename(this.outputPath, extension)}.${randomUUID()}${extension}`,
    );
    this.ffmpeg = spawn(
      "ffmpeg",
      ffmpegArguments({
        ...size,
        fps: this.fps,
        audio: this.audio,
        codec: options.codec,
        outputPath: this.temporary,
      }),
      { stdio: ["pipe", "ignore", "pipe", this.audio ? "pipe" : "ignore"] },
    );
    this.video = this.ffmpeg.stdin as Writable;
    this.sound = this.audio ? (this.ffmpeg.stdio[3] as Writable) : undefined;
    const settled = new Promise<{ error?: Error }>((done) => {
      this.finished = done;
    });
    this.result = settled.then(async ({ error }) => {
      if (error || this.cancelled) {
        await rm(this.temporary, { force: true });
        throw error ?? new Error("The recording was cancelled");
      }
      await rename(this.temporary, this.outputPath);
      const { size: bytes } = await stat(this.outputPath);
      return {
        path: this.outputPath,
        duration: Math.round((this.frames * 1000) / this.fps),
        size: bytes,
      };
    });
    this.result.catch(() => {});
  }

  static async start(options: CaptureOptions): Promise<Capture> {
    const outputPath = resolve(options.outputPath);
    const extension = extname(outputPath).toLowerCase();
    if (!EXTENSIONS.has(extension)) {
      throw new Error(`A recording is .mp4, .mov, .mkv or .webm, not "${extension}"`);
    }
    if (options.clock === "manual" && options.audio) {
      throw new Error('Audio needs the real clock, not clock: "manual"');
    }
    await mkdir(dirname(outputPath), { recursive: true });
    const codec = extension === ".webm" ? "libvpx" : await h264();
    const css = await options.page
      .evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }))
      .catch(() => ({ width: 1280, height: 720, scale: 1 }));
    const size = captureSize(css, options.maxSize ?? 1920);
    const session = await options.page.context().newCDPSession(options.page);
    const capture = new Capture({ ...options, codec }, session, size);
    const spawned = await new Promise<Error | undefined>((done) => {
      capture.ffmpeg.once("spawn", () => done(undefined));
      capture.ffmpeg.once("error", (error) =>
        done(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("Recording needs ffmpeg on PATH")
            : error,
        ),
      );
    });
    if (spawned) {
      await session.detach().catch(() => {});
      throw spawned;
    }
    capture.wire();
    try {
      await capture.attach();
      capture.started = performance.now();
      capture.ticker = setInterval(() => capture.tick(false), 1000 / capture.fps);
    } catch (error) {
      await capture.cancel();
      throw new Error("The recording could not start", { cause: error });
    }
    return capture;
  }

  get page(): Page {
    return this.current;
  }

  get recording(): boolean {
    return !this.finishing;
  }

  /** Frames come from another page from now on, scaled into the same size. */
  async setPage(page: Page): Promise<void> {
    if (this.finishing) throw new Error("The recording already stopped");
    if (page === this.current) return;
    await this.detach();
    this.current = page;
    try {
      this.session = await page.context().newCDPSession(page);
      await this.attach();
    } catch (error) {
      await this.stop().catch(() => {});
      throw new Error("The recording could not move to that page and stopped", { cause: error });
    }
  }

  /** The manual clock only: the next `ms` of real time go into the video, exactly. */
  async wait(ms: number): Promise<void> {
    if (this.clock !== "manual") throw new Error('wait() needs a recording with clock: "manual"');
    if (this.finishing || this.failure) throw this.failure ?? new Error("The recording stopped");
    if (this.window) throw new Error("wait() is already running; await it before the next one");
    this.window = { at: performance.now(), ms };
    try {
      await Promise.race([delay(ms), this.result.catch(() => {})]);
    } finally {
      this.window = undefined;
      this.waited += ms;
    }
    this.tick(false);
  }

  /** Writes what is due, closes ffmpeg's inputs and waits for the finished file. */
  async stop(): Promise<CaptureResult> {
    if (!this.finishing) {
      this.finishing = true;
      clearInterval(this.ticker);
      this.tick(true);
      await this.detach();
      this.video.end();
      this.sound?.end();
      const killer = setTimeout(() => {
        this.failure ??= new Error("ffmpeg did not finish the recording in 30 s");
        this.ffmpeg.kill("SIGKILL");
      }, 30_000);
      void this.result.finally(() => clearTimeout(killer)).catch(() => {});
    }
    return this.result;
  }

  /** Stops without keeping the file. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    if (!this.finishing) {
      this.finishing = true;
      clearInterval(this.ticker);
      await this.detach();
    }
    this.ffmpeg.kill("SIGKILL");
    await this.result.catch(() => {});
  }

  private wire(): void {
    this.video.on("error", () => {});
    this.sound?.on("error", () => {});
    let rest = "";
    this.ffmpeg.stderr?.on("data", (data: Buffer) => {
      rest += data.toString();
      const lines = rest.split(/[\r\n]+/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.stderr.push(line.trim());
        if (this.stderr.length > STDERR_LINES) this.stderr.shift();
      }
    });
    this.ffmpeg.once("close", (code, signal) => {
      clearInterval(this.ticker);
      let error = this.failure;
      if (!error && !this.cancelled && code !== 0) {
        const tail = this.stderr.slice(-5).join("\n");
        error = new Error(
          `ffmpeg ended with ${signal ?? `code ${code}`}${tail ? `:\n${tail}` : ""}`,
        );
      } else if (!error && !this.cancelled && !this.finishing) {
        error = new Error("ffmpeg ended before the recording stopped");
      }
      void this.detach().finally(() => this.finished(error ? { error } : {}));
    });
  }

  /** Hooks the current page: its frames, its closing and, with audio, its sound. */
  private async attach(): Promise<void> {
    const page = this.current;
    const session = this.session;
    const closed = () => void this.stop().catch(() => {});
    page.once("close", closed);
    this.cleanups.push(async () => page.off("close", closed));
    const before = this.captured;
    let first!: () => void;
    const arrived = new Promise<void>((done) => {
      first = done;
    });
    session.on("Page.screencastFrame", ({ data, sessionId }) => {
      void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (this.session !== session) return;
      this.latest = Buffer.from(data, "base64");
      this.captured += 1;
      this.rate.frames += 1;
      first();
    });
    this.cleanups.push(async () => {
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    });
    await this.screencast();
    if (this.audio) await this.listen();
    if (this.captured > before) return;
    // The screencast starts first: it wakes the compositor where a screenshot would stall. A page
    // that never paints sends no frame, so a screenshot seeds one unless a live frame came first.
    await Promise.race([
      arrived,
      session
        .send("Page.captureScreenshot", { format: "jpeg", quality: this.quality })
        .then(({ data }) => {
          if (this.captured === before && this.session === session) {
            this.latest = Buffer.from(data, "base64");
          }
        })
        .catch(() => {}),
    ]);
  }

  private screencast(): Promise<unknown> {
    return this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.quality,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: this.nth,
    });
  }

  private async listen(): Promise<void> {
    const session = this.session;
    const binding = `__ndsAudio_${randomUUID().replaceAll("-", "")}`;
    const source = `(${startAudioTap.toString()})(${JSON.stringify(binding)})`;
    session.on("Runtime.bindingCalled", ({ name, payload }) => {
      if (name !== binding || this.finishing) return;
      let pcm: string | undefined;
      try {
        pcm = (JSON.parse(payload) as { pcm?: string }).pcm;
      } catch {
        pcm = undefined;
      }
      if (!pcm) return;
      const chunk = Buffer.from(pcm, "base64");
      this.queue.push(chunk);
      this.queued += chunk.length;
    });
    await session.send("Runtime.addBinding", { name: binding });
    const { identifier } = await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
    this.cleanups.push(async () => {
      await Promise.allSettled([
        session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }),
        session.send("Runtime.evaluate", {
          expression: `(${stopAudioTap.toString()})(${JSON.stringify(binding)})`,
        }),
        session.send("Runtime.removeBinding", { name: binding }),
      ]);
    });
    await session.send("Runtime.evaluate", { expression: source });
  }

  private async detach(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  }

  /** The wall-clock time that belongs in the video by now. */
  private elapsed(): number {
    if (this.clock === "real") return performance.now() - this.started;
    const open = this.window ? Math.min(performance.now() - this.window.at, this.window.ms) : 0;
    return this.waited + open;
  }

  /** Writes every frame slot and audio sample due by now. */
  private tick(last: boolean): void {
    if (this.failure || this.latest.length === 0) return;
    const elapsed = this.elapsed();
    const due = Math.floor((elapsed * this.fps) / 1000);
    while (this.frames < due) {
      this.video.write(this.latest);
      this.frames += 1;
    }
    this.adapt();
    if (this.sound) {
      const ms = last ? elapsed : elapsed - AUDIO_LATENCY_MS;
      this.writeAudio(Math.floor((ms * SAMPLE_RATE) / 1000));
    }
    const waiting = this.video.writableLength + (this.sound?.writableLength ?? 0);
    if (waiting > PIPE_BYTES) {
      this.failure = new Error(
        `ffmpeg is too slow (${waiting} bytes waiting); lower frameRate or maxSize`,
      );
      this.ffmpeg.kill("SIGKILL");
    }
  }

  /** On displays that paint far faster than the video's rate, asks for every nth frame once. */
  private adapt(): void {
    const ms = performance.now() - this.rate.at;
    if (this.nth > 1 || ms < 1000) return;
    const delivered = (this.rate.frames * 1000) / ms;
    this.rate = { at: performance.now(), frames: 0 };
    if (delivered < this.fps * 1.5) return;
    this.nth = Math.floor(delivered / this.fps);
    void this.screencast().catch(() => {});
  }

  /** Writes queued page audio up to `target` samples, with silence where the page sent none. */
  private writeAudio(target: number): void {
    const sound = this.sound;
    if (!sound) return;
    const most = ((AUDIO_QUEUE_MS * SAMPLE_RATE) / 1000) * SAMPLE_BYTES;
    while (this.queued > most && this.queue.length > 1) {
      this.queued -= this.queue.shift()?.length ?? 0;
    }
    let needed = (target - this.samples) * SAMPLE_BYTES;
    while (needed > 0) {
      const chunk = this.queue[0];
      const bytes = chunk ? Math.min(chunk.length, needed) : needed;
      sound.write(chunk ? chunk.subarray(0, bytes) : Buffer.alloc(bytes));
      if (chunk) {
        if (bytes === chunk.length) this.queue.shift();
        else this.queue[0] = chunk.subarray(bytes);
        this.queued -= bytes;
      }
      this.samples += bytes / SAMPLE_BYTES;
      needed -= bytes;
    }
  }
}
