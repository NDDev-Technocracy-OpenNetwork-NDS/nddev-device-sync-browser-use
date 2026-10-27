// Accessibility snapshots for agents in the compact form of ./aria: wrappers flattened and a
// Playwright locator on every interactive line. A frame the page session cannot reach, such as
// one of another process, falls back to Playwright's AI snapshot, compacted the same way.
import type { Frame, Locator, Page } from "playwright-core";
import { FrameOutOfReach, getAriaSnapshot } from "./aria";
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
// The locator of each short ref (e1, e2, ...) of a page's last snapshot.
const refs = new WeakMap<Page, Map<string, string>>();

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
    const map = new Map<string, string>();
    for (const entry of result.refs) {
      const selector = result.getSelectorForRef(entry.ref);
      if (selector) map.set(entry.shortRef, selector);
    }
    refs.set(page, map);
  } catch (error) {
    if (!(error instanceof FrameOutOfReach) || !given.frame) throw error;
    view = compact(await given.frame.locator(":root").ariaSnapshot({ mode: "ai" }));
  }
  const scope = given.locator
    ? `locator ${given.locator}`
    : given.frame
      ? `frame ${given.frame.name()} ${given.frame.url()}`
      : "page";
  const detail = given.interactiveOnly ? " interactive" : "";
  return views.show(page, scope + detail, `URL: ${shortUrl(page.url())}`, view, given);
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

/** The element that a ref of the page's last snapshot names. */
export function ref({ page, ref }: { page: Page; ref: string }): Locator {
  return page.locator(refToLocator({ page, ref }));
}

/** The locator of a ref: a short ref of the page's last snapshot, or a screenshot label's ref. */
export function refToLocator({ ref, page }: { ref: string; page?: Page | undefined }): string {
  return (page && refs.get(page)?.get(ref)) ?? `aria-ref=${ref}`;
}

/** A new document invalidates its refs, so the next snapshot of the page is shown in full. */
export function attach(page: Page): void {
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    views.forget(page);
    refs.delete(page);
  });
}
