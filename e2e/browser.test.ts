// Real-browser acceptance for ADR 0015. It launches an isolated Chrome for
// Testing profile with the unpacked NDS extension, registers the built host
// for that profile only and drives the agent CLI against a local fixture.
// A separate Playwright pipe connection observes the browser independently.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";

const windows = process.platform === "win32";
const repository = resolve(import.meta.dir, "..");
const chrome = required("NDS_TEST_CHROME");
const binary = required("NDS_TEST_HOST");
const root = mkdtempSync(join(tmpdir(), "nds-browser-use-acceptance-"));
// Socket paths must fit sun_path; the run's own directory keeps it isolated. On Windows the
// temporary directory lies in the user's local application data, as the host requires.
const runtime = mkdtempSync(
  join(windows ? tmpdir() : (process.env.XDG_RUNTIME_DIR ?? "/tmp"), "nds-bu-"),
);
// Executors name the CDP socket in their endpoint; on Windows the host hands them the
// drive-less path.
const cdpEndpoint = windows
  ? join(runtime, "cdp.sock")
      .replace(/^[A-Za-z]:/, "")
      .replaceAll("\\", "/")
  : `${runtime}/cdp.sock`;

const profile = join(root, "profile");
// The same layout `just install` creates: the host finds its extension files
// next to `bin/`, so an update can reload the unpacked build.
const prefix = join(root, "prefix");
const hostBinary = join(prefix, "bin", windows ? "nds-browser-use.exe" : "nds-browser-use");
const installed = join(prefix, "extension");
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
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

// Windows socket files are reparse points that `stat` cannot follow.
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

type Result = { code: number; body: Record<string, unknown> };

async function cli(...args: string[]): Promise<Result> {
  const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  const result = { code: await child.exited, body: JSON.parse(text) as Record<string, unknown> };
  // CI diagnostics: only the stable error code and message, never agent code or page data.
  if (process.env.NDS_E2E_DIAGNOSTICS === "1" && typeof result.body.error === "string") {
    console.error(`cli ${args[0]} refused: ${result.body.error} (${result.body.message})`);
  }
  return result;
}

// A session's executor starts with it; like an agent that waits, scenarios run once the session
// reports its executor ready, so a slow start never spends a run's deadline.
async function opened(project: string): Promise<Result> {
  const result = await cli("session", "new", project);
  const ready = Date.now() + 45_000;
  for (;;) {
    const listed: unknown = (await cli("session", "list")).body;
    const sessions = Array.isArray(listed) ? (listed as Record<string, unknown>[]) : [];
    if (sessions.some((session) => session.project === project && session.executor === true)) {
      return result;
    }
    if (result.code !== 0 || Date.now() > ready) {
      throw new Error(
        `the executor of ${project} did not report ready: ${JSON.stringify(result.body)}`,
      );
    }
    await Bun.sleep(100);
  }
}

async function run(project: string, code: string, ...flags: string[]): Promise<Result> {
  return cli("-s", project, "-e", code, ...flags);
}

function tabs(result: Result): { target: string; document: string; url: string }[] {
  return result.body.tabs as { target: string; document: string; url: string }[];
}

// Process IDs whose command line contains `pattern`; this run's paths make it unique. On
// Windows the pattern reaches the query through its environment, so the query never matches
// its own command line.
function processes(pattern: string): number[] {
  const found = windows
    ? Bun.spawnSync(
        [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:NDS_E2E_PATTERN) } | ForEach-Object { $_.ProcessId }",
        ],
        { env: { ...process.env, NDS_E2E_PATTERN: pattern } },
      )
    : Bun.spawnSync(["pgrep", "-f", pattern]);
  return found.stdout.toString().trim().split(/\r?\n/).filter(Boolean).map(Number);
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
        "/": `<title>Fixture</title><button id="inc" onclick="c.textContent = Number(c.textContent) + 1">Increment</button><span id="c">0</span><button id="open" onclick="window.open('/target')">Open</button><a id="link" href="/linked" target="_blank">Linked</a>`,
        "/linked": "<title>Linked</title><p>linked</p>",
        "/target": "<title>Popup target</title><p>popup</p>",
        "/owner": "<title>Owner</title><p>owner work</p>",
        "/dialog": `<button id="ask" onclick="answer.textContent = confirm('Proceed?') ? 'accepted' : 'dismissed'">Ask</button><span id="answer"></span>`,
        "/form": `<input id="text" oninput="echo.textContent = this.value"><span id="echo"></span><input id="file" type="file" onchange="picked.textContent = this.files[0].name + ':' + this.files[0].size"><span id="picked"></span>`,
        "/fetch": `<button id="load" onclick="fetch('/api').then((r) => r.text()).then((t) => (out.textContent = t))">Load</button><span id="out"></span>`,
        "/api": "live",
        // A different site (localhost vs 127.0.0.1) renders out of process.
        "/frame": `<iframe src="http://localhost:${fixture?.port}/inner"></iframe>`,
        "/inner": `<button id="inner" onclick="this.textContent = 'inside'">Inner</button>`,
        "/helpers": `<title>Helpers</title><script>console.log("loaded helpers")</script><main><button id="save" onclick="this.textContent = 'Saved'">Save</button><button id="fail" onclick="setTimeout(() => { throw new Error('boom') })">Fail</button><a id="pop" href="/linked" target="_blank">Pop</a><div id="box" style="overflow-y: auto; height: 50px"><p style="height: 200px">tall</p></div><input id="name" value="x" aria-label="Name"></main>`,
        // A Turnstile widget with its response field, and reCAPTCHA's invisible badge, which is no
        // check a person passes; the test routes both vendors' frames.
        "/check": `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/e2e/0x4AAAAAAA/auto/normal" width="300" height="65"></iframe><iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=e2e&size=invisible" width="256" height="60"></iframe><input type="hidden" name="cf-turnstile-response" value="">`,
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
  // The host's stderr carries its local telemetry; keep it as evidence. Chrome starts a Windows
  // host through cmd, so the wrapper there is a command script.
  const wrapper = join(root, windows ? "host.cmd" : "host.sh");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  cpSync(binary, hostBinary);
  cpSync(join(repository, "packages/extension"), installed, { recursive: true });
  if (windows) {
    writeFileSync(wrapper, `@"${hostBinary}" %* 2>>"${hostLog}"\r\n`);
  } else {
    chmodSync(hostBinary, 0o755);
    writeFileSync(wrapper, `#!/bin/sh\nexec '${hostBinary}' "$@" 2>>'${hostLog}'\n`);
    chmodSync(wrapper, 0o700);
  }
  // Windows browsers find hosts through the registry value of the named browser; the others
  // read the profile's own host directory.
  const registration = await cli(
    "install",
    "--bun",
    process.execPath,
    "--executor",
    join(repository, "packages/executor/executor.ts"),
    ...(windows
      ? ["--browser", "chrome-for-testing"]
      : ["--host-dir", join(profile, "NativeMessagingHosts")]),
  );
  expect(registration.code).toBe(0);
  const manifest = String(registration.body.manifest);
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
      `--disable-extensions-except=${installed}`,
      `--load-extension=${installed}`,
      ...(process.env.NDS_E2E_DIAGNOSTICS === "1" ? ["--enable-logging=stderr"] : []),
    ],
  });
  // The observer stays passive: Playwright would otherwise dismiss every
  // dialog on pages it watches and race the agent's own handler.
  for (const page of observer.pages()) page.on("dialog", () => undefined);
  observer.on("page", (page) => page.on("dialog", () => undefined));
  // The host binds its sockets before the extension's hello arrives; scenarios start once the
  // host reports the connected extension, which takes longer on slower or loaded runners.
  // The host's own answer decides: a presence check never saw the control socket on Windows.
  // On a hosted macOS runner with every core loaded, Chrome took over 45 s to start the host.
  const connected = Date.now() + 120_000;
  while ((await cli("status")).body.enabled !== true) {
    if (Date.now() > connected)
      throw new Error("the extension did not connect to its host in 120 s");
    await Bun.sleep(100);
  }
}, 180_000);

afterAll(async () => {
  await observer?.close().catch(() => undefined);
  fixture?.stop(true);
  // CI diagnostics: the host log carries event names and outcomes only, never page data.
  if (process.env.NDS_E2E_DIAGNOSTICS === "1" && existsSync(hostLog)) {
    console.error(`host log:\n${readFileSync(hostLog, "utf8")}`);
  }
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
  expect((await opened("acceptance")).body).toMatchObject({ project: "acceptance" });
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
    `const [popup] = await Promise.all([context.waitForEvent("page"), state.page.click("#open")]); await popup.waitForLoadState(); const [linked] = await Promise.all([context.waitForEvent("page"), state.page.click("#link")]); await linked.waitForLoadState(); return [popup.url(), linked.url()].join(" ")`,
    "--timeout",
    "20000",
  );
  // Both new tabs are announced after the result, since the agent keeps their opener in state.
  const [value, ...notices] = String(result.body.output).split("\n");
  expect(value).toBe(`${origin}/target ${origin}/linked`);
  expect(notices).toHaveLength(2);
  for (const notice of notices)
    expect(notice).toStartWith(`[WARNING] New page opened from ${origin}/`);
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
    `const page = await context.newPage(); await page.goto("${origin}/form"); await page.locator("#text").pressSequentially("typed"); await page.setInputFiles("#file", ${JSON.stringify(upload)}); return [await page.locator("#echo").textContent(), await page.locator("#picked").textContent()].join(" ")`,
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

// Only a person passes a bot check: agent code finds it, hands it to the owner through a Chrome
// notification and sees it solved, without acting inside it.
test("bot checks are reported and handed to the owner", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage();
     await page.route((url) => ["challenges.cloudflare.com", "www.google.com"].includes(url.hostname), (route) => route.fulfill({ contentType: "text/html", body: "<p>check</p>" }));
     await page.goto("${origin}/check");
     await page.frameLocator("iframe").first().locator("p").waitFor();
     const before = await checks(page);
     const notified = await notifyOwner(page, "Pass the check on the fixture");
     await page.evaluate(() => { document.getElementsByName("cf-turnstile-response")[0].value = "passed"; });
     const after = await checks(page);
     const cleared = await clearOwner(page);
     return JSON.stringify({ before, notified: notified.notification.startsWith("owner:"), after, cleared })`,
    "--timeout",
    "20000",
  );
  expect(JSON.parse(String(result.body.output))).toEqual({
    before: [{ vendor: "cloudflare", solved: false }],
    notified: true,
    after: [{ vendor: "cloudflare", solved: true }],
    cleared: {},
  });
});

// The agent helpers: load detection, snapshots with refs, searches and diffs, page logs, element
// inspection, and the page errors and new tabs reported with a result.
test("agent helpers observe a page and report its errors and new tabs", async () => {
  await opened("helpers");
  try {
    await helpers();
  } finally {
    await cli("session", "close", "helpers", "--close-tabs");
  }
});

async function helpers(): Promise<void> {
  const result = await run(
    "helpers",
    `const page = await context.newPage(); state.page = page; await page.goto("${origin}/helpers");
     const loaded = await waitForPageLoad({ page, timeout: 5000 });
     const first = await snapshot({ page });
     const again = await snapshot({ page });
     const found = await snapshot({ page, search: /button/ });
     const save = first.match(/button "Save" \\[ref=(e\\d+)\\]/)[1];
     await page.locator(refToLocator({ ref: save })).click();
     const changed = await snapshot({ page });
     const logs = getLatestLogs({ page, sinceLastCall: true });
     const none = getLatestLogs({ page, sinceLastCall: true });
     const box = await inspect({ locator: page.locator("#box") });
     const input = await inspect({ locator: page.locator("#name") });
     await page.click("#fail"); await page.click("#pop"); await page.waitForTimeout(500);
     return JSON.stringify({ loaded: loaded.success, first, again, found, changed, logs, none, box, input })`,
    "--timeout",
    "20000",
  );
  const [json = "{}", ...notices] = String(result.body.output).split("\n");
  const seen = JSON.parse(json) as Record<string, string | boolean>;
  expect(seen.loaded).toBe(true);
  expect(seen.first).toStartWith(`URL: ${origin}/helpers\n\n`);
  expect(seen.again).toBe(`URL: ${origin}/helpers\n\nNo changes since last call`);
  expect(seen.found).toContain('button "Save"');
  expect(seen.found).not.toContain("link");
  expect(seen.changed).toContain("+ ");
  expect(seen.changed).toContain('"Saved"');
  expect(seen.logs).toContain("[log] loaded helpers");
  expect(seen.none).toBe("No new logs since last call");
  expect(seen.box).toMatch(/Scroll Y: size=\d+ client=50 overflowing=true/);
  expect(seen.input).toContain('Input: value="x"');
  expect(seen.input).toContain("Aria: aria-label=Name");
  expect(notices.some((line) => line.startsWith("[PAGE ERROR]") && line.includes("boom"))).toBe(
    true,
  );
  expect(notices.some((line) => line.startsWith("[WARNING] New page opened"))).toBe(true);
}

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
  // Agent code joins with "/", which Windows accepts beside its own separator.
  const path = resolve(String(result.body.output));
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

test("a client that disconnects mid-run cancels it and frees the session", async () => {
  const page = await observed("/");
  const before = await page?.locator("#c").textContent();
  expect((await run("acceptance", "state.value = 7")).code).toBe(0);
  const client = Bun.spawn(
    [
      binary,
      "-s",
      "acceptance",
      "-e",
      `await new Promise((done) => setTimeout(done, 3000)); await context.pages().find((candidate) => candidate.url().endsWith("/")).click("#inc")`,
      "--timeout",
      "20000",
    ],
    { env, stdout: "ignore", stderr: "ignore" },
  );
  await Bun.sleep(500);
  client.kill("SIGKILL");
  await client.exited;
  // The host drops the run with its client, which kills the session's executor.
  let executors = processes(cdpEndpoint);
  for (let attempt = 0; attempt < 50 && executors.length > 0; attempt++) {
    await Bun.sleep(100);
    executors = processes(cdpEndpoint);
  }
  expect(executors).toEqual([]);
  expect((await run("acceptance", "state.value === undefined")).body.output).toBe("true");
  await Bun.sleep(3000);
  expect(await page?.locator("#c").textContent()).toBe(before ?? "");
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
  const reopened = await opened("acceptance");
  expect(reopened.body).toMatchObject({ project: "acceptance" });
  expect(Number(reopened.body.tabs)).toBeGreaterThan(0);
  const result = await run("acceptance", "context.pages().map((page) => page.url()).sort()");
  expect(result.body.output).toContain(`${origin}/`);
});

test("a lost host is replaced and the agent group is reclaimed without owner tabs", async () => {
  const owner = await observed("/owner");
  expect(owner).toBeDefined();
  const leftover = join(runtime, "sessions", "acceptance", "before-loss.png");
  const written = await run(
    "acceptance",
    `await context.pages()[0].screenshot({ path: artifacts + "/before-loss.png" }); return "written"`,
    "--timeout",
    "20000",
  );
  expect(written.body.output).toBe("written");
  expect(existsSync(leftover)).toBe(true);
  // Only the host runs from the installed prefix; cmd starts a Windows host by its wrapper.
  const hostCommand = windows ? hostBinary : `${hostBinary} chrome-extension://`;
  const [lost, ...others] = processes(hostCommand);
  expect(lost).toBeNumber();
  expect(others).toEqual([]);
  process.kill(lost as number, "SIGKILL");
  // The extension sees its port close, releases the agent tabs and starts a new host.
  let status: Result | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    await Bun.sleep(100);
    status = await cli("status");
    if (status.code === 0 && status.body.enabled === true) break;
  }
  expect(status?.body.enabled).toBe(true);
  const [replacement, ...extra] = processes(hostCommand);
  expect(replacement).not.toBe(lost);
  expect(extra).toEqual([]);
  // No executor outlives its host, and the dead host's artifacts are gone.
  expect(processes(cdpEndpoint)).toEqual([]);
  expect(existsSync(leftover)).toBe(false);
  const reopened = await opened("acceptance");
  expect(Number(reopened.body.tabs)).toBeGreaterThan(0);
  const reclaimed = await run(
    "acceptance",
    "[state.value === undefined, ...context.pages().map((page) => page.url())].join(' ')",
  );
  expect(reclaimed.body.output).toStartWith("true ");
  expect(reclaimed.body.output).toContain(`${origin}/`);
  expect(reclaimed.body.output).not.toContain("/owner");
  expect(owner?.url()).toBe(`${origin}/owner`);
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

// The extension reloads itself when its installed files are newer, which ends
// this host. Chrome for Testing disables command-line extensions on reload, so
// the reloaded build itself is verified in a Load-unpacked browser.
test("an updated install asks the unpacked extension to reload", async () => {
  const manifestPath = join(installed, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect((await cli("status")).body.extension).toBe(manifest.version);
  expect((await cli("update")).body).toEqual({ reload: false });
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "9.9.9" }));
  expect((await cli("update")).body).toEqual({ reload: true });
  let status: unknown;
  for (let attempt = 0; attempt < 50 && status !== "unavailable"; attempt++) {
    await Bun.sleep(100);
    status = (await cli("status")).body.error;
  }
  expect(status).toBe("unavailable");
  expect(readFileSync(hostLog, "utf8")).toContain('"error.type":"extension_closed"');
});

test("browser exit leaves no host or sockets", async () => {
  await observer.close();
  await Bun.sleep(500);
  const status = await cli("status");
  expect(status).toEqual({ code: 2, body: expect.objectContaining({ error: "unavailable" }) });
  expect(present(join(runtime, "control.sock"))).toBe(false);
  expect(present(join(runtime, "cdp.sock"))).toBe(false);
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
    "browser.extension.reload",
    "browser.execute.cancelled",
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
