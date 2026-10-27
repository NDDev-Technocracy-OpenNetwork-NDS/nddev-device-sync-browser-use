// Bot checks such as CAPTCHAs, which only a person passes: agent code finds them and hands them
// to the owner through the extension instead of acting inside one.
import type { Page } from "playwright-core";

export type Check = { vendor: string; solved: boolean };

// Bot checks that only a person passes. Each is found by the frame it loads and read from the
// response field its page gets once it is passed; agent code never acts inside one. reCAPTCHA's
// invisible badge scores without a check and is skipped.
const CHECKS = [
  {
    vendor: "cloudflare",
    frame: /^https:\/\/challenges\.cloudflare\.com\//,
    field: "cf-turnstile-response",
  },
  {
    vendor: "recaptcha",
    frame:
      /^https:\/\/(www\.google\.com|www\.recaptcha\.net)\/recaptcha\/(api2|enterprise)\/(anchor|bframe)\?(?!.*[?&]size=invisible)/,
    field: "g-recaptcha-response",
  },
  {
    vendor: "hcaptcha",
    frame: /^https:\/\/([a-z0-9-]+\.)?hcaptcha\.com\/captcha\//,
    field: "h-captcha-response",
  },
];

export async function checks(page: Page): Promise<Check[]> {
  const found = new Map<string, boolean>();
  for (const frame of page.frames()) {
    const check = CHECKS.find((candidate) => candidate.frame.test(frame.url()));
    const parent = frame.parentFrame();
    if (!check || !parent) continue;
    const element = await frame.frameElement().catch(() => undefined);
    const visible = (await element?.isVisible().catch(() => false)) ?? false;
    await element?.dispose();
    if (!visible) continue;
    const solved = await parent
      .evaluate(
        (name) =>
          Array.from(document.getElementsByName(name)).some(
            (field) => (field as HTMLInputElement).value !== "",
          ),
        check.field,
      )
      .catch(() => false);
    found.set(check.vendor, (found.get(check.vendor) ?? true) && solved);
  }
  return [...found].map(([vendor, solved]) => ({ vendor, solved }));
}

// The extension answers its own NDS domain in an agent tab: it shows the owner a notification
// that opens the tab, or clears it.
export async function owner(page: Page, method: string, params: object): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp) as unknown as (
    method: string,
    params: object,
  ) => Promise<unknown>;
  try {
    return await send(method, params);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
