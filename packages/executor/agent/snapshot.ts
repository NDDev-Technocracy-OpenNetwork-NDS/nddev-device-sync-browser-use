// Accessibility snapshots for agents. Playwright's AI mode gives every element a ref, which
// `page.locator("aria-ref=e5")` resolves until the next snapshot, and includes iframes.
import type { Frame, Locator, Page } from "playwright-core";
import { shortUrl } from "./format";
import { type ViewOptions, Views } from "./text";

export type SnapshotOptions = ViewOptions & {
  page?: Page | undefined;
  locator?: Locator | undefined;
  frame?: Frame | undefined;
};

const views = new Views<Page>(0);

function isPage(value: object): value is Page {
  return "goto" in value && "mainFrame" in value;
}

function isLocator(value: object): value is Locator {
  return "ariaSnapshot" in value && "page" in value && !isPage(value);
}

/**
 * The page's snapshot, or that of a locator's or frame's subtree. The first call shows it in full,
 * later calls only what changed, and a search shows the first matching lines.
 */
export async function snapshot(options: SnapshotOptions | Page | Locator): Promise<string> {
  const given: SnapshotOptions = isPage(options)
    ? { page: options }
    : isLocator(options)
      ? { locator: options }
      : options;
  const page = given.page ?? given.locator?.page() ?? given.frame?.page();
  const target = given.locator ?? given.frame?.locator(":root") ?? page;
  if (!page || !target) throw new Error("snapshot needs { page }, or a locator or frame of a page");
  const view = await target.ariaSnapshot({ mode: "ai" });
  const scope = given.locator
    ? `locator ${given.locator}`
    : given.frame
      ? `frame ${given.frame.name()} ${given.frame.url()}`
      : "page";
  return views.show(page, scope, `URL: ${shortUrl(page.url())}`, view, given);
}

/** The element that a ref of the page's last snapshot names. */
export function ref({ page, ref }: { page: Page; ref: string }): Locator {
  return page.locator(refToLocator({ ref }));
}

/** The selector of a snapshot ref, for `page.locator()`. */
export function refToLocator({ ref }: { ref: string }): string {
  return `aria-ref=${ref}`;
}

/** A new document invalidates its refs, so the next snapshot of the page is shown in full. */
export function attach(page: Page): void {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) views.forget(page);
  });
}
