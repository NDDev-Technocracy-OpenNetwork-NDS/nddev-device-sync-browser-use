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
  const detail = given.interactiveOnly ? " interactive" : "";
  // A part's locators are relative to it; say so once rather than on every line.
  const relative = given.locator
    ? "\nLocators are inside the locator: use locator.locator(...), or ref() for [ref=...]."
    : given.frame && given.frame !== page.mainFrame()
      ? "\nLocators are inside the frame: use frame.locator(...), or ref() for [ref=...]."
      : "";
  return views.show(page, scope + detail, `URL: ${shortUrl(page.url())}${relative}`, view, given);
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
