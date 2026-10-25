// Real-browser acceptance for ADR 0015. It launches an isolated Chrome for
// Testing profile with the unpacked NDS extension, registers the built host
// for that profile only and drives the agent CLI against a local fixture.
// A separate Playwright pipe connection observes the browser independently.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";

const repository = resolve(import.meta.dir, "..");
const chrome = required("NDS_TEST_CHROME");
const binary = required("NDS_TEST_HOST");
const root = mkdtempSync(join(tmpdir(), "nds-browser-use-acceptance-"));
// Socket paths must fit sun_path; the run's own directory keeps it isolated.
const runtime = mkdtempSync(join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "nds-bu-"));
const profile = join(root, "profile");
const hostLog = join(root, "host.log");
const extensionId = "lcdkocghcaakekcaeopjanfbohpfacbk";
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  XDG_CONFIG_HOME: join(root, "config"),
  NDS_BROWSER_USE_RUNTIME_DIR: runtime,
};

let observer: BrowserContext;
let fixture: ReturnType<typeof Bun.serve>;
let origin: string;
let requests = 0;

function required(name: string): string {
  const value = process.env[name];
  if (!value?.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  return value;
}

type Result = { code: number; body: Record<string, unknown> };

async function cli(...args: string[]): Promise<Result> {
  const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  return { code: await child.exited, body: JSON.parse(text) as Record<string, unknown> };
}

async function run(project: string, code: string, ...flags: string[]): Promise<Result> {
  return cli("-s", project, "-e", code, ...flags);
}

function tabs(result: Result): { target: string; document: string; url: string }[] {
  return result.body.tabs as { target: string; document: string; url: string }[];
}

async function observed(path: string): Promise<Page | undefined> {
  return observer.pages().find((page) => page.url() === `${origin}${path}`);
}

async function ownerSwitch(enable: boolean): Promise<void> {
  const page = await observer.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const toggle = page.locator("#toggle");
  await page.waitForFunction(
    () => !(document.getElementById("toggle") as HTMLButtonElement).disabled,
  );
  if ((await toggle.getAttribute("data-enabled")) !== String(enable)) await toggle.click();
  await page.waitForFunction(
    (expected) => document.getElementById("toggle")?.dataset.enabled === String(expected),
    enable,
  );
  await page.close();
}

beforeAll(async () => {
  fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests += 1;
      const page: Record<string, string> = {
        "/": `<title>Fixture</title><button id="inc" onclick="c.textContent = Number(c.textContent) + 1">Increment</button><span id="c">0</span><button id="open" onclick="window.open('/target')">Open</button>`,
        "/target": "<title>Popup target</title><p>popup</p>",
        "/owner": "<title>Owner</title><p>owner work</p>",
        "/dialog": `<button id="ask" onclick="answer.textContent = confirm('Proceed?') ? 'accepted' : 'dismissed'">Ask</button><span id="answer"></span>`,
        "/form": `<input id="text" oninput="echo.textContent = this.value"><span id="echo"></span><input id="file" type="file" onchange="picked.textContent = this.files[0].name + ':' + this.files[0].size"><span id="picked"></span>`,
        "/fetch": `<button id="load" onclick="fetch('/api').then((r) => r.text()).then((t) => (out.textContent = t))">Load</button><span id="out"></span>`,
        "/api": "live",
        // A different site (localhost vs 127.0.0.1) renders out of process.
        "/frame": `<iframe src="http://localhost:${fixture?.port}/inner"></iframe>`,
        "/inner": `<button id="inner" onclick="this.textContent = 'inside'">Inner</button>`,
        // WebAuthn needs a domain RP ID; localhost is a secure context.
        "/passkey": `<button id="register" onclick="navigator.credentials.create({ publicKey: { rp: { name: 'NDS', id: 'localhost' }, user: { id: new Uint8Array(16), name: 'agent', displayName: 'Agent' }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } }).then(() => (outcome.textContent = 'registered'), (e) => (outcome.textContent = e.name))">Register</button><button id="signin" onclick="navigator.credentials.get({ publicKey: { rpId: 'localhost', challenge: new Uint8Array(32), userVerification: 'required' } }).then(() => (outcome.textContent = 'signed-in'), (e) => (outcome.textContent = e.name))">Sign in</button><span id="outcome"></span>`,
      };
      const body = page[new URL(request.url).pathname];
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://127.0.0.1:${fixture.port}`;
  // The host's stderr carries its local telemetry; keep it as evidence.
  const wrapper = join(root, "host.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${binary}' "$@" 2>>'${hostLog}'\n`);
  chmodSync(wrapper, 0o700);
  const hosts = join(profile, "NativeMessagingHosts");
  const installed = await cli(
    "install",
    "--bun",
    process.execPath,
    "--executor",
    join(repository, "packages/executor/executor.ts"),
    "--host-dir",
    hosts,
  );
  expect(installed.code).toBe(0);
  const manifest = join(hosts, "ai.nddev.nds.browser_use.json");
  const registered = JSON.parse(readFileSync(manifest, "utf8"));
  expect(registered.allowed_origins).toEqual([
    `chrome-extension://${extensionId}/`,
    "chrome-extension://lpnfnhkdjamhnoknoohhmjfhhjkeofio/",
  ]);
  writeFileSync(manifest, JSON.stringify({ ...registered, path: wrapper }));
  observer = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: true,
    env,
    args: [
      `--disable-extensions-except=${repository}/packages/extension`,
      `--load-extension=${repository}/packages/extension`,
    ],
  });
  // The observer stays passive: Playwright would otherwise dismiss every
  // dialog on pages it watches and race the agent's own handler.
  for (const page of observer.pages()) page.on("dialog", () => undefined);
  observer.on("page", (page) => page.on("dialog", () => undefined));
  for (let attempt = 0; attempt < 100 && !existsSync(join(runtime, "control.sock")); attempt++) {
    await Bun.sleep(100);
  }
});

afterAll(async () => {
  await observer?.close().catch(() => undefined);
  fixture?.stop(true);
  rmSync(runtime, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("the connected extension reports enabled control", async () => {
  const status = await cli("status");
  expect(status.code).toBe(0);
  expect(status.body.enabled).toBe(true);
  expect(String(status.body.browser)).toStartWith("Chrome/");
});

test("agent code acts in its own tab and the browser shows the result", async () => {
  expect((await cli("session", "new", "acceptance")).body).toMatchObject({ project: "acceptance" });
  const before = requests;
  const result = await run(
    "acceptance",
    `state.page = await context.newPage(); await state.page.goto("${origin}/"); await state.page.getByRole("button", { name: "Increment" }).click(); return await state.page.locator("#c").textContent()`,
    "--timeout",
    "20000",
  );
  expect(result.code).toBe(0);
  expect(result.body.output).toBe("1");
  expect(tabs(result)).toEqual([expect.objectContaining({ url: `${origin}/` })]);
  expect(requests).toBeGreaterThan(before);
  const page = await observed("/");
  expect(await page?.locator("#c").textContent()).toBe("1");
});

test("owner tabs stay outside the agent session", async () => {
  const owner = await observer.newPage();
  await owner.goto(`${origin}/owner`);
  const result = await run("acceptance", "context.pages().map((page) => page.url())");
  expect(result.body.output).not.toContain("/owner");
  expect(tabs(result).map((tab) => tab.url)).not.toContain(`${origin}/owner`);
  expect(owner.url()).toBe(`${origin}/owner`);
});

test("session state and the aria snapshot are available between runs", async () => {
  expect((await run("acceptance", "state.value = 41")).code).toBe(0);
  expect((await run("acceptance", "state.value + 1")).body.output).toBe("42");
  const snapshot = await run("acceptance", "snapshot(state.page)");
  expect(snapshot.body.output).toContain('button "Increment"');
});

test("a replaced document refuses an outdated expectation", async () => {
  const [first] = tabs(await run("acceptance", "1"));
  if (!first) throw new Error("agent tab is missing");
  const reloaded = await run("acceptance", "await state.page.reload(); return 'reloaded'");
  const [current] = tabs(reloaded);
  if (!current) throw new Error("agent tab is missing");
  expect(current.document).not.toBe(first.document);
  const stale = await run("acceptance", "1", "--expect", `${first.target}:${first.document}`);
  expect(stale).toEqual({ code: 2, body: expect.objectContaining({ error: "stale_document" }) });
  const fresh = await run("acceptance", "2", "--expect", `${current.target}:${current.document}`);
  expect(fresh.body.output).toBe("2");
});

test("popups opened by an agent page join the agent session", async () => {
  const result = await run(
    "acceptance",
    `const [popup] = await Promise.all([context.waitForEvent("page"), state.page.click("#open")]); await popup.waitForLoadState(); return popup.url()`,
    "--timeout",
    "20000",
  );
  expect(result.body.output).toBe(`${origin}/target`);
  const popup = tabs(result).find((tab) => tab.url === `${origin}/target`);
  expect(popup?.document).toBeString();
});

test("the agent answers JavaScript dialogs", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/dialog"); page.once("dialog", (dialog) => dialog.accept()); await page.click("#ask"); return await page.locator("#answer").textContent()`,
    "--timeout",
    "20000",
  );
  expect(result.body.output).toBe("accepted");
  expect(await (await observed("/dialog"))?.locator("#answer").textContent()).toBe("accepted");
});

test("keyboard input and file uploads reach the page", async () => {
  const upload = join(runtime, "sessions", "acceptance", "upload.txt");
  writeFileSync(upload, "nds");
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/form"); await page.locator("#text").pressSequentially("typed"); await page.setInputFiles("#file", "${upload}"); return [await page.locator("#echo").textContent(), await page.locator("#picked").textContent()].join(" ")`,
    "--timeout",
    "20000",
  );
  expect(result.body.output).toBe("typed upload.txt:3");
});

test("network interception and cross-origin frames work in agent tabs", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.route("**/api", (route) => route.fulfill({ body: "intercepted" })); await page.goto("${origin}/fetch"); await page.click("#load"); await page.locator("#out", { hasText: "intercepted" }).waitFor(); const frames = await context.newPage(); await frames.goto("${origin}/frame"); await frames.frameLocator("iframe").locator("#inner").click(); return [await page.locator("#out").textContent(), await frames.frameLocator("iframe").locator("#inner").textContent()].join(" ")`,
    "--timeout",
    "20000",
  );
  expect(result.body.output).toBe("intercepted inside");
  const frame = (await observed("/frame"))
    ?.frames()
    .find((candidate) => candidate.url().endsWith("/inner"));
  expect(await frame?.locator("#inner").textContent()).toBe("inside");
});

// Chrome serves WebAuthn only to a focused page: a background agent tab is
// refused, and the agent must bring its tab to the front for a passkey step.
test("raw CDP sessions reach agent tabs, including a virtual authenticator", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("http://localhost:${fixture.port}/passkey");
     const outcome = page.locator("#outcome");
     const cdp = await context.newCDPSession(page);
     await cdp.send("WebAuthn.enable", { enableUI: false });
     const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
     const added = new Promise((done) => cdp.once("WebAuthn.credentialAdded", () => done("event")));
     await page.click("#register"); await outcome.filter({ hasText: /./ }).waitFor();
     const background = await outcome.textContent();
     await page.bringToFront();
     await page.click("#register"); await outcome.filter({ hasText: "registered" }).waitFor();
     await page.click("#signin"); await outcome.filter({ hasText: "signed-in" }).waitFor();
     const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
     const event = await added; await cdp.detach();
     return [background, await outcome.textContent(), credentials.length, event].join(" ")`,
    "--timeout",
    "20000",
  );
  expect(result.body.output).toBe("NotAllowedError signed-in 1 event");
});

test("screenshots are written inside the session area", async () => {
  const result = await run(
    "acceptance",
    `const page = context.pages().find((candidate) => candidate.url().endsWith("/form")); const path = artifacts + "/form.png"; await page.screenshot({ path }); return path`,
    "--timeout",
    "20000",
  );
  const path = String(result.body.output);
  expect(path).toBe(join(runtime, "sessions", "acceptance", "form.png"));
  expect([...readFileSync(path).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("concurrent execution in one session is refused as busy", async () => {
  const slow = run(
    "acceptance",
    "await new Promise((done) => setTimeout(done, 2000)); return 'slow'",
  );
  await Bun.sleep(300);
  const second = await run("acceptance", "1");
  expect(second.body.error).toBe("busy");
  expect((await slow).body.output).toBe("slow");
});

test("a timeout stops the run before its later action and resets state", async () => {
  const page = await observed("/");
  const before = await page?.locator("#c").textContent();
  const result = await run(
    "acceptance",
    `await new Promise((done) => setTimeout(done, 3000)); await state.page.click("#inc")`,
    "--timeout",
    "1000",
  );
  expect(result).toEqual({ code: 2, body: expect.objectContaining({ error: "timeout" }) });
  await Bun.sleep(3500);
  expect(await page?.locator("#c").textContent()).toBe(before ?? "");
  expect((await run("acceptance", "state.value === undefined")).body.output).toBe("true");
});

test("a closed tab is reported, not acted on", async () => {
  const before = new Set(tabs(await run("acceptance", "1")).map((tab) => tab.target));
  const opened = await run(
    "acceptance",
    `state.closing = await context.newPage(); await state.closing.goto("${origin}/target"); return "open"`,
    "--timeout",
    "20000",
  );
  const target = tabs(opened).find((tab) => !before.has(tab.target));
  if (!target?.document) throw new Error("closing tab is missing");
  await run("acceptance", "await state.closing.close(); return 'closed'");
  const refused = await run("acceptance", "1", "--expect", `${target.target}:${target.document}`);
  expect(refused.body.error).toBe("target_closed");
  const failed = await run("acceptance", "await state.closing.title()");
  expect(failed).toEqual({ code: 1, body: expect.objectContaining({ failure: "target_closed" }) });
});

test("the owner's switch revokes sessions until control is enabled again", async () => {
  await ownerSwitch(false);
  expect((await cli("status")).body.enabled).toBe(false);
  expect((await run("acceptance", "1")).body.error).toBe("permission_required");
  expect((await cli("session", "new", "other")).body.error).toBe("permission_required");
  await ownerSwitch(true);
  const reopened = await cli("session", "new", "acceptance");
  expect(reopened.body).toMatchObject({ project: "acceptance" });
  expect(Number(reopened.body.tabs)).toBeGreaterThan(0);
  const result = await run("acceptance", "context.pages().map((page) => page.url()).sort()");
  expect(result.body.output).toContain(`${origin}/`);
});

test("closing a session cleans only its own area", async () => {
  expect((await cli("session", "close", "acceptance", "--close-tabs")).code).toBe(0);
  await Bun.sleep(500);
  expect(await observed("/")).toBeUndefined();
  expect(await observed("/owner")).toBeDefined();
  expect(existsSync(join(runtime, "sessions", "acceptance"))).toBe(false);
  expect(await observed("/frame")).toBeUndefined();
  expect((await run("acceptance", "1")).body.error).toBe("session_not_found");
});

test("browser exit ends the host and leaves no sockets", async () => {
  await observer.close();
  await Bun.sleep(500);
  const status = await cli("status");
  expect(status).toEqual({ code: 2, body: expect.objectContaining({ error: "unavailable" }) });
  expect(existsSync(join(runtime, "control.sock"))).toBe(false);
  expect(existsSync(join(runtime, "cdp.sock"))).toBe(false);
});

test("host telemetry is schema-valid and carries no page data", () => {
  const lines = readFileSync(hostLog, "utf8").trim().split("\n");
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const names = new Set(events.map((event) => event["event.name"]));
  for (const name of [
    "browser.host.started",
    "browser.extension.connected",
    "browser.session.opened",
    "browser.execute.completed",
    "browser.control.disabled",
    "browser.session.closed",
    "browser.host.stopped",
  ]) {
    expect(names).toContain(name);
  }
  expect(names).not.toContain("logging.fields.rejected");
  expect(names).not.toContain("logging.event.rejected");
  const text = lines.join("\n");
  for (const secret of [
    `127.0.0.1:${fixture.port}`,
    "Increment",
    "state.page",
    "Popup target",
    "/owner",
  ]) {
    expect(text).not.toContain(secret);
  }
  for (const event of events) expect(event["service.name"]).toBe("nddev-device-sync-browser-use");
});
