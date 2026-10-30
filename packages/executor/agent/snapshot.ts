// Accessibility snapshots for agents in the compact form of ./aria: wrappers flattened and a
// Playwright locator on every interactive line. A frame the page session cannot reach, such as
// one of another process, falls back to Playwright's AI snapshot, compacted the same way.
import type { Frame, Locator, Page } from "playwright-core";
import { FrameOutOfReach, frameScope, getAriaSnapshot } from "./aria";
import { shortUrl } from "./format";
import { type ViewOptions, Views } from "./text";

export type SnapshotOptions = ViewOptions & {
  page?: Page | undefined;
  locator?: Locator | undefined;
  frame?: Frame | undefined;
  /** Only interactive elements and the labels and landmarks around them. */
  interactiveOnly?: boolean | undefined;
  /** The page's map instead of its tree: landmarks with a locator each, their headings, and
   * how many links, buttons and fields each part holds. */
  outline?: boolean | undefined;
};

const views = new Views<Page>(5);
// The frames to enter for the refs of each page's last view that showed refs: a labeled
// screenshot (the main frame) or a frame's fallback snapshot. The snapshot's own lines show
// locators, not refs, so it never shadows them.
const scopes = new WeakMap<Page, string>();

/** The refs shown last for the page are Playwright's; `prefix` enters the frame they are of. */
export function useAriaRefs(page: Page, prefix = ""): void {
  scopes.set(page, prefix);
}

function isPage(value: object): value is Page {
  return "goto" in value && "mainFrame" in value;
}

function isLocator(value: object): value is Locator {
  return "ariaSnapshot" in value && "page" in value && !isPage(value);
}

/**
 * The page's snapshot, or that of a locator's or frame's subtree. The first call shows it in full,
 * later calls only what changed, and a search shows the first matching lines with context.
 */
export async function snapshot(options: SnapshotOptions | Page | Locator): Promise<string> {
  const given: SnapshotOptions = isPage(options)
    ? { page: options }
    : isLocator(options)
      ? { locator: options }
      : options;
  const page = given.page ?? given.locator?.page() ?? given.frame?.page();
  if (!page) throw new Error("snapshot needs { page }, or a locator or frame of a page");
  let view: string;
  try {
    const result = await getAriaSnapshot({
      page,
      frame: given.frame,
      locator: given.locator,
      interactiveOnly: given.interactiveOnly,
    });
    view = result.snapshot;
  } catch (error) {
    if (!(error instanceof FrameOutOfReach)) throw error;
    // Playwright reaches every frame: its snapshot of exactly that part stands in, and its refs
    // enter that frame.
    const part = given.locator ?? error.frame.locator(":root");
    view = compact(await part.ariaSnapshot({ mode: "ai" }));
    useAriaRefs(page, await frameScope(error.frame));
  }
  const scope = given.locator
    ? `locator ${given.locator}`
    : given.frame
      ? `frame ${given.frame.name()} ${given.frame.url()}`
      : "page";
  if (given.outline) view = outline(view);
  const detail = `${given.interactiveOnly ? " interactive" : ""}${given.outline ? " outline" : ""}`;
  // A part's locators are relative to it; say so once rather than on every line.
  const relative = given.locator
    ? "\nLocators are inside the locator: use locator.locator(...), or ref() for [ref=...]."
    : given.frame && given.frame !== page.mainFrame()
      ? "\nLocators are inside the frame: use frame.locator(...), or ref() for [ref=...]."
      : "";
  return views.show(page, scope + detail, `URL: ${shortUrl(page.url())}${relative}`, view, given);
}

// Parts a page is made of, which an agent reads one at a time.
const LANDMARKS = new Set(["banner", "navigation", "main", "complementary", "contentinfo"]);
for (const role of ["region", "form", "search", "dialog", "alertdialog"]) LANDMARKS.add(role);
// What an interactive line is, by its role, for the counts.
const KINDS: Record<string, string> = {
  link: "links",
  button: "buttons",
  textbox: "fields",
  searchbox: "fields",
  combobox: "fields",
  spinbutton: "fields",
  checkbox: "checks",
  radio: "checks",
  switch: "checks",
  tab: "tabs",
  menuitem: "menu items",
  option: "options",
  slider: "sliders",
};

const SINGULAR: Record<string, string> = {
  links: "link",
  buttons: "button",
  fields: "field",
  checks: "check",
  tabs: "tab",
  "menu items": "menu item",
  options: "option",
  sliders: "slider",
};

/**
 * A snapshot's map: each landmark with a locator to read it, its headings, and how many links,
 * buttons, fields and other controls it and each heading's section hold. Big pages shrink to a
 * few lines; the agent then reads the part it needs with `snapshot({ locator })` or a search.
 */
export function outline(view: string): string {
  type Count = Record<string, number>;
  type Part = {
    line: string;
    indent: number;
    count: Count;
    headings: { line: string; count: Count }[];
  };
  const parts: Part[] = [];
  const open: Part[] = [];
  const seen = new Map<string, number>();
  const total: Count = {};
  const add = (count: Count, kind: string) => {
    count[kind] = (count[kind] ?? 0) + 1;
  };
  const counts = (count: Count) =>
    Object.entries(count)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, number]) => `${number} ${number === 1 ? (SINGULAR[kind] ?? kind) : kind}`)
      .join(", ");
  for (const raw of view.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trimStart();
    if (!body.startsWith("- ")) continue;
    while (open.length > 0 && (open.at(-1)?.indent ?? 0) >= indent) open.pop();
    const role = body.startsWith("- role=")
      ? (/^- role=(\w+)/.exec(body)?.[1] ?? "")
      : (/^- (\w+)/.exec(body)?.[1] ?? "");
    const name = body.startsWith("- role=")
      ? /\[name="((?:[^"\\]|\\.)*)"i?\]/.exec(body)?.[1]
      : /^- \w+ "((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
    if (LANDMARKS.has(role)) {
      // A locator that reaches this landmark: its role and name, numbered among equal ones.
      const key = `role=${role}${name ? `[name="${name}"i]` : ""}`;
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      const locator = `${key}${index > 0 ? ` >> nth=${index}` : ""}`;
      const part: Part = {
        line: `${"  ".repeat(open.length)}- ${role}${name ? ` "${name}"` : ""} [${locator}]`,
        indent,
        count: {},
        headings: [],
      };
      parts.push(part);
      open.push(part);
      continue;
    }
    const current = open.at(-1);
    if (role === "heading") {
      current?.headings.push({ line: `- heading "${name ?? ""}"`, count: {} });
      continue;
    }
    const kind = KINDS[role];
    if (!kind) continue;
    add(total, kind);
    for (const part of open) add(part.count, kind);
    const heading = current?.headings.at(-1);
    if (heading) add(heading.count, kind);
  }
  const lines = [`Page: ${counts(total) || "no controls"}`];
  for (const part of parts) {
    lines.push(`${part.line}${Object.keys(part.count).length ? `: ${counts(part.count)}` : ""}`);
    const pad = part.line.length - part.line.trimStart().length + 2;
    for (const heading of part.headings.slice(0, 40)) {
      const count = counts(heading.count);
      lines.push(`${" ".repeat(pad)}${heading.line}${count ? `: ${count}` : ""}`);
    }
    if (part.headings.length > 40)
      lines.push(`${" ".repeat(pad)}… ${part.headings.length - 40} more headings`);
  }
  if (parts.length === 0) {
    lines.push("No landmarks: read it with snapshot({ search }), a locator or interactiveOnly.");
  }
  return lines.join("\n");
}

/** Playwright's AI snapshot without what agents never need: pointer and focus marks, link
 * targets, hidden subtrees, and unnamed wrappers, whose children move up a level. */
export function compact(view: string): string {
  const out: string[] = [];
  // Indents of the dropped wrappers above the current line, and of a hidden subtree.
  const dropped: number[] = [];
  let hidden: number | undefined;
  for (const raw of view.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    while (dropped.length > 0 && (dropped.at(-1) ?? 0) >= indent) dropped.pop();
    if (hidden !== undefined && indent > hidden) continue;
    hidden = undefined;
    const line = raw.replace(/ \[cursor=pointer\]| \[active\]/g, "");
    const body = line.trimStart();
    if (body.startsWith("- /url:")) continue;
    if (/ \[aria-hidden\]/.test(body)) {
      hidden = indent;
      continue;
    }
    if (/^- (generic|group|none|presentation)( \[ref=e\d+\])?:$/.test(body)) {
      dropped.push(indent);
      continue;
    }
    out.push(`${" ".repeat(Math.max(0, indent - 2 * dropped.length))}${body}`);
  }
  return out.join("\n");
}

/** The element that a ref the page showed last names: a screenshot label or a frame line. */
export function ref({ page, ref }: { page: Page; ref: string }): Locator {
  return page.locator(refToLocator({ page, ref }));
}

/** The selector of a ref the page showed last, entering its frame; for `page.locator()`. */
export function refToLocator({ ref, page }: { ref: string; page?: Page | undefined }): string {
  return `${(page && scopes.get(page)) ?? ""}aria-ref=${ref}`;
}

/** A new document invalidates its refs, so the next snapshot of the page is shown in full. */
export function attach(page: Page): void {
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    views.forget(page);
    scopes.delete(page);
  });
}
