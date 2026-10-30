// Screenshots for agents: one with a label on every interactive element, matching the refs of
// its snapshot, and images shrunk so they cost fewer tokens to read.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright-core";
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

/** The label color of an element that is not interactive, shown with `interactiveOnly: false`. */
const OTHER = "#d9d9d9";

type Label = { ref: string; color: string; x: number; y: number; line: string };

const ELEMENT =
  /^\s*- (\w+)\b.*?\[ref=([^\]]+)\].*?\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/;

// A labelled element as one line: its role, name and ref, as in a snapshot, without the
// snapshot's boxes, pointer hints and other attributes.
function entry(line: string): string {
  const named = /^\s*- (\w+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(line);
  const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1] ?? "";
  return `- ${named?.[1] ?? "element"}${named?.[2] ? ` ${named[2]}` : ""} [ref=${ref}]`;
}

/** The elements of an AI-mode snapshot with boxes that lie in the viewport: the interactive ones,
 * or every element with a ref when `interactiveOnly` is false. */
export function labels(
  view: string,
  width: number,
  height: number,
  interactiveOnly = true,
): Label[] {
  const found: Label[] = [];
  for (const line of view.split("\n")) {
    const match = ELEMENT.exec(line);
    const color = match && (COLORS[match[1] ?? ""] ?? (interactiveOnly ? undefined : OTHER));
    if (!match || !color) continue;
    const [x, y, w, h] = match.slice(3, 7).map(Number) as [number, number, number, number];
    if (w <= 0 || h <= 0 || x + w < 0 || y + h < 0 || x > width || y > height) continue;
    found.push({
      ref: match[2] ?? "",
      color,
      x: Math.max(0, x),
      y: Math.max(0, y),
      line: entry(line),
    });
  }
  return found;
}

/**
 * A screenshot with a label on every visible interactive element, for pages whose layout matters,
 * and the list of those elements by ref, role and name: the image shows where each one is. The
 * labels exist only while the screenshot is taken.
 */
export async function screenshotWithAccessibilityLabels(
  options: {
    page?: Page | undefined;
    /** Labels only this part of the page; the screenshot still shows the viewport. */
    locator?: Locator | undefined;
    /** False labels every element with a ref, not only the interactive ones. */
    interactiveOnly?: boolean | undefined;
  },
  artifacts: string,
): Promise<string> {
  const page = options.page ?? options.locator?.page();
  if (!page) {
    throw new Error(
      "screenshotWithAccessibilityLabels needs { page: state.page } or a locator of that page",
    );
  }
  const view = await (options.locator ?? page).ariaSnapshot({ mode: "ai", boxes: true });
  // Its labels name Playwright's refs, which now are the page's refs.
  useAriaRefs(page);
  const size =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const found = labels(view, size.width, size.height, options.interactiveOnly ?? true);
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
  const list = found.map((label) => label.line).join("\n");
  return `Screenshot: ${path} (${found.length} labels)\n\nURL: ${page.url()}\n\n${list}`;
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
