// Real-browser acceptance for ADR 0015. It launches an isolated Chrome for
// Testing profile with the unpacked NDS extension, registers the built host
// for that profile only and drives the agent CLI against a local fixture.
// A separate Playwright pipe connection observes the browser independently.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

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

// A session's area: on disk under the state directory, in this host's own root, named by its
// runtime directory (runtime::sessions_directory).
function area(project: string): string {
  const state = windows
    ? join(process.env.LOCALAPPDATA ?? "", "nds-browser-use")
    : join(root, "state", "nds-browser-use");
  const key = createHash("sha256").update(runtime).digest("hex").slice(0, 16);
  return join(state, "sessions", key, project);
}

const profile = join(root, "profile");
// The same layout `just install` creates: the host finds its extension files
// next to `bin/`, so an update can reload the unpacked build.
const prefix = join(root, "prefix");
const hostBinary = join(prefix, "bin", windows ? "nds-browser-use.exe" : "nds-browser-use");
const installed = join(prefix, "extension");
// Another extension that injects its own page as a frame, as password managers do.
const foreign = join(repository, "e2e/foreign-extension");
const hostLog = join(root, "host.log");
const extensionId = "lcdkocghcaakekcaeopjanfbohpfacbk";
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  NDS_BROWSER_USE_RUNTIME_DIR: runtime,
};

let observer: BrowserContext;
// A plain CDP client of the test browser, there only to give downloads back their default
// behavior, which Playwright's observer replaced with its own folder and file names.
let defaults: Browser | undefined;
const downloadsFolder = join(root, "downloads");
// The CLI's configuration directory, beside the host configuration that `install` wrote.
let configuration: string;
let fixture: ReturnType<typeof Bun.serve>;
let origin: string;
let requests = 0;
const served = { once: 0 };

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

// The part of the extension API the popup page's evaluations use.
type ChromeTabs = {
  tabs: {
    query(info: object): Promise<{ id?: number; url?: string }[]>;
    getCurrent(): Promise<{ id?: number } | undefined>;
  };
};

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

// An execution's protocol answer, with its text split the way an agent reads it: `value` is what
// the code returned and `notices` the warnings and page errors printed before it.
async function run(project: string, code: string, ...flags: string[]): Promise<Result> {
  const result = await cli("-s", project, "-e", code, "--json", ...flags);
  const output = typeof result.body.output === "string" ? result.body.output : "";
  const marker = output.lastIndexOf("[return value] ");
  result.body.value = marker < 0 ? undefined : output.slice(marker + "[return value] ".length);
  result.body.notices = output
    .split("\n")
    .filter((line) => line.startsWith("[WARNING]") || line.startsWith("[PAGE ERROR]"));
  return result;
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

async function observation(profile: "full" | "standard" | "off"): Promise<void> {
  const page = await observer.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator(`button[data-profile="${profile}"]`).click();
  await page.waitForFunction((expected) => document.body.dataset.observation === expected, profile);
  await page.close();
  for (
    let attempt = 0;
    attempt < 100 && (await cli("status")).body.observation !== profile;
    attempt++
  ) {
    await Bun.sleep(50);
  }
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
      const path = new URL(request.url).pathname;
      // Downloads: a file only the page's cookie opens, one behind a redirect to another site, and
      // one a form's POST answers.
      const attachment = (body: BodyInit, name: string) =>
        new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${name}"`,
          },
        });
      if (path === "/files/bytes") {
        return request.headers.get("cookie")?.includes("nds-e2e=1")
          ? attachment(
              Uint8Array.from({ length: 1024 }, (_, index) => index % 256),
              "bytes.bin",
            )
          : new Response("no cookie", { status: 403 });
      }
      if (path === "/files/moved") {
        return Response.redirect(`http://localhost:${fixture?.port}/files/plain`, 302);
      }
      if (path === "/files/plain") return attachment("moved body", "moved.txt");
      if (path === "/api/journal") {
        return Response.json({ order: 7, items: ["shoe"], accessToken: "tok-should-not-stay" });
      }
      // Served once, as a signed link that expires on first use.
      if (path === "/files/once") {
        served.once += 1;
        return served.once === 1
          ? attachment("once body", "once.txt")
          : new Response("gone", { status: 410 });
      }
      if (path === "/files/post") {
        return request.method === "POST"
          ? attachment("posted body", "posted.txt")
          : new Response("post only", { status: 405 });
      }
      const page: Record<string, string> = {
        "/": `<title>Fixture</title><button id="inc" onclick="c.textContent = Number(c.textContent) + 1">Increment</button><span id="c">0</span><button id="open" onclick="window.open('/target')">Open</button><a id="link" href="/linked" target="_blank">Linked</a><button id="window" onclick="window.open('/target?window', 'signin', 'width=480,height=600')">Window</button>`,
        "/linked": "<title>Linked</title><p>linked</p>",
        "/target": "<title>Popup target</title><p>popup</p>",
        "/owner": "<title>Owner</title><p>owner work</p>",
        "/foreign": "<title>Foreign host</title><p>a page another extension adds its frame to</p>",
        "/owned": "<title>Owned</title><p>owned work</p>",
        "/dialog": `<button id="ask" onclick="answer.textContent = confirm('Proceed?') ? 'accepted' : 'dismissed'">Ask</button><span id="answer"></span>`,
        "/form": `<input id="text" oninput="echo.textContent = this.value"><span id="echo"></span><input id="file" type="file" onchange="picked.textContent = this.files[0].name + ':' + this.files[0].size"><span id="picked"></span>`,
        "/fetch": `<button id="load" onclick="fetch('/api').then((r) => r.text()).then((t) => (out.textContent = t))">Load</button><span id="out"></span>`,
        "/api": "live",
        // The page revokes its blob URL later, as FileSaver does.
        // The blob button revokes its URL at once, the tab link and window.open open the file in a
        // new tab, and the frame of another site offers its own link.
        "/files": `<title>Files</title><a id="bytes" href="/files/bytes">Bytes</a><a id="moved" href="/files/moved">Moved</a><a id="once" href="/files/once">Once</a><form method="post" action="/files/post"><button id="post">Post</button></form><button id="blob" onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['blob body'])); a.download = 'made.txt'; a.click(); window.URL.revokeObjectURL(a.href)">Blob</button><a id="tab" href="/files/plain" target="_blank">Tab</a><button id="open" onclick="window.open('/files/once')">Open</button><iframe src="http://localhost:${fixture?.port}/files-frame"></iframe>`,
        "/files-frame": `<a id="inner" href="/files/plain">Inner</a>`,
        // A tone the page plays through Web Audio once a button is pressed.
        "/tone": `<title>Tone</title><button id="tone" onclick="const audio = new AudioContext(); const tone = audio.createOscillator(); tone.frequency.value = 440; tone.connect(audio.destination); tone.start()">Tone</button>`,
        // A form for the recorder: a password field whose label names no secret, and a status
        // region that announces the save.
        "/record": `<title>Record</title><input id="name" aria-label="Name"><input id="word" type="password" aria-label="Kennwort"><button id="save" onclick="document.getElementById('status').textContent = 'Saved ' + document.getElementById('name').value">Save</button><div role="status" id="status"></div>`,
        // A page whose script calls the site's API, logs the same error twice and throws.
        "/journal": `<title>Journal</title><input id="email" aria-label="Email"><input id="password" type="password" aria-label="Password"><script>fetch('/api/journal?id=7&token=abc').then((r) => r.json()); console.error('cart failed'); console.error('cart failed'); setTimeout(() => { throw new Error('late boom') });</script>`,
        // A different site (localhost vs 127.0.0.1) renders out of process.
        "/frame": `<iframe src="http://localhost:${fixture?.port}/inner"></iframe>`,
        "/inner": `<button id="inner" onclick="this.textContent = 'inside'">Inner</button>`,
        // Disclosures inside nested wrappers, one named by its text and one by its label.
        "/disclosure": `<title>Disclosure</title><main><div><div><details><summary>Where should I start?</summary><p>Here.</p></details><div><details><summary aria-label="Language: EN">EN</summary><p>English</p></details></div></div></div></main>`,
        // Equal buttons in two parts, and a frame of the same site, which shares the process.
        "/refs": `<title>Refs</title><section id="first"><button onclick="out.textContent = 'first'">Save</button></section><section id="second"><button onclick="out.textContent = 'second'">Save</button></section><span id="out"></span><iframe id="same" src="/inner"></iframe>`,
        "/article": `<title>Fixture article</title><style>p { color: black }</style><script>window.unused = 1</script><nav><a href="/">Home</a></nav><article><h1>Fixture heading</h1><p>First. This paragraph is the main content of the fixture article and is long enough for Readability. This paragraph is the main content of the fixture article and is long enough for Readability. This paragraph is the main content of the fixture article and is long enough for Readability. This paragraph is the main content of the fixture article and is long enough for Readability. </p><p>Second. This paragraph is the main content of the fixture article and is long enough for Readability. This paragraph is the main content of the fixture article and is long enough for Readability. This paragraph is the main content of the fixture article and is long enough for Readability. This paragraph is the main content of the fixture article and is long enough for Readability. </p><ul><li>One point</li><li>Two points</li></ul><button id="go">Go</button></article>`,
        "/devtools": [
          "<title>Devtools</title><style>.card { color: rgb(1, 2, 3); padding: 4px }</style>",
          '<div class="card" id="card">Card</div>',
          "<script>",
          "function compute(x) {",
          "  const doubled = x * 2;",
          "  return doubled;",
          "}",
          "function answer() { return 1; }",
          "window.compute = compute; window.answer = answer;",
          "</script>",
        ].join("\n"),
        "/helpers": `<title>Helpers</title><script>console.log("loaded helpers")</script><main><button id="save" onclick="this.textContent = 'Saved'">Save</button><button id="fail" onclick="setTimeout(() => { throw new Error('boom') })">Fail</button><a id="pop" href="/linked" target="_blank">Pop</a><div id="box" style="overflow-y: auto; height: 50px"><p style="height: 200px">tall</p></div><input id="name" value="x" aria-label="Name"></main>`,
        // A Turnstile widget with its response field, and reCAPTCHA's invisible badge, which is no
        // check a person passes; the test routes both vendors' frames.
        "/check": `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/e2e/0x4AAAAAAA/auto/normal" width="300" height="65"></iframe><iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=e2e&size=invisible" width="256" height="60"></iframe><input type="hidden" name="cf-turnstile-response" value="">`,
        // WebAuthn needs a domain RP ID; localhost is a secure context.
        "/passkey": `<button id="register" onclick="navigator.credentials.create({ publicKey: { rp: { name: 'NDS', id: 'localhost' }, user: { id: new Uint8Array(16), name: 'agent', displayName: 'Agent' }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } }).then(() => (outcome.textContent = 'registered'), (e) => (outcome.textContent = e.name))">Register</button><button id="signin" onclick="navigator.credentials.get({ publicKey: { rpId: 'localhost', challenge: new Uint8Array(32), userVerification: 'required' } }).then(() => (outcome.textContent = 'signed-in'), (e) => (outcome.textContent = e.name))">Sign in</button><span id="outcome"></span>`,
      };
      const body = page[path];
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
  cpSync(join(repository, "packages/desktop/extension"), installed, { recursive: true });
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
  configuration = dirname(String(registration.body.config));
  const manifest = String(registration.body.manifest);
  const registered = JSON.parse(readFileSync(manifest, "utf8"));
  expect(registered.allowed_origins).toEqual([
    `chrome-extension://${extensionId}/`,
    "chrome-extension://lpnfnhkdjamhnoknoohhmjfhhjkeofio/",
  ]);
  writeFileSync(manifest, JSON.stringify({ ...registered, path: wrapper }));
  // Downloads go to the profile's own folder under the names sites suggest, as in the owner's
  // browser, never into the home of whoever runs the tests.
  mkdirSync(join(profile, "Default"), { recursive: true });
  mkdirSync(downloadsFolder, { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      download: { default_directory: downloadsFolder, prompt_for_download: false },
      savefile: { default_directory: downloadsFolder },
    }),
  );
  observer = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: true,
    env,
    // Tabs keep their window's own size, as in the owner's browser: the observer emulates none.
    viewport: null,
    args: [
      "--remote-debugging-port=0",
      `--disable-extensions-except=${installed},${foreign}`,
      `--load-extension=${installed},${foreign}`,
      ...(process.env.NDS_E2E_DIAGNOSTICS === "1" ? ["--enable-logging=stderr"] : []),
    ],
  });
  const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  defaults = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await (await defaults.newBrowserCDPSession()).send("Browser.setDownloadBehavior", {
    behavior: "default",
  });
  // Only the setting is needed; the client itself would watch every tab beside the observer.
  await defaults.close();
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
  await defaults?.close().catch(() => undefined);
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
  expect(result.body.value).toBe("1");
  expect(tabs(result)).toEqual([expect.objectContaining({ url: `${origin}/` })]);
  expect(requests).toBeGreaterThan(before);
  const page = await observed("/");
  expect(await page?.locator("#c").textContent()).toBe("1");
});

test("owner tabs stay outside the agent session", async () => {
  const owner = await observer.newPage();
  await owner.goto(`${origin}/owner`);
  const result = await run("acceptance", "context.pages().map((page) => page.url())");
  expect(result.body.value).not.toContain("/owner");
  expect(tabs(result).map((tab) => tab.url)).not.toContain(`${origin}/owner`);
  expect(owner.url()).toBe(`${origin}/owner`);
});

test("session state and the aria snapshot are available between runs", async () => {
  expect((await run("acceptance", "state.value = 41")).code).toBe(0);
  expect((await run("acceptance", "state.value + 1")).body.value).toBe("42");
  const snapshot = await run("acceptance", "snapshot(state.page)");
  expect(snapshot.body.value).toContain('button "Increment"');
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
  expect(fresh.body.value).toBe("2");
});

test("popups opened by an agent page join the agent session", async () => {
  const result = await run(
    "acceptance",
    `const [popup] = await Promise.all([context.waitForEvent("page"), state.page.click("#open")]); await popup.waitForLoadState(); const [linked] = await Promise.all([context.waitForEvent("page"), state.page.click("#link")]); await linked.waitForLoadState(); return [popup.url(), linked.url()].join(" ")`,
    "--timeout",
    "20000",
  );
  // Both new tabs are announced before the result, since the agent keeps their opener in state.
  const notices = result.body.notices as string[];
  expect(result.body.value).toBe(`${origin}/target ${origin}/linked`);
  expect(notices).toHaveLength(2);
  for (const notice of notices)
    expect(notice).toStartWith(`[WARNING] New page opened from ${origin}/`);
  const popup = tabs(result).find((tab) => tab.url === `${origin}/target`);
  expect(popup?.document).toBeString();
});

// A sign-in button opens its own popup window, which can hold no tab group; it joins the agent's
// group as a tab of its opener's window.
test("a popup window an agent page opens becomes an agent tab", async () => {
  const result = await run(
    "acceptance",
    `const [popup] = await Promise.all([context.waitForEvent("page"), state.page.click("#window")]); await popup.waitForLoadState(); state.signin = popup; return JSON.stringify({ url: popup.url(), opener: await popup.evaluate(() => window.opener !== null) })`,
    "--timeout",
    "20000",
  );
  expect(JSON.parse(String(result.body.value))).toEqual({
    url: `${origin}/target?window`,
    opener: true,
  });
  // The owner's browser shows it as a tab in the opener's window.
  const windowOf = async (path: string) => {
    const page = await observed(path);
    if (!page) return undefined;
    const cdp = await observer.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.detach();
    return windowId;
  };
  const popupWindow = await windowOf("/target?window");
  expect(popupWindow).toBeNumber();
  expect(popupWindow).toBe(await windowOf("/"));
  expect((await run("acceptance", "await state.signin.close(); delete state.signin")).code).toBe(0);
});

test("the agent answers JavaScript dialogs", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/dialog"); page.once("dialog", (dialog) => dialog.accept()); await page.click("#ask"); return await page.locator("#answer").textContent()`,
    "--timeout",
    "20000",
  );
  expect(result.body.value).toBe("accepted");
  expect(await (await observed("/dialog"))?.locator("#answer").textContent()).toBe("accepted");
});

test("keyboard input and file uploads reach the page", async () => {
  const upload = join(area("acceptance"), "upload.txt");
  writeFileSync(upload, "nds");
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/form"); await page.locator("#text").pressSequentially("typed"); await page.setInputFiles("#file", ${JSON.stringify(upload)}); return [await page.locator("#echo").textContent(), await page.locator("#picked").textContent()].join(" ")`,
    "--timeout",
    "20000",
  );
  expect(result.body.value).toBe("typed upload.txt:3");
});

test("network interception and cross-origin frames work in agent tabs", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.route("**/api", (route) => route.fulfill({ body: "intercepted" })); await page.goto("${origin}/fetch"); await page.click("#load"); await page.locator("#out", { hasText: "intercepted" }).waitFor(); const frames = await context.newPage(); await frames.goto("${origin}/frame"); await frames.frameLocator("iframe").locator("#inner").click(); return [await page.locator("#out").textContent(), await frames.frameLocator("iframe").locator("#inner").textContent()].join(" ")`,
    "--timeout",
    "20000",
  );
  expect(result.body.value).toBe("intercepted inside");
  const frame = (await observed("/frame"))
    ?.frames()
    .find((candidate) => candidate.url().endsWith("/inner"));
  expect(await frame?.locator("#inner").textContent()).toBe("inside");
  // A frame's snapshot works whether the frame shares the page's process or not.
  const snapped = await run(
    "acceptance",
    `const page = context.pages().find((candidate) => candidate.url().endsWith("/frame")); const frame = page.frames().find((candidate) => candidate.url().endsWith("/inner")); return await snapshot({ frame })`,
    "--timeout",
    "15000",
  );
  expect(snapped.body.value).toContain("inside");
  expect(snapped.body.value).not.toContain("[cursor=pointer]");
});

// What a snapshot line or a shown ref names is the element an action reaches: equal locators by
// their nth, a part's and a frame's locators inside it, and the refs of a frame of another
// process and of a labeled screenshot through the frames they are of.
test("snapshot locators and shown refs reach the element their line shows", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/refs");
    const same = page.frames().find((frame) => frame.url().endsWith("/inner"));
    await same.locator("#inner").waitFor();
    const out = () => page.locator("#out").textContent();
    const seen = [];
    const whole = await snapshot({ page });
    seen.push(whole.includes('role=button[name="Save"i] >> nth=1'));
    await page.locator('role=button[name="Save"i] >> nth=1').click();
    seen.push(await out());
    const part = await snapshot({ page, locator: page.locator("#first") });
    seen.push(part.includes("Locators are inside the locator") && !part.includes("nth="));
    await page.locator("#first").locator('role=button[name="Save"i]').click();
    seen.push(await out());
    const framed = await snapshot({ frame: same });
    seen.push(framed.includes("Locators are inside the frame") && framed.includes('[id="inner"]'));
    await same.locator('[id="inner"]').click();
    seen.push(await same.locator("#inner").textContent());
    // A part inside a frame, named through the page or through the frame, shows that part only.
    for (const part of [page.frameLocator("#same").locator("body"), same.locator("#inner")]) {
      const view = await snapshot(part);
      seen.push(view.includes('[id="inner"]') && !view.includes("Save"));
    }
    const shot = await screenshotWithAccessibilityLabels({ page });
    const labels = [...shot.matchAll(/button "Save" \\[ref=([^\\]]+)\\]/g)].map((found) => found[1]);
    await snapshot({ page, showDiffSinceLastCall: false });
    await ref({ page, ref: labels[1] }).click();
    seen.push(labels.length, await out());
    const far = await context.newPage(); await far.goto("${origin}/frame");
    const other = far.frames().find((frame) => frame.url().endsWith("/inner"));
    await other.locator("#inner").waitFor();
    // A part inside a frame of another process: Playwright's snapshot of that part, whose refs
    // enter the frame.
    for (const part of [far.frameLocator("iframe").locator("body"), other.locator("#inner")]) {
      const view = await snapshot(part);
      seen.push(/button "Inner" \\[ref=/.test(view) && !view.includes("iframe"));
    }
    const remote = await snapshot({ frame: other });
    const shown = remote.match(/button "Inner" \\[ref=([^\\]]+)\\]/)?.[1];
    seen.push(Boolean(shown));
    await ref({ page: far, ref: shown }).click();
    seen.push(await other.locator("#inner").textContent());
    await page.close(); await far.close();
    return seen.join(" ")`,
    "--timeout",
    "25000",
  );
  expect(result.body.value).toBe(
    "true second true first true inside true true 2 second true true true inside",
  );
});

// A <summary>, which Playwright's role engine has no role for, shows a locator that opens its
// details; a line is indented only by the lines shown above it.
test("summary lines show locators that open their details", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/disclosure");
    const shown = await snapshot({ page });
    const interactive = await snapshot({ page, interactiveOnly: true, showDiffSinceLastCall: false });
    const start = shown.match(/- disclosuretriangle (summary >> .*)$/m)?.[1];
    const language = shown.match(/- disclosuretriangle (summary\\[aria-label=.*)$/m)?.[1];
    await page.locator(start).click();
    await page.locator(language).click();
    const open = await page.evaluate(() => [...document.querySelectorAll("details")].map((details) => details.open));
    await page.close();
    return JSON.stringify({ shown, interactive, start, language, open })`,
    "--timeout",
    "20000",
  );
  const seen = JSON.parse(String(result.body.value ?? "{}")) as {
    shown: string;
    interactive: string;
    start: string;
    language: string;
    open: boolean[];
  };
  expect(seen.start).toBe('summary >> internal:has-text="Where should I start?"s');
  expect(seen.language).toBe('summary[aria-label="Language: EN"]');
  expect(seen.open).toEqual([true, true]);
  expect(seen.interactive).toContain(seen.start);
  const depths = seen.shown
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.length - line.trimStart().length);
  expect(depths[0]).toBe(0);
  for (const [index, depth] of depths.entries()) {
    expect(depth).toBeLessThanOrEqual((depths[index - 1] ?? 0) + 2);
  }
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
  expect(JSON.parse(String(result.body.value))).toEqual({
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
     const save = first.match(/- button "Save" (\\[id="save"\\])/)[1];
     // Snapshot lines show locators, not refs, so a ref still means Playwright's own.
    const ref = refToLocator({ ref: "e1", page });
     await page.locator(save).click();
     const changed = await snapshot({ page });
     const logs = getLatestLogs({ page, sinceLastCall: true });
     const none = getLatestLogs({ page, sinceLastCall: true });
     const box = await inspect({ locator: page.locator("#box") });
     const input = await inspect({ locator: page.locator("#name") });
     await page.click("#fail"); await page.click("#pop"); await page.waitForTimeout(500);
     return JSON.stringify({ loaded: loaded.success, first, again, found, changed, logs, none, box, input, save, ref })`,
    "--timeout",
    "20000",
  );
  const notices = result.body.notices as string[];
  const seen = JSON.parse(String(result.body.value ?? "{}")) as Record<string, string | boolean>;
  expect(seen.loaded).toBe(true);
  expect(seen.first).toStartWith(`URL: ${origin}/helpers\n\n`);
  expect(seen.again).toBe(`URL: ${origin}/helpers\n\nNo changes since last call`);
  // Interactive lines carry a Playwright locator; short refs name the same elements.
  expect(seen.found).toContain('button "Save" [id="save"]');
  expect(seen.save).toBe('[id="save"]');
  expect(seen.ref).toBe("aria-ref=e1");
  expect(seen.changed).toContain("+ ");
  expect(seen.changed).toContain('"Saved"');
  expect(seen.logs).toContain("[log] loaded helpers");
  // An array, empty when nothing is new.
  expect(JSON.stringify(seen.none)).toBe("[]");
  expect(seen.box).toMatch(/Scroll Y: size=\d+ client=50 overflowing=true/);
  expect(seen.input).toContain('Input: value="x"');
  expect(seen.input).toContain("Aria: aria-label=Name");
  expect(notices.some((line) => line.startsWith("[PAGE ERROR]") && line.includes("boom"))).toBe(
    true,
  );
  expect(notices.some((line) => line.startsWith("[WARNING] New page opened"))).toBe(true);
}

// Content helpers: cleaned HTML, the article as text, a labeled screenshot and its smaller copy,
// and a stable locator string.
test("content helpers read a page and label its interactive elements", async () => {
  await opened("content");
  try {
    await content();
  } finally {
    await cli("session", "close", "content", "--close-tabs");
  }
});

async function content(): Promise<void> {
  const resize = Bun.which("ffmpeg") !== null;
  const result = await run(
    "content",
    `const page = await context.newPage(); await page.goto("${origin}/article");
     const html = await getCleanHTML({ locator: page.locator("article") });
     const text = await getPageMarkdown({ page });
     const shot = await screenshotWithAccessibilityLabels({ page });
     const path = shot.match(/^Screenshot: (\\S+)/)[1];
     const small = ${resize} ? await resizeImageForAgent({ input: path, maxDimension: 320 }) : "";
     const go = await getLocatorStringForElement(page.locator("#go"));
     return JSON.stringify({ html, text, shot, path, small, go })`,
    "--timeout",
    "20000",
  );
  const seen = JSON.parse(String(result.body.value)) as Record<string, string>;
  expect(seen.html).toContain("<h1>");
  expect(seen.html).toContain('<button id="go">');
  expect(seen.html).not.toContain("script");
  expect(seen.text).toContain("Fixture heading");
  expect(seen.text).toContain("First. This paragraph");
  expect(seen.text).toContain("- One point");
  expect(seen.text).not.toContain("Home");
  expect(seen.shot).toMatch(/^Screenshot: \S+\.jpg \([1-9]\d* labels\)/);
  expect(seen.shot).toContain('button "Go" [ref=');
  expect(seen.shot).not.toContain("[box=");
  expect(seen.path?.startsWith(area("content"))).toBe(true);
  expect(existsSync(seen.path ?? "")).toBe(true);
  if (resize) {
    expect(existsSync(seen.small ?? "")).toBe(true);
    expect(statSync(seen.small ?? "").size).toBeLessThan(statSync(seen.path ?? "").size);
  }
  expect(seen.go).toBe('getByRole("button", { name: "Go", exact: true })');
}

// A window that is occluded or not focused gets animation frames about once a second or not at
// all; a snapshot still reads the page at once instead of waiting for them.
test("a snapshot does not wait on animation frames the window does not get", async () => {
  await opened("frames");
  try {
    const result = await run(
      "frames",
      `const page = await context.newPage();
       await page.setContent('<main><h1>Frames</h1><button>Go</button></main>');
       await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
       const started = Date.now();
       const view = await snapshot({ page });
       const spent = Date.now() - started;
       await page.close();
       return JSON.stringify({ spent, button: view.includes('role=button[name="Go"i]') })`,
      "--timeout",
      "15000",
    );
    const seen = JSON.parse(String(result.body.value)) as { spent: number; button: boolean };
    expect(seen.button).toBe(true);
    expect(seen.spent).toBeLessThan(1000);
  } finally {
    await cli("session", "close", "frames", "--close-tabs");
  }
});

// A locator that matches several elements fails with Playwright's strict mode error, which lists
// every match with a locator of its own; the result keeps that list.
test("a strict mode violation lists every match so the agent can pick one", async () => {
  await opened("strict");
  try {
    const result = await run(
      "strict",
      `const page = await context.newPage();
       await page.setContent('<div role="dialog"><button>From</button><button>Send</button><button>Discard</button></div>');
       try { await page.locator("[role=dialog] button").click({ timeout: 1000 }); return "clicked"; }
       finally { await page.close(); }`,
    );
    const text = String(result.body.output ?? "");
    expect(text).toContain("strict mode violation");
    expect(text).toContain("resolved to 3 elements");
    for (const name of ["From", "Send", "Discard"]) {
      expect(text).toContain(`getByRole('button', { name: '${name}' })`);
    }
  } finally {
    await cli("session", "close", "strict", "--close-tabs");
  }
});

// Recordings: screencast frames to video through ffmpeg with a ghost cursor, and a demo cut that
// speeds up the time between executions. Skipped without ffmpeg.
test.skipIf(Bun.which("ffmpeg") === null)(
  "recordings capture agent work as video and a demo cut",
  async () => {
    await opened("recording");
    try {
      await recorded();
    } finally {
      await cli("session", "close", "recording", "--close-tabs");
    }
  },
  60_000,
);

async function recorded(): Promise<void> {
  const started = await run(
    "recording",
    `const page = await context.newPage(); state.page = page; await page.goto("${origin}/?recording");
     state.path = artifacts + "/work.mp4";
     await recording.start({ page, outputPath: state.path });
     await page.mouse.move(120, 80); await page.click("#inc"); await page.waitForTimeout(1200);
     return recording.isRecording({ page })`,
  );
  expect(started.body.value).toBe("true");
  expect(await (await observed("/?recording"))?.locator("#nds-ghost-cursor").count()).toBe(1);
  const stopped = await run(
    "recording",
    `await state.page.click("#inc"); await state.page.waitForTimeout(600);
     state.result = await recording.stop({ page: state.page });
     return JSON.stringify(state.result)`,
  );
  const result = JSON.parse(String(stopped.body.value)) as {
    path: string;
    duration: number;
    size: number;
    executionTimestamps: { start: number; end: number }[];
  };
  expect(result.size).toBeGreaterThan(0);
  expect(result.executionTimestamps.length).toBeGreaterThanOrEqual(1);
  const seconds = (path: string) =>
    Number(
      Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        path,
      ]).stdout.toString(),
    );
  expect(seconds(result.path)).toBeGreaterThan(1);
  // The cut can outlast one execution, so it is kept in state and awaited.
  await run(
    "recording",
    `state.demo = createDemoVideo({ recordingPath: state.result.path, durationMs: state.result.duration, executionTimestamps: state.result.executionTimestamps, speed: 8 }); return 1`,
  );
  const demo = String(
    (await run("recording", "await state.demo", "--timeout", "20000")).body.value,
  );
  expect(existsSync(demo)).toBe(true);
  expect(seconds(demo)).toBeLessThan(seconds(result.path));

  // A page that never repaints still gets frames, and a resized viewport keeps one frame size.
  const still = await run(
    "recording",
    `const page = await context.newPage(); await page.setContent("<body style='background:#c33'>Static</body>");
     const path = artifacts + "/still.mp4";
     await recording.start({ page, outputPath: path });
     await page.waitForTimeout(400);
     await page.setViewportSize({ width: 640, height: 900 });
     await page.waitForTimeout(400);
     const done = await recording.stop({ page }); await page.close();
     return done.path`,
    "--timeout",
    "20000",
  );
  const probe = Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=width,height,sample_aspect_ratio,nb_read_frames",
    "-of",
    "json",
    String(still.body.value),
  ]);
  const streams = JSON.parse(probe.stdout.toString()).streams as {
    width: number;
    height: number;
    sample_aspect_ratio?: string;
    nb_read_frames: string;
  }[];
  expect(streams).toHaveLength(1);
  expect(Number(streams[0]?.nb_read_frames)).toBeGreaterThan(0);
  expect(streams[0]?.sample_aspect_ratio ?? "1:1").toBe("1:1");
  expect((streams[0]?.width ?? 1) % 2).toBe(0);
}

// Recordings: a handle to keep, a manual clock that films only `wait(ms)`, a
// file that appears complete, other containers, another tab mid-recording, a viewport fitted to
// an aspect ratio and restored, and the page's own sound. Skipped without ffmpeg.
test.skipIf(Bun.which("ffmpeg") === null)(
  "recordings film the manual clock, move between tabs and keep the page's sound",
  async () => {
    await opened("filming");
    const probe = (path: string, entries: string) =>
      JSON.parse(
        Bun.spawnSync([
          "ffprobe",
          "-v",
          "error",
          "-show_entries",
          entries,
          "-of",
          "json",
          path,
        ]).stdout.toString(),
      ) as { format?: { duration?: string }; streams?: Record<string, unknown>[] };
    try {
      const manual = await run(
        "filming",
        `const fs = require("node:fs");
         const page = await context.newPage(); await page.goto("${origin}/?manual");
         const path = artifacts + "/manual.webm";
         const handle = await recording.start({ page, outputPath: path, clock: "manual" });
         const before = fs.existsSync(path);
         await page.waitForTimeout(1500);
         await handle.wait(1000);
         await page.waitForTimeout(800);
         const done = await handle.stop(); await page.close();
         return JSON.stringify({ before, path: done.path, clock: handle.clock, recording: handle.isRecording })`,
        "--timeout",
        "20000",
      );
      expect(manual.body).toMatchObject({ failure: null });
      const filmed = JSON.parse(String(manual.body.value));
      expect(filmed).toMatchObject({ before: false, clock: "manual", recording: false });
      const webm = probe(filmed.path, "format=duration:stream=codec_name");
      expect(Number(webm.format?.duration)).toBeGreaterThan(0.8);
      expect(Number(webm.format?.duration)).toBeLessThan(1.5);
      expect(webm.streams?.[0]?.codec_name).toBe("vp8");

      const moved = await run(
        "filming",
        `const first = await context.newPage(); await first.goto("${origin}/?first");
         const second = await context.newPage(); await second.goto("${origin}/linked");
         const inner = (page) => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
         const size = await inner(first);
         const handle = await recording.start({ page: first, outputPath: artifacts + "/moved.mp4", aspectRatio: { width: 1, height: 1 } });
         const fitted = await inner(first);
         await first.waitForTimeout(600);
         await handle.setPage(second);
         const back = await inner(first);
         const square = await inner(second);
         await second.waitForTimeout(600);
         const done = await handle.stop();
         const after = await inner(second);
         await first.close(); await second.close();
         return JSON.stringify({ size, fitted, back, square, after, page: handle.page === second, path: done.path })`,
        "--timeout",
        "20000",
      );
      expect(moved.body).toMatchObject({ failure: null });
      const switched = JSON.parse(String(moved.body.value));
      expect(switched.fitted.width).toBe(switched.fitted.height);
      expect(switched.back).toEqual(switched.size);
      expect(switched.square.width).toBe(switched.square.height);
      expect(switched.after).toEqual(switched.size);
      expect(switched.page).toBe(true);
      const mp4 = probe(switched.path, "format=duration:stream=width,height");
      expect(Number(mp4.format?.duration)).toBeGreaterThan(1);
      expect(mp4.streams?.[0]?.width).toBe(mp4.streams?.[0]?.height);

      const sound = await run(
        "filming",
        `const page = await context.newPage(); await page.goto("${origin}/tone");
         const handle = await recording.start({ page, outputPath: artifacts + "/tone.mp4", audio: true });
         await page.click("#tone");
         await page.waitForTimeout(2000);
         const done = await handle.stop(); await page.close();
         return done.path`,
        "--timeout",
        "20000",
      );
      expect(sound.body).toMatchObject({ failure: null });
      const audio = probe(String(sound.body.value), "stream=codec_type,codec_name");
      expect(audio.streams?.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
      const volume = Bun.spawnSync([
        "ffmpeg",
        "-hide_banner",
        "-i",
        String(sound.body.value),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ]).stderr.toString();
      const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(volume)?.[1] ?? "-91");
      expect(peak).toBeGreaterThan(-30);
    } finally {
      await cli("session", "close", "filming", "--close-tabs");
    }
  },
  90_000,
);

// DevTools helpers over raw CDP: matched CSS rules, a live script edit, and a breakpoint with its
// local variables and an expression evaluated in the paused frame.
test("devtools helpers style, edit and debug an agent page", async () => {
  await opened("devtools");
  try {
    const result = await run(
      "devtools",
      `const page = await context.newPage(); await page.goto("${origin}/devtools");
       const cdp = await getCDPSession({ page });
       const styles = formatStylesAsText(await getStylesForLocator({ locator: page.locator("#card"), cdp }));
       const editor = createEditor({ cdp, page }); await editor.enable();
       const [rule] = await editor.grep({ regex: /color: rgb\\(1, 2, 3\\)/ });
       await editor.edit({ url: rule.url, oldString: "rgb(1, 2, 3)", newString: "rgb(9, 9, 9)" });
       const restyled = await page.evaluate(() => getComputedStyle(document.getElementById("card")).color);
       const [hit] = await editor.grep({ regex: /return 1;/ });
       const refused = await editor.edit({ url: hit.url, oldString: "return 1;", newString: "return 2;" }).then(() => "", (error) => error.message);
       await editor.override({ url: page.url(), oldString: "return 1;", newString: "return 2;" });
       await page.reload();
       const edited = await page.evaluate(() => answer());
       const dbg = createDebugger({ cdp: await getCDPSession({ page }) }); await dbg.enable();
       await dbg.setBreakpoint({ file: page.url(), line: 5 });
       const pending = page.evaluate(() => compute(21));
       for (let i = 0; i < 50 && !dbg.isPaused(); i++) await new Promise((done) => setTimeout(done, 50));
       const location = dbg.getLocation();
       const locals = await dbg.inspectLocalVariables();
       const tripled = await dbg.evaluate({ expression: "x * 3" });
       await dbg.resume();
       const computed = await pending;
       const react = await getReactComponentInfo({ locator: page.locator("#card") });
       return JSON.stringify({ styles, restyled, refused, edited, location, locals, tripled, computed, react })`,
      "--timeout",
      "20000",
    );
    const seen = JSON.parse(String(result.body.value)) as Record<string, unknown>;
    expect(seen.styles).toContain(".card");
    expect(seen.styles).toContain("color: rgb(1, 2, 3)");
    expect(seen.restyled).toBe("rgb(9, 9, 9)");
    expect(seen.refused).toContain("override()");
    expect(seen.edited).toBe(2);
    expect(seen.location).toMatchObject({ functionName: "compute", line: 5 });
    expect(seen.locals).toMatchObject({ x: "21" });
    expect(seen.tripled).toBe(63);
    expect(seen.computed).toBe(42);
    expect(seen.react).toBeNull();
  } finally {
    await cli("session", "close", "devtools", "--close-tabs");
  }
});

// The recorder: a person acts in an agent tab, and the agent reads Playwright's codegen of each
// action, the status message the page announced and a frame of the screen. A value typed into a
// password field is never kept, whatever its label says.
test("the recorder turns a person's actions in an agent tab into events and frames", async () => {
  await opened("recorder");
  try {
    const started = await run(
      "recorder",
      `const page = await context.newPage(); await page.goto("${origin}/record"); return JSON.stringify(await recorder.start())`,
    );
    expect(started.body).toMatchObject({ failure: null });
    expect(JSON.parse(String(started.body.value)).path).toStartWith(area("recorder"));
    // The CLI's recorder commands are the helper's calls.
    const status = await plain("-s", "recorder", "recorder", "status");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("recordings");
    const tab = await observed("/record");
    await tab?.fill("#name", "Ada");
    await tab?.fill("#word", "hunter2");
    await tab?.click("#save");
    await tab?.locator("#name").press("Tab");
    await Bun.sleep(1500);
    const stopped = await run("recorder", `return JSON.stringify(await recorder.stop())`);
    expect(stopped.body).toMatchObject({ failure: null });
    expect(JSON.parse(String(stopped.body.value)).frames).toBeGreaterThan(0);
    const listed = await plain("-s", "recorder", "recorder", "events");
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain("hunter2");
    const events = listed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const actions = events.filter((event) => event.type === "person-action");
    expect(actions.map((event) => [event.action, event.value ?? event.key ?? null])).toEqual([
      ["fill", "Ada"],
      ["fill", "[redacted]"],
      ["click", null],
      ["press", "Tab"],
    ]);
    expect(String(actions[2]?.code)).toBe(
      "await page.getByRole('button', { name: 'Save' }).click();",
    );
    expect(String(actions[2]?.aria)).toContain('textbox "Name" [ref=e2]: Ada');
    expect(String(actions[2]?.aria)).toContain('textbox "Kennwort" [ref=e3]: [redacted]');
    expect(String(actions[1]?.code)).not.toContain("hunter2");
    expect(events.some((event) => event.type === "toast" && event.text === "Saved Ada")).toBe(true);
    const frame = await plain(
      "-s",
      "recorder",
      "recorder",
      "frame",
      String(actions[2]?.seq),
      "--offset",
      "1000",
    );
    expect(frame.code).toBe(0);
    expect(existsSync(frame.stdout.trim())).toBe(true);
    // The same reading in agent code.
    const inCode = await run(
      "recorder",
      `return (await recorder.events({ type: "person-action" })).split("\\n").length`,
    );
    expect(inCode.body.value).toBe("4");
    expect((await plain("-s", "recorder", "recorder", "status")).stdout).toBe(
      "[return value] null\n",
    );
    expect((await plain("-s", "recorder", "recorder", "pause")).code).toBe(2);
  } finally {
    await cli("session", "close", "recorder", "--close-tabs");
  }
});

// The owner starts and stops the recorder from the extension's popup, for the agent group of
// their tab; the agent then reads the steps.
test("the owner records their actions for the agent from the popup", async () => {
  await opened("showme");
  try {
    const opened = await run(
      "showme",
      `state.page = await context.newPage(); await state.page.goto("${origin}/record?owner"); return "ok"`,
    );
    expect(opened.body.value).toBe("ok");
    const popup = await observer.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const tab = await popup.evaluate(async (url) => {
      const tabs = (globalThis as unknown as { chrome: ChromeTabs }).chrome.tabs;
      return (await tabs.query({})).find((each) => each.url === url)?.id;
    }, `${origin}/record?owner`);
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tab}`);
    await popup.waitForFunction(() => document.body.dataset.recording === "false");
    await popup.locator("#record").click();
    await popup.waitForFunction(() => document.body.dataset.recording === "true");
    const page = await observed("/record?owner");
    await page?.fill("#name", "Grace");
    await page?.click("#save");
    await Bun.sleep(1000);
    await popup.locator("#record").click();
    await popup.waitForFunction(() => document.body.dataset.recording === "false");
    expect(await popup.locator("#recording").textContent()).toStartWith("Recorded 2 actions");
    // Another tab of the owner is not an agent tab: the button says so.
    const own = await popup.evaluate(async () => {
      const tabs = (globalThis as unknown as { chrome: ChromeTabs }).chrome.tabs;
      return (await tabs.getCurrent())?.id;
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${own}`);
    await popup.waitForFunction(() => document.body.dataset.recording === "error");
    expect(await popup.locator("#record").isDisabled()).toBe(true);
    await popup.close();
    const listed = await plain("-s", "showme", "recorder", "events");
    const actions = listed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "person-action");
    expect(actions.map((event) => [event.action, event.value ?? null])).toEqual([
      ["fill", "Grace"],
      ["click", null],
    ]);
  } finally {
    await cli("session", "close", "showme", "--close-tabs");
  }
});

// A screenshot shows the page, not this module's ghost cursor; a labelled screenshot keeps its
// labels. A bare `page` says how to get one.
test("screenshots leave the ghost cursor out and a bare page says how to get one", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/record");
     // A blank part of the page, so the pointer hovers nothing there.
     const clip = { x: 0, y: 300, width: 60, height: 60 };
     await page.evaluate(() => document.activeElement?.blur());
     const plain = await page.screenshot({ clip, type: "jpeg", quality: 100 });
     await ghostCursor.show({ page, style: "dot" });
     await page.mouse.move(30, 330);
     await page.waitForTimeout(400);
     const shown = await page.evaluate(() => getComputedStyle(document.getElementById("nds-ghost-cursor")).display);
     const withCursor = await page.screenshot({ clip, type: "jpeg", quality: 100 });
     const after = await page.evaluate(() => [Boolean(document.getElementById("nds-ghost-cursor")), Boolean(document.getElementById("nds-screenshot-style"))]);
     await ghostCursor.hide({ page });
     await page.close();
     return JSON.stringify({ shown, same: plain.equals(withCursor), after })`,
    "--timeout",
    "20000",
  );
  expect(result.body).toMatchObject({ failure: null });
  expect(JSON.parse(String(result.body.value))).toEqual({
    shown: "block",
    same: true,
    after: [true, false],
  });
  const bare = await run("acceptance", "page.url()");
  expect(String(bare.body.output)).toContain("There is no global `page`");
});

// The ghost cursor shows each agent mouse action without a show(); it is the extension's, moved only by the agent's own input, and ghostCursor.hide turns it off.
test("the ghost cursor shows agent mouse actions until the agent hides it", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/");
     const cursor = () => page.evaluate(() => { const host = document.getElementById("nds-ghost-cursor"); return host === null ? "none" : typeof host.stop === "function" ? "executor" : "extension"; });
     // The extension's scripts live in their own world: the page sees none of their names.
     const hidden = await page.evaluate(() => ["__ndsContext", "__ndsContextTarget", "__ndsPins", "__ndsCursorOff"].filter((name) => name in globalThis));
     const before = await cursor();
     await page.click("#inc");
     await page.waitForTimeout(300);
     const clicked = await cursor();
     await ghostCursor.hide({ page });
     await page.click("#inc");
     await page.waitForTimeout(300);
     const off = await cursor();
     await ghostCursor.show({ page });
     await page.mouse.move(20, 20);
     const shown = await cursor();
     await page.close();
     return JSON.stringify({ hidden, before, clicked, off, shown })`,
    "--timeout",
    "20000",
  );
  expect(JSON.parse(String(result.body.value))).toEqual({
    hidden: [],
    before: "none",
    clicked: "extension",
    off: "none",
    shown: "executor",
  });
});

// The guide's performance recipes work through the extension: buffered web vitals, CDP counters,
// CPU throttling and measures of the agent's own steps.
test("the guide's performance recipes measure an agent page", async () => {
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/article");
     const vitals = await page.evaluate(() => new Promise((done) => {
       const [navigation] = performance.getEntriesByType("navigation");
       const seen = { load: navigation.loadEventEnd, observed: PerformanceObserver.supportedEntryTypes.includes("paint"), paints: {}, cls: 0 };
       // Paints come when Chrome draws a frame, which a busy machine or a background tab delays.
       new PerformanceObserver((list) => { for (const e of list.getEntries()) seen.paints[e.name] = e.startTime; if ("first-contentful-paint" in seen.paints) done(seen); }).observe({ type: "paint", buffered: true });
       setTimeout(() => done(seen), 3000);
     }));
     const cdp = await getCDPSession({ page });
     await cdp.send("Performance.enable");
     const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
     await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
     await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
     const measured = await page.evaluate(() => { performance.mark("a"); let x = 0; for (let i = 0; i < 1e6; i++) x += i; performance.mark("b"); return performance.measure("work", "a", "b").duration >= 0; });
     await cdp.detach(); await page.close();
     // Whether a paint came in time depends on the machine and on whether the tab was shown; the
     // recipe's part is that the page's buffered paint entries are observable through the extension.
     return JSON.stringify({ load: vitals.load > 0, paint: vitals.observed, nodes: metrics.Nodes > 0, measured })`,
    "--timeout",
    "20000",
  );
  expect(result.body).toMatchObject({ failure: null });
  expect(JSON.parse(String(result.body.value))).toEqual({
    load: true,
    paint: true,
    nodes: true,
    measured: true,
  });
});

// Agent code loads modules, and reads the elements the owner pinned with right-click. The menu
// itself is browser chrome, so the pin is applied the way the extension applies it.
test("agent code loads modules and lists the elements the owner pinned", async () => {
  await opened("pins");
  try {
    writeFileSync(join(area("pins"), "helper.mjs"), "export const answer = 42;\n");
    const page = await run(
      "pins",
      `state.page = await context.newPage(); await state.page.goto("${origin}/helpers?pins"); return require("node:path").basename("/a/b.txt")`,
    );
    expect(page.body.value).toBe("b.txt");
    expect((await run("pins", `(await import("./helper.mjs")).answer`)).body.value).toBe("42");
    expect((await run("pins", `(await importModule("./helper.mjs")).answer`)).body.value).toBe(
      "42",
    );
    await (await observed("/helpers?pins"))?.click("#save", { button: "right" });
    const result = await run(
      "pins",
      `// The extension remembers the right-click in its own world, which the page cannot see.
       const visible = await state.page.evaluate(() => "__ndsContextTarget" in globalThis);
       await state.page.evaluate(() => { const target = document.getElementById("save"); target.setAttribute("data-nds-pin", "1"); globalThis.ndsPinnedElem1 = target; });
       return JSON.stringify({ visible, pinned: await pinnedElements({ page: state.page }) })`,
    );
    const seen = JSON.parse(String(result.body.value)) as { visible: boolean; pinned: string };
    expect(seen.visible).toBe(false);
    const inspected = await run(
      "pins",
      `state.page = undefined; const found = await inspectPinnedElement(${JSON.stringify(`${origin}/helpers?pins`)}, "globalThis.ndsPinnedElem1"); return JSON.stringify({ html: found.outerHTML, page: state.page?.url() })`,
    );
    expect(JSON.parse(String(inspected.body.value))).toEqual({
      html: '<button id="save" onclick="this.textContent = \'Saved\'" data-nds-pin="1">Save</button>',
      page: `${origin}/helpers?pins`,
    });
    expect(seen.pinned).toBe(
      'ndsPinnedElem1: locator("[data-nds-pin=\\"1\\"]") = getByRole("button", { name: "Save", exact: true })',
    );
  } finally {
    await cli("session", "close", "pins", "--close-tabs");
  }
});

// Agent code has Node.js's common globals, a process it cannot stop or move, and intervals that
// stop with an aborted script.
test("agent code keeps its executor and its intervals end with an aborted script", async () => {
  await opened("globals");
  try {
    const kept = await run(
      "globals",
      `const refused = []; for (const name of ["exit", "chdir", "abort"]) { try { process[name](0); } catch (error) { refused.push(error.message.includes("not available")); } }
       return JSON.stringify({ refused, cwd: process.cwd() === artifacts, buffer: Buffer.from("ab").toString("hex"), id: typeof crypto.randomUUID(), timeout: AbortSignal.timeout(5) instanceof AbortSignal, alias: accessibilitySnapshot === snapshot })`,
    );
    expect(JSON.parse(String(kept.body.value))).toEqual({
      refused: [true, true, true],
      cwd: true,
      buffer: "6162",
      id: "string",
      timeout: true,
      alias: true,
    });
    // The executor is the same one: state from before is still there.
    expect((await run("globals", "state.ticks = 0; return 'set'")).body.value).toBe("set");
    const aborted = await run(
      "globals",
      "setInterval(() => { state.ticks += 1; }, 50); await new Promise((done) => setTimeout(done, 5000))",
      "--timeout",
      "1000",
    );
    expect(aborted.body.failure).toBe("aborted");
    const first = Number((await run("globals", "state.ticks")).body.value);
    await Bun.sleep(400);
    const later = Number((await run("globals", "state.ticks")).body.value);
    expect(first).toBeGreaterThan(5);
    expect(later).toBe(first);
  } finally {
    await cli("session", "close", "globals");
  }
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
  expect(result.body.value).toBe("NotAllowedError signed-in 1 event");
});

test("a raw CDP session that enables Runtime learns the page's contexts", async () => {
  // Playwright enabled Runtime on the tab first; a later session must still be told the contexts.
  await opened("runtime");
  try {
    const result = await run(
      "runtime",
      `const page = await context.newPage(); await page.goto("${origin}/");
       const cdp = await getCDPSession({ page });
       const contexts = [];
       cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context.auxData?.isDefault));
       await cdp.send("Runtime.enable");
       const { result } = await cdp.send("Runtime.evaluate", { expression: "document.title" });
       await page.evaluate(() => document.title);
       await page.close();
       return [contexts.includes(true), result.value].join(" ")`,
      "--timeout",
      "10000",
    );
    expect(result.body.value).toBe("true Fixture");
    expect((await cli("session", "close", "runtime", "--close-tabs")).code).toBe(0);
  } finally {
    // A failure above must not leave this session's executor to the tests after it.
    await cli("session", "close", "runtime");
  }
});

test("screenshots are written inside the session area", async () => {
  const result = await run(
    "acceptance",
    `const page = context.pages().find((candidate) => candidate.url().endsWith("/form")); const path = artifacts + "/form.png"; await page.screenshot({ path }); return path`,
    "--timeout",
    "20000",
  );
  // Agent code joins with "/", which Windows accepts beside its own separator.
  const path = resolve(String(result.body.value));
  expect(path).toBe(join(area("acceptance"), "form.png"));
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
  expect((await slow).body.value).toBe("slow");
});

test("a timeout aborts the script: its later action never happens and the state stays", async () => {
  const page = await observed("/");
  const before = await page?.locator("#c").textContent();
  expect((await run("acceptance", "state.kept = 7")).code).toBe(0);
  const result = await run(
    "acceptance",
    `console.log("started"); await new Promise((done) => setTimeout(done, 3000)); await state.page.click("#inc")`,
    "--timeout",
    "1000",
  );
  expect(result.code).toBe(1);
  expect(result.body.failure).toBe("aborted");
  expect(String(result.body.output)).toContain("[log] started");
  expect(String(result.body.output)).toContain("reached its deadline and was aborted");
  await Bun.sleep(3500);
  expect(await page?.locator("#c").textContent()).toBe(before ?? "");
  expect((await run("acceptance", "state.kept")).body.value).toBe("7");
});

// Callbacks a script handed to Playwright act in later scripts only if that script ended on its
// own: an aborted script's listeners and routes are removed, so the page behaves as without them,
// and its bindings can no longer act.
test("an aborted script's callbacks never act after its abort, and an ended script's still do", async () => {
  await opened("callbacks");
  try {
    const kept = await run(
      "callbacks",
      `state.page = await context.newPage(); await state.page.goto("${origin}/");
      state.page.on("console", async (message) => { if (message.text() === "kept") await state.page.click("#inc"); });
      return "kept"`,
    );
    expect(kept.body.value).toBe("kept");
    const aborted = await run(
      "callbacks",
      `state.page.once("console", async () => {
        try { await state.page.click("#inc"); state.acted = true; } catch { state.denied = true; }
      });
      state.page.on("dialog", () => {});
      await state.page.route("**/linked", (route) => route.fulfill({ contentType: "text/html", body: "aborted route" }));
      await state.page.exposeBinding("abortedClick", async () => { await state.page.click("#inc"); });
      await new Promise((done) => setTimeout(done, 8000));`,
      "--timeout",
      "1500",
    );
    expect(aborted.body.failure).toBe("aborted");
    const after = await run(
      "callbacks",
      `const page = state.page;
      const count = () => page.locator("#c").textContent();
      const seen = { start: await count() };
      await page.evaluate(() => console.log("after abort"));
      await page.waitForTimeout(500);
      seen.afterEvent = await count();
      seen.binding = await page.evaluate(() => window.abortedClick().then(() => "resolved", () => "rejected"));
      seen.afterBinding = await count();
      seen.dialog = await page.evaluate(() => { alert("left alone"); return "dismissed"; });
      seen.acted = state.acted === true;
      await page.goto("${origin}/linked");
      seen.routed = await page.locator("body").textContent();
      await page.goto("${origin}/");
      await page.evaluate(() => console.log("kept"));
      await page.waitForFunction(() => document.getElementById("c")?.textContent === "1");
      seen.kept = await count();
      await page.close();
      return JSON.stringify(seen)`,
      "--timeout",
      "15000",
    );
    expect(JSON.parse(String(after.body.value))).toEqual({
      start: "0",
      afterEvent: "0",
      binding: "rejected",
      afterBinding: "0",
      dialog: "dismissed",
      acted: false,
      routed: "linked",
      kept: "1",
    });
  } finally {
    await cli("session", "close", "callbacks");
  }
});

// A removal takes the latest registration, as Playwright's emitter does, so a newer script that
// adds and removes a callback leaves an ended script's registration of it in place.
test("removing a callback leaves an ended script's registration of it, also across an abort", async () => {
  await opened("removal");
  try {
    await run(
      "removal",
      `state.page = await context.newPage(); await state.page.goto("${origin}/"); state.hits = 0;
      state.shared = (message) => { if (message.text() === "removal-trigger") state.hits += 1; };
      state.page.on("console", state.shared); return "ready"`,
    );
    const stopped = await run(
      "removal",
      `state.page.on("console", state.shared); state.page.off("console", state.shared); state.page.on("console", state.shared);
      await new Promise((done) => setTimeout(done, 8000))`,
      "--timeout",
      "1000",
    );
    expect(stopped.body.failure).toBe("aborted");
    const hits = await run(
      "removal",
      `await state.page.evaluate(() => console.log("removal-trigger")); await state.page.waitForTimeout(300); return state.hits`,
    );
    expect(hits.body.value).toBe("1");
  } finally {
    await cli("session", "close", "removal");
  }
});

// An aborted script that ends after its abort answer leaves the next script's result whole.
test("a late end of an aborted script leaves the next result its notices", async () => {
  await opened("notices");
  try {
    await run(
      "notices",
      `state.page = await context.newPage(); await state.page.goto("${origin}/"); return "ready"`,
    );
    const old = await run(
      "notices",
      "await new Promise((done) => setTimeout(done, 3000))",
      "--timeout",
      "1000",
    );
    expect(old.body.failure).toBe("aborted");
    // The next script's page error comes before the aborted one ends, and its result comes after.
    const next = await run(
      "notices",
      `await state.page.evaluate(() => setTimeout(() => { throw new Error("late-notice") }, 0));
      await new Promise((done) => setTimeout(done, 3500)); return "next"`,
      "--timeout",
      "10000",
    );
    expect(next.code).toBe(0);
    expect(String(next.body.output)).toContain("late-notice");
  } finally {
    await cli("session", "close", "notices");
  }
});

test("a script that blocks its executor past the deadline is stopped and its state resets", async () => {
  await opened("blocking");
  try {
    expect((await run("blocking", "state.kept = 1")).code).toBe(0);
    const blocked = await run("blocking", "while (true) {}", "--timeout", "1000");
    expect(blocked).toEqual({ code: 2, body: expect.objectContaining({ error: "timeout" }) });
    expect((await run("blocking", "state.kept === undefined")).body.value).toBe("true");
    expect((await cli("session", "close", "blocking")).code).toBe(0);
  } finally {
    // A failure above must not leave this session's executor to the tests after it.
    await cli("session", "close", "blocking");
  }
});

test("a replacement executor sees its page and none of the old executor's interception", async () => {
  await opened("replaced");
  try {
    // The first executor opens a page, holds every later request of it unanswered, and then
    // outlives its deadline.
    const first = await run(
      "replaced",
      `state.page = await context.newPage(); await state.page.goto("${origin}/"); await state.page.route("**/*", () => {}); while (true) {}`,
      "--timeout",
      "1500",
    );
    // A script that blocks its executor cannot confirm an abort, so the executor is replaced.
    expect(first.body.error).toBe("timeout");
    // Its replacement evaluates in the same tab and loads it again.
    const replaced = await run(
      "replaced",
      "const page = context.pages()[0]; await page.reload(); return await page.evaluate(() => document.title)",
      "--timeout",
      "8000",
    );
    expect(replaced.body.value).toBe("Fixture");
    expect((await cli("session", "close", "replaced", "--close-tabs")).code).toBe(0);
  } finally {
    // A failure above must not leave this session's executor to the tests after it.
    await cli("session", "close", "replaced");
  }
});

test("another extension's frame neither ends an agent tab nor reaches agents", async () => {
  await opened("foreign");
  try {
    // The fixture extension injects its own page as a frame half a second after load. Chrome then
    // detaches the debugger from the whole tab; the tab is attached again, and its frame removed.
    const result = await run(
      "foreign",
      `state.page = await context.newPage(); await state.page.goto("${origin}/foreign");
       await state.page.waitForTimeout(2500);
       return [context.pages().length, await state.page.evaluate(() => document.querySelectorAll("iframe").length), await state.page.title()].join(" ")`,
      "--timeout",
      "15000",
    );
    // The whole answer is compared, so a failure shows its reason.
    expect(result.body).toMatchObject({ value: "1 0 Foreign host" });
    expect(
      (await run("foreign", "await state.page.reload(); return state.page.url()")).body,
    ).toMatchObject({ value: `${origin}/foreign` });
    expect((await cli("session", "close", "foreign", "--close-tabs")).code).toBe(0);
  } finally {
    // A failure above must not leave this session's executor to the tests after it.
    await cli("session", "close", "foreign");
  }
});

// What an agent's shell sees from one CLI call: plain text, no protocol envelope.
async function plain(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

// A download of an agent tab reaches Playwright as its event, with the URL and the name the site
// suggests, and its file is the browser's own, which the host keeps in the session: saveAs(),
// path(), createReadStream() and failure() answer from it, also after the page closed. That covers
// a file only the page's cookie opens, a redirect to another site, a blob the page revoked at once,
// a form's POST, a link that works once, a frame of another site, and a file that opens in a new
// tab, which is reported on the tab that opened it. The browser's own copies are gone afterwards.
// The owner's folder often holds a file of the same name already: the browser saves the agent's
// download as "name (1)", and that copy is still the agent's and still removed; the owner's file
// stays as it was.
test("a download whose name the owner's folder already holds is still kept and removed", async () => {
  writeFileSync(join(downloadsFolder, "moved.txt"), "the owner's own");
  try {
    const result = await run(
      "acceptance",
      `const page = await context.newPage(); await page.goto("${origin}/files");
       await page.evaluate(() => { const link = document.createElement("a"); link.id = "plain"; link.href = "/files/plain"; link.textContent = "Plain"; document.body.append(link); });
       const [download] = await Promise.all([page.waitForEvent("download"), page.click("#plain")]);
       const file = await download.path();
       const { basename, dirname } = require("node:path");
       // The host's copy lies in the session's .downloads/<token>/ under the site's name.
       const kept = basename(dirname(dirname(file))) === ".downloads" && /^[0-9a-f]{32}$/.test(basename(dirname(file))) && basename(file) === "moved.txt";
       const result = JSON.stringify({ kept, body: require("node:fs").readFileSync(file, "utf8") });
       await page.close();
       return result`,
      "--timeout",
      "20000",
    );
    expect(JSON.parse(String(result.body.value))).toEqual({ kept: true, body: "moved body" });
    const deadline = Date.now() + 5000;
    while (
      readdirSync(downloadsFolder).some((name) => name.startsWith("moved (")) &&
      Date.now() < deadline
    )
      await Bun.sleep(100);
    expect(readdirSync(downloadsFolder).filter((name) => name.startsWith("moved"))).toEqual([
      "moved.txt",
    ]);
    expect(readFileSync(join(downloadsFolder, "moved.txt"), "utf8")).toBe("the owner's own");
  } finally {
    for (const name of readdirSync(downloadsFolder).filter((name) => name.startsWith("moved")))
      rmSync(join(downloadsFolder, name));
  }
});

test("an agent tab's download is the agent's file", async () => {
  served.once = 0;
  const get = `const get = async (selector, frame) => (await Promise.all([page.waitForEvent("download"), (frame ? page.frameLocator("iframe").locator(selector) : page.locator(selector)).click()]))[0];
     const read = async (download) => require("node:fs").readFileSync(await download.path(), "utf8");`;
  const first = await run(
    "acceptance",
    `const fs = require("node:fs");
     const page = await context.newPage(); await page.goto("${origin}/files");
     await page.evaluate(() => { document.cookie = "nds-e2e=1; path=/"; });
     ${get}
     const bytes = await get("#bytes"), moved = await get("#moved"), made = await get("#blob");
     await Promise.all([bytes, moved, made].map((download) => download.path()));
     await page.close();
     await bytes.saveAs(\`\${artifacts}/bytes.bin\`);
     const saved = fs.readFileSync(\`\${artifacts}/bytes.bin\`);
     const chunks = []; for await (const chunk of await moved.createReadStream()) chunks.push(chunk);
     return JSON.stringify({
       name: bytes.suggestedFilename(),
       bytes: saved.length === 1024 && saved.every((byte, index) => byte === index % 256),
       path: require("node:path").basename(await bytes.path()) === "bytes.bin" && fs.readFileSync(await bytes.path()).equals(saved),
       failure: await bytes.failure(),
       moved: Buffer.concat(chunks).toString(),
       made: await read(made),
     })`,
    "--timeout",
    "20000",
  );
  expect(first.body).toMatchObject({ failure: null });
  expect(JSON.parse(String(first.body.value))).toEqual({
    name: "bytes.bin",
    bytes: true,
    path: true,
    failure: null,
    moved: "moved body",
    made: "blob body",
  });
  const second = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/files");
     ${get}
     const posted = await get("#post"), once = await get("#once"), inner = await get("#inner", true);
     return JSON.stringify({ posted: await read(posted), once: await read(once), inner: await read(inner) })`,
    "--timeout",
    "20000",
  );
  expect(second.body).toMatchObject({ failure: null });
  expect(JSON.parse(String(second.body.value))).toEqual({
    posted: "posted body",
    once: "once body",
    inner: "moved body",
  });
  served.once = 0;
  const third = await run(
    "acceptance",
    `const page = context.pages().find((each) => each.url().endsWith("/files"));
     ${get}
     const tab = await get("#tab"), opened = await get("#open");
     const result = JSON.stringify({
       tab: [tab.page() === page, tab.suggestedFilename(), await read(tab)],
       opened: [opened.page() === page, await read(opened)],
     });
     await page.close();
     return result`,
    "--timeout",
    "20000",
  );
  expect(third.body).toMatchObject({ failure: null });
  expect(JSON.parse(String(third.body.value))).toEqual({
    tab: [true, "moved.txt", "moved body"],
    opened: [true, "once body"],
  });
  // The browser's list keeps none of these downloads and their files are gone.
  const worker = observer.serviceWorkers().find((each) => each.url().includes(extensionId));
  type Downloads = { search(query: object): Promise<{ url: string; exists: boolean }[]> };
  const left = await worker?.evaluate(async (prefix) => {
    const { downloads } = (globalThis as unknown as { chrome: { downloads: Downloads } }).chrome;
    return (await downloads.search({})).filter((item) => item.url.startsWith(prefix) && item.exists)
      .length;
  }, origin);
  expect(left).toBe(0);
  expect(readdirSync(downloadsFolder)).toEqual([]);
});

// The activity journal (docs/observability.md) in the full profile: the execution with its typed
// literals left out, the actions with safe values, the page's API request with its body stored
// once and its secrets removed, a repeated console error folded and the page error. The popup's
// Off stops it, and the CLI reads it without the host.
test("the activity journal keeps what agents did and the popup's off stops it", async () => {
  const activity = async (...flags: string[]) => {
    const result = await plain("-s", "acceptance", "activity", "--all", "--full", ...flags);
    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const result = await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/journal");
     await page.fill("#email", "ann@test"); await page.fill("#password", "hunter2");
     await page.evaluate(() => alert("checkout?"));
     await page.waitForTimeout(1500); await page.close(); return "journaled"`,
    "--timeout",
    "20000",
  );
  expect(result.body).toMatchObject({ failure: null });
  await Bun.sleep(1500);
  const records = await activity();
  const text = JSON.stringify(records);
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("tok-should-not-stay");
  expect(text).not.toContain("token=abc");
  const execution = records.findLast((record) => record.type === "execution");
  expect(execution).toMatchObject({ ok: true });
  expect(String(execution?.code)).toContain('page.fill("#email", "[redacted]")');
  const fills = records.filter((record) => record.type === "action" && record.api === "fill");
  expect(fills.slice(-2).map((record) => [record.locator, record.value])).toEqual([
    ["#email", "ann@test"],
    ["#password", "[redacted]"],
  ]);
  const api = records.findLast(
    (record) => record.type === "network" && String(record.url).includes("/api/journal"),
  );
  expect(api).toMatchObject({ method: "GET", status: 200, resource: "fetch" });
  expect(String(api?.url)).toContain("token=[redacted]");
  const hash = (api?.body as { hash?: string } | undefined)?.hash ?? "";
  const body = await plain("-s", "acceptance", "activity", "body", hash);
  expect(JSON.parse(body.stdout)).toEqual({ order: 7, items: ["shoe"], accessToken: "[redacted]" });
  const errors = records.filter(
    (record) => record.type === "console" && record.text === "cart failed",
  );
  expect(errors.at(-1)).toMatchObject({ level: "error", repeat: 2 });
  expect(
    records.some((record) => record.type === "page-error" && record.message === "late boom"),
  ).toBe(true);
  // Playwright still dismissed the dialog nobody handled; the host journaled it.
  expect(
    records.some(
      (record) =>
        record.type === "dialog" && record.kind === "alert" && record.text === "checkout?",
    ),
  ).toBe(true);
  // The owner's popup turns it off: the next execution leaves nothing new.
  await observation("off");
  expect((await cli("status")).body.observation).toBe("off");
  const before = (await activity()).length;
  await run(
    "acceptance",
    `const page = await context.newPage(); await page.goto("${origin}/journal"); await page.close(); return 1`,
  );
  await Bun.sleep(1500);
  expect((await activity()).length).toBe(before);
  await observation("full");
  expect((await cli("status")).body.observation).toBe("full");
});

// The owner keeps a site private in the popup: agents still work there, the journal keeps that
// they did, never what, and the popup shows the agent's newest steps.
test("a private site keeps its content out of the journal, and the popup shows the steps", async () => {
  const site = `http://localhost:${fixture.port}/journal`;
  const opened = await run(
    "acceptance",
    `state.private = await context.newPage(); await state.private.goto("${site}"); return "ok"`,
  );
  expect(opened.body.value).toBe("ok");
  const popup = await observer.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const tab = await popup.evaluate(async (url) => {
    const tabs = (globalThis as unknown as { chrome: ChromeTabs }).chrome.tabs;
    return (await tabs.query({})).find((each) => each.url === url)?.id;
  }, site);
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tab}`);
  await popup.locator("#private-add:not([disabled])").click();
  await popup.waitForFunction(() =>
    document.getElementById("private")?.textContent?.includes("localhost"),
  );
  const result = await run(
    "acceptance",
    `await state.private.fill("#email", "private-note@test");
     await state.private.evaluate(() => fetch("/api/journal?id=8").then((r) => r.json()));
     await state.private.waitForTimeout(1500); return "done"`,
    "--timeout",
    "20000",
  );
  expect(result.body.value).toBe("done");
  await Bun.sleep(1500);
  const listed = await plain("-s", "acceptance", "activity", "--last", "20", "--full");
  expect(listed.stdout).not.toContain("private-note");
  expect(listed.stdout).not.toContain("tok-should-not-stay");
  const records = listed.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const fill = records.findLast((record) => record.type === "action" && record.api === "fill");
  // The action names its page, so the journal knows its site without guessing.
  expect(fill).toMatchObject({ private: true, page: expect.any(Number) });
  expect(fill?.value).toBeUndefined();
  expect(fill?.locator).toBeUndefined();
  // The popup lists the group's newest steps, the private ones marked.
  await popup.reload();
  await popup.waitForFunction(() => Number(document.body.dataset.recent) > 0);
  expect(await popup.locator("#recent").textContent()).toContain("action (private)  fill");
  // The owner keeps the site's content again.
  await popup.locator("#private li button").click();
  await popup.waitForFunction(() => document.getElementById("private")?.children.length === 0);
  await popup.close();
  await run("acceptance", "await state.private.close(); delete state.private");
});

// Another device's browser is driven through that device's own CLI: here a device whose transport
// runs this CLI again, so the whole path is exercised without a second machine.
test("a device's CLI runs a session's code there and hands its artifacts back", async () => {
  const devices = join(configuration, "devices.json");
  const missing = join(root, "missing", "nds-browser-use");
  // A device whose CLI answers, though no browser is connected there.
  const idle = windows
    ? {}
    : {
        idle: {
          // A short sibling of the run's own directory keeps its socket path inside sun_path.
          command: ["/usr/bin/env", `NDS_BROWSER_USE_RUNTIME_DIR=${runtime}-idle`, binary],
        },
      };
  const configured = { self: { command: [binary] }, broken: { command: [missing] }, ...idle };
  writeFileSync(devices, JSON.stringify({ schema: 1, devices: configured }), { mode: 0o600 });
  const scratch = mkdtempSync(join(tmpdir(), "nds-bu-device-"));
  try {
    const listed = (await cli("devices")).body as unknown as Record<string, unknown>[];
    expect(listed).toEqual([
      { name: "broken", transport: "command", error: "device_unreachable" },
      ...(windows ? [] : [{ name: "idle", transport: "command", error: "unavailable" }]),
      { name: "self", transport: "command", status: expect.objectContaining({ enabled: true }) },
    ]);
    const unreachable = await plain("--device", "broken", "-s", "device", "-e", "1");
    expect(unreachable.code).toBe(2);
    expect(unreachable.stderr).toStartWith("Error (device_unreachable)");
    expect((await cli("--device", "self", "session", "new", "device")).code).toBe(0);
    const ran = await plain(
      "--device",
      "self",
      "-s",
      "device",
      "-e",
      `state.page = await context.newPage(); await state.page.goto("${origin}/"); await state.page.screenshot({ path: \`\${artifacts}/shot.png\` }); return "on the device"`,
      "--timeout",
      "20000",
    );
    expect(ran).toEqual({ code: 0, stdout: "[return value] on the device\n", stderr: "" });
    // A file's code travels on stdin, and the default device needs no flag.
    const script = join(scratch, "count.js");
    writeFileSync(script, 'return await state.page.locator("#c").textContent()');
    const chosen = Bun.spawn([binary, "-s", "device", "-f", script], {
      env: { ...env, NDS_BROWSER_DEVICE: "self" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(chosen.stdout).text()).toBe("[return value] 0\n");
    expect(await chosen.exited).toBe(0);
    const artifacts: unknown = (await cli("--device", "self", "-s", "device", "artifact", "list"))
      .body;
    expect(artifacts).toEqual([{ path: "shot.png", bytes: expect.any(Number) }]);
    const local = join(scratch, "shot.png");
    const pulled = await cli(
      "--device",
      "self",
      "-s",
      "device",
      "artifact",
      "shot.png",
      "--output",
      local,
    );
    expect(pulled.body).toMatchObject({ written: local });
    expect([...readFileSync(local).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // Nothing outside the session's own area is read, also through a link agent code made there,
    // and only configured devices are reached.
    const host = join(configuration, "host.json");
    const linked = await plain(
      "--device",
      "self",
      "-s",
      "device",
      "-e",
      `require("node:fs").symlinkSync(${JSON.stringify(host)}, \`\${artifacts}/link.json\`); return "linked"`,
    );
    expect(linked.stdout).toBe("[return value] linked\n");
    const remaining: unknown = (await cli("--device", "self", "-s", "device", "artifact", "list"))
      .body;
    expect(remaining).toEqual([{ path: "shot.png", bytes: expect.any(Number) }]);
    for (const outside of ["link.json", "../device/shot.png", "../../host.json", "/etc/passwd"]) {
      expect(await cli("--device", "self", "-s", "device", "artifact", outside)).toEqual({
        code: 2,
        body: expect.objectContaining({ error: "invalid_configuration" }),
      });
    }
    expect(await cli("--device", "elsewhere", "status")).toEqual({
      code: 2,
      body: expect.objectContaining({ error: "device_unknown" }),
    });
  } finally {
    await cli("--device", "self", "session", "close", "device");
    rmSync(devices, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("agents read plain text, and a stuck action fails with its reason before the deadline", async () => {
  await opened("plain");
  try {
    // The host records every request; the client's stderr stays empty for the agent.
    const value = await plain("-s", "plain", "-e", "1 + 1");
    expect(value).toEqual({ code: 0, stdout: "[return value] 2\n", stderr: "" });
    const logged = await plain(
      "-s",
      "plain",
      "-e",
      `state.page = await context.newPage(); await state.page.goto("${origin}/"); await state.page.evaluate(() => console.log("%cstyled %s", "color: red", "text")); state.kept = 1; return getLatestLogs({ page: state.page, sinceLastCall: true })`,
    );
    expect(logged.stdout).toContain("[log] styled text");
    expect(logged.stdout).not.toContain("color: red");
    // A locator that matches nothing fails with Playwright's reason within the run's own deadline;
    // the session keeps its state.
    const stuck = await plain(
      "-s",
      "plain",
      "-e",
      'await state.page.click("#missing")',
      "--timeout",
      "4000",
    );
    expect(stuck.code).toBe(1);
    expect(stuck.stderr).toContain("no element matched the locator");
    expect((await plain("-s", "plain", "-e", "state.kept")).stdout).toBe("[return value] 1\n");
    const closed = await plain("-s", "plain", "-e", "await state.page.close()");
    expect(closed.stdout).toStartWith("[WARNING] Page closed");
    expect(closed.stdout).toContain("for state.page");
    // A deadline beyond the bound is refused here with the usage that names the bound.
    const long = await plain("-s", "plain", "-e", "1", "--timeout", "30000");
    expect(long.code).toBe(2);
    expect(long.stderr).toContain("--timeout <ms, at most 25000>");
    const refused = await plain("-s", "nowhere", "-e", "1");
    expect(refused.code).toBe(2);
    expect(refused.stderr).toStartWith("Error (session_not_found)");
    expect((await cli("session", "close", "plain")).code).toBe(0);
  } finally {
    // A failure above must not leave this session's executor and tab to the tests after it.
    await cli("session", "close", "plain");
  }
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
  expect((await run("acceptance", "state.value === undefined")).body.value).toBe("true");
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

// The owned-session operations NDS composes, over the host's control socket: a request is one
// JSON line, and a reply is a {"bytes":N} line followed by N bytes of JSON.
async function control(request: object): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  let buffer = Buffer.alloc(0);
  const socket = await Bun.connect({
    unix: join(runtime, "control.sock"),
    socket: {
      data(_, chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        const line = buffer.indexOf(10);
        if (line < 0) return;
        const { bytes } = JSON.parse(buffer.subarray(0, line).toString()) as { bytes: number };
        if (buffer.length >= line + 1 + bytes) {
          resolve(JSON.parse(buffer.subarray(line + 1, line + 1 + bytes).toString()));
        }
      },
      error(_, error) {
        reject(error);
      },
      close() {
        reject(new Error("the host closed the control connection before replying"));
      },
    },
  });
  socket.write(`${JSON.stringify(request)}\n`);
  try {
    return await promise;
  } finally {
    socket.end();
  }
}

// Bun has no AF_UNIX client on Windows; there the host's own tests cover the owned operations.
test.skipIf(windows)(
  "owned sessions keep their generation and drain before close is acknowledged",
  async () => {
    const created = await control({ op: "create_owned", project: "owned" });
    expect(created.result).toBe("owned_session");
    // The handle stays in this test's memory and is passed back verbatim; it is never printed.
    const handle = { project: created.project, generation: created.generation };
    const foreign = { project: "owned", generation: "0".repeat(32) };
    expect(await control({ op: "open_owned", session: foreign })).toEqual({
      result: "refused",
      refusal: "session_not_found",
    });
    // A project name alone does not adopt the reserved generation.
    expect((await control({ op: "open", project: "owned" })).refusal).toBe("busy");
    expect(await control({ op: "open_owned", session: handle })).toMatchObject({
      result: "session",
      project: "owned",
    });
    expect(
      await control({
        op: "execute_owned",
        session: handle,
        code: `const page = await context.newPage(); await page.goto("${origin}/owned"); return await page.title()`,
        timeout_ms: 20000,
        expect: null,
      }),
    ).toMatchObject({ result: "executed", failure: null, output: "[return value] Owned" });
    expect(await observed("/owned")).toBeDefined();
    // Close while an owned execution runs: the acknowledgement comes only after its executor ended.
    const executor = area("owned");
    expect(processes(executor)).toHaveLength(1);
    const running = control({
      op: "execute_owned",
      session: handle,
      code: "await new Promise((done) => setTimeout(done, 15000)); return 'late'",
      timeout_ms: 20000,
      expect: null,
    }).catch(
      (error: Error): Record<string, unknown> => ({ result: "lost", message: error.message }),
    );
    await Bun.sleep(1000);
    expect(await control({ op: "close_owned", session: handle, close_tabs: true })).toEqual({
      result: "closed",
    });
    expect(processes(executor)).toHaveLength(0);
    expect((await running).output).not.toBe("late");
    expect(await observed("/owned")).toBeUndefined();
    // The closed generation is stale everywhere.
    for (const request of [
      { op: "open_owned", session: handle },
      { op: "execute_owned", session: handle, code: "1", timeout_ms: 1000, expect: null },
      { op: "close_owned", session: handle, close_tabs: false },
    ]) {
      expect(await control(request)).toEqual({ result: "refused", refusal: "session_not_found" });
    }
  },
  60000,
);

// An execution that times out while its page waits on a long CDP call leaves that call to Chrome.
// Once the extension's deadline for the call passed, the session still closes and opens again.
test("a session whose execution timed out during a long wait closes and opens again", async () => {
  await opened("waiting");
  try {
    const waited = await run(
      "waiting",
      `const page = await context.newPage(); await page.goto("${origin}/"); await page.waitForFunction(() => false, null, { timeout: 0 })`,
      "--timeout",
      "3000",
    );
    expect(waited.body.failure).toBe("aborted");
    // The extension answers or drops the abandoned call within its 30 s reply deadline.
    await Bun.sleep(32_000);
    expect((await cli("session", "close", "waiting", "--close-tabs")).code).toBe(0);
    expect((await cli("session", "new", "waiting")).code).toBe(0);
    expect((await cli("session", "close", "waiting", "--close-tabs")).code).toBe(0);
  } finally {
    // A failure above must not leave this session's executor to the tests after it.
    await cli("session", "close", "waiting");
  }
}, 60_000);

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
  expect(result.body.value).toContain(`${origin}/`);
});

test("a lost host is replaced and the agent group is reclaimed without owner tabs", async () => {
  const owner = await observed("/owner");
  expect(owner).toBeDefined();
  const leftover = join(area("acceptance"), "before-loss.png");
  const written = await run(
    "acceptance",
    `await context.pages()[0].screenshot({ path: artifacts + "/before-loss.png" }); return "written"`,
    "--timeout",
    "20000",
  );
  expect(written.body.value).toBe("written");
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
  expect(reclaimed.body.value).toStartWith("true ");
  expect(reclaimed.body.value).toContain(`${origin}/`);
  expect(reclaimed.body.value).not.toContain("/owner");
  expect(owner?.url()).toBe(`${origin}/owner`);
});

test("closing a session cleans only its own area", async () => {
  expect((await cli("session", "close", "acceptance")).code).toBe(0);
  await Bun.sleep(500);
  expect(await observed("/")).toBeUndefined();
  expect(await observed("/owner")).toBeDefined();
  expect(existsSync(area("acceptance"))).toBe(false);
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
    // The extension's own work, reported through the host: the fixture extension's frame forced a
    // detach that was restored, and the session of a replaced executor was refreshed.
    "browser.target.reattached",
    "browser.session.refreshed",
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
    "foreign-extension",
    "chrome-extension://",
  ]) {
    expect(text).not.toContain(secret);
  }
  for (const event of events) expect(event["service.name"]).toBe("nddev-device-sync-browser-use");
});
