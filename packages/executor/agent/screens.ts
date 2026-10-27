// Screenshots for agents: one with a label on every interactive element, matching the refs of
// its snapshot, and images shrunk so they cost fewer tokens to read.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright-core";
import { useAriaRefs } from "./snapshot";

// Interactive roles and their label colors: links, buttons, inputs, checks, sliders, menus, tabs.
const COLORS: Record<string, string> = {
  link: "#ffd60a",
  button: "#ff9f1c",
  textbox: "#ff7f6e",
  searchbox: "#ff7f6e",
  combobox: "#ff7f6e",
  spinbutton: "#ff7f6e",
  checkbox: "#ff8fab",
  radio: "#ff8fab",
  switch: "#ff8fab",
  slider: "#ffcba4",
  menuitem: "#fa8072",
  menuitemcheckbox: "#fa8072",
  menuitemradio: "#fa8072",
  option: "#fa8072",
  tab: "#ffbf00",
  treeitem: "#ffbf00",
};

type Label = { ref: string; color: string; x: number; y: number };

const ELEMENT =
  /^\s*- (\w+)\b.*?\[ref=([^\]]+)\].*?\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/;

/** The interactive elements of an AI-mode snapshot with boxes that lie in the viewport. */
export function labels(view: string, width: number, height: number): Label[] {
  const found: Label[] = [];
  for (const line of view.split("\n")) {
    const match = ELEMENT.exec(line);
    const color = match && COLORS[match[1] ?? ""];
    if (!match || !color) continue;
    const [x, y, w, h] = match.slice(3, 7).map(Number) as [number, number, number, number];
    if (w <= 0 || h <= 0 || x + w < 0 || y + h < 0 || x > width || y > height) continue;
    found.push({ ref: match[2] ?? "", color, x: Math.max(0, x), y: Math.max(0, y) });
  }
  return found;
}

/**
 * A screenshot with a label on every visible interactive element, named by the ref that the
 * returned snapshot gives it, for pages whose layout matters. The labels exist only while the
 * screenshot is taken.
 */
export async function screenshotWithAccessibilityLabels(
  { page }: { page: Page },
  artifacts: string,
): Promise<string> {
  const view = await page.ariaSnapshot({ mode: "ai", boxes: true });
  // Its labels name Playwright's refs, which now are the page's refs.
  useAriaRefs(page);
  const size =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const found = labels(view, size.width, size.height);
  const id = `nds-labels-${Date.now()}`;
  await page.evaluate(
    ({ id, found }) => {
      const host = document.createElement("div");
      host.id = id;
      host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      const root = host.attachShadow({ mode: "closed" });
      for (const label of found) {
        const tag = document.createElement("span");
        tag.textContent = label.ref;
        tag.style.cssText = `position:fixed;left:${label.x}px;top:${label.y}px;background:${label.color};color:#000;font:bold 11px/1.2 monospace;padding:0 2px;border:1px solid #000;border-radius:2px`;
        root.append(tag);
      }
      document.documentElement.append(host);
    },
    { id, found },
  );
  const path = join(artifacts, `${id}.jpg`);
  try {
    await page.screenshot({ path, scale: "css", type: "jpeg", quality: 80 });
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), id).catch(() => {});
  }
  const snapshot = view.replace(/ \[box=[^\]]+\]/g, "");
  return `Screenshot: ${path} (${found.length} labels)\n\nURL: ${page.url()}\n\n${snapshot}`;
}

export type ResizeOptions = {
  input: string;
  output?: string | undefined;
  /** The longest edge of the result in pixels; ignored when `width` or `height` is given. */
  maxDimension?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** JPEG and WebP quality from 1 to 100. */
  quality?: number | undefined;
  format?: "jpeg" | "png" | "webp" | undefined;
};

/** A smaller copy of an image through ffmpeg, which must be on PATH; returns its path. */
export async function resizeImageForAgent({
  input,
  output,
  maxDimension = 1280,
  width,
  height,
  quality = 80,
  format = "jpeg",
}: ResizeOptions): Promise<string> {
  const extension = format === "jpeg" ? "jpg" : format;
  const target = output ?? input.replace(/(\.[^./]+)?$/, `-small.${extension}`);
  const scale =
    width !== undefined || height !== undefined
      ? `scale=${width ?? -2}:${height ?? -2}`
      : `scale='if(gte(iw,ih),min(${maxDimension},iw),-2)':'if(gte(iw,ih),-2,min(${maxDimension},ih))'`;
  const level = Math.min(100, Math.max(1, quality));
  const encoding =
    format === "jpeg"
      ? ["-q:v", String(Math.round(31 - (level / 100) * 29))]
      : format === "webp"
        ? ["-quality", String(level)]
        : [];
  const run = promisify(execFile);
  const args = ["-y", "-loglevel", "error", "-i", input, "-vf", scale, ...encoding, target];
  await run("ffmpeg", args).catch((error: { stderr?: string; message: string }) => {
    throw new Error(
      `ffmpeg could not resize ${input}: ${(error.stderr || error.message).trim().slice(0, 300)}`,
    );
  });
  return target;
}
