// Per-session Playwright executor for ADR 0015. The Rust host spawns it with a
// session-scoped CDP endpoint on its private socket and talks JSON lines over
// stdio. The vm context only keeps per-session state; it is not a sandbox.
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import vm from "node:vm";
import { chromium, type Locator, type Page } from "playwright-core";

const OUTPUT_LIMIT = 900_000;
const LOG_LIMIT = 200;

type Request = { id: number; code: string };
type Failure = "script_error" | "target_closed" | "browser_disconnected" | "invalid_request";
type Check = { vendor: string; solved: boolean };

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

const [endpoint, artifacts] = process.argv.slice(2);
if (!endpoint || !artifacts) process.exit(2);

const write = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
const context = browser.contexts()[0];
if (!context) process.exit(3);
browser.on("disconnected", () => process.exit(4));

let logs: string[] = [];
const record = (...values: unknown[]): void => {
  if (logs.length < LOG_LIMIT) logs.push(values.map(render).join(" "));
};
const captured = { log: record, info: record, warn: record, error: record, debug: record };

function render(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 });
}

async function checks(page: Page): Promise<Check[]> {
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
async function owner(page: Page, method: string, params: object): Promise<unknown> {
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

const state: Record<string, unknown> = {};
const sandbox = vm.createContext({
  browser,
  context,
  state,
  artifacts,
  console: captured,
  snapshot: (target: Page | Locator) =>
    ("locator" in target && "goto" in target ? target.locator("body") : target).ariaSnapshot(),
  checks,
  notifyOwner: (page: Page, reason: string) => owner(page, "NDS.notifyOwner", { reason }),
  clearOwner: (page: Page) => owner(page, "NDS.clearOwner", {}),
  fetch,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  AbortController,
  setTimeout,
  clearTimeout,
  structuredClone,
});

// A single expression returns its value; statements need an explicit return.
function compile(code: string): vm.Script {
  try {
    return new vm.Script(`(async () => (\n${code.trim().replace(/;+$/, "")}\n))()`);
  } catch {
    return new vm.Script(`(async () => {\n${code}\n})()`);
  }
}

function classify(error: unknown): Failure {
  if (!browser.isConnected()) return "browser_disconnected";
  const message = error instanceof Error ? error.message : "";
  return /Target page, context or browser has been closed|Target closed/.test(message)
    ? "target_closed"
    : "script_error";
}

function bounded(text: string): { output: string; truncated: boolean } {
  return text.length > OUTPUT_LIMIT
    ? { output: text.slice(0, OUTPUT_LIMIT), truncated: true }
    : { output: text, truncated: false };
}

async function run(request: Request): Promise<void> {
  logs = [];
  try {
    const value = await compile(request.code).runInContext(sandbox);
    const text = [...logs, ...(value === undefined ? [] : [render(value)])].join("\n");
    write({ id: request.id, ok: true, ...bounded(text) });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : render(error);
    write({
      id: request.id,
      ok: false,
      error: classify(error),
      ...bounded([...logs, detail].join("\n")),
    });
  }
}

write({ ready: true });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    write({ id: 0, ok: false, error: "invalid_request", output: "", truncated: false });
    continue;
  }
  await run(request);
}
process.exit(0);
