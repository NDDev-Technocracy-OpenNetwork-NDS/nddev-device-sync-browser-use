// Phone acceptance (docs/mobile.md). The host serves a Chromium browser through the phone link,
// which reaches it with the ADB server protocol, as it reaches a phone. A fake ADB server stands
// in for the phone: it lists one device, answers its shell and carries its DevTools socket to a
// Chrome for Testing that this test starts with a debugging port of its own; a phone's browser
// runs the same DevTools server on an abstract unix socket. Playwright observes that browser
// over its own pipe.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { BrowserContext } from "playwright-core";
import { launchFixture } from "./launch.js";

const windows = process.platform === "win32";
const repository = resolve(import.meta.dir, "..");
const chrome = required("NDS_TEST_CHROME");
const source = required("NDS_TEST_HOST");
const root = mkdtempSync(join(tmpdir(), "nds-browser-use-phone-"));
const runtime = mkdtempSync(
  join(windows ? tmpdir() : (process.env.XDG_RUNTIME_DIR ?? "/tmp"), "nds-bu-"),
);
const binary = join(root, "bin", windows ? "nds-browser-use.exe" : "nds-browser-use");
const profile = join(root, "profile");
const serveLog = join(root, "phone.log");
const serial = "nds-phone";
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  NDS_BROWSER_USE_RUNTIME_DIR: runtime,
};

let observer: BrowserContext;
let adb: Server;
let serve: ReturnType<typeof Bun.spawn> | undefined;
let fixture: ReturnType<typeof Bun.serve>;
let origin: string;
// What the link ran in the phone's shell, as the owner's phone would run it.
const shells: string[] = [];
// The open DevTools streams, which the test cuts as Android does when it stops the browser.
const streams = new Set<Socket>();

function required(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

type Result = { code: number; body: Record<string, unknown> };

async function cli(...args: string[]): Promise<Result> {
  const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  return { code: await child.exited, body: JSON.parse(text) as Record<string, unknown> };
}

const phone = (...args: string[]) => cli("--phone", serial, ...args);

async function run(project: string, code: string): Promise<Result> {
  const result = await phone("-s", project, "-e", code, "--json", "--timeout", "20000");
  const output = typeof result.body.output === "string" ? result.body.output : "";
  // CI diagnostics: fixture pages only, never an owner's.
  if (process.env.NDS_E2E_DIAGNOSTICS === "1" && (result.code !== 0 || result.body.error)) {
    console.error(`phone run refused: ${JSON.stringify(result.body)}`);
  }
  const marker = output.lastIndexOf("[return value] ");
  result.body.value = marker < 0 ? undefined : output.slice(marker + "[return value] ".length);
  return result;
}

async function until(check: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${ms} ms`);
    await Bun.sleep(100);
  }
}

function hex(length: number): string {
  return length.toString(16).padStart(4, "0");
}

// The ADB server's side of its protocol for one phone: the device list, shell commands, and a
// stream to the browser's DevTools socket.
function fakeAdb(devtools: number): Server {
  const unix = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 4242 @chrome_devtools_remote",
    "0000000000000000: 00000002 00000000 00010000 0001 01 4243 @jdwp-control",
    "",
  ].join("\n");
  return createServer((client: Socket) => {
    let buffer = Buffer.alloc(0);
    const fail = (reason: string) => client.end(`FAIL${hex(reason.length)}${reason}`);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = Number.parseInt(buffer.subarray(0, 4).toString(), 16);
        if (buffer.length < 4 + length) return;
        const request = buffer.subarray(4, 4 + length).toString();
        buffer = buffer.subarray(4 + length);
        if (request === "host:devices-l") {
          const body = `${serial}              device product:nds model:NDS_test_phone\n`;
          client.end(`OKAY${hex(body.length)}${body}`);
          return;
        }
        if (request === `host:transport:${serial}`) {
          client.write("OKAY");
          continue;
        }
        if (request.startsWith("host:transport:")) {
          fail("device not found");
          return;
        }
        if (request.startsWith("shell:")) {
          const command = request.slice("shell:".length);
          shells.push(command);
          client.end(`OKAY${command === "cat /proc/net/unix" ? unix : ""}`);
          return;
        }
        if (request === "localabstract:chrome_devtools_remote") {
          client.off("data", onData);
          client.write("OKAY");
          const upstream = connect(devtools, "127.0.0.1");
          if (buffer.length > 0) upstream.write(buffer);
          client.pipe(upstream);
          upstream.pipe(client);
          client.on("error", () => upstream.destroy());
          upstream.on("error", () => client.destroy());
          streams.add(client);
          client.on("close", () => streams.delete(client));
          return;
        }
        fail("unknown service");
        return;
      }
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
}

beforeAll(async () => {
  fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pages: Record<string, string> = {
        "/": `<button onclick="c.textContent = Number(c.textContent) + 1">Increment</button><span id="c">0</span>`,
        "/owner": "<p>owner</p>",
        "/opener": `<button onclick="window.open('/popup')">Open</button>`,
        "/popup": "<p>popup</p>",
      };
      const body = pages[new URL(request.url).pathname];
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://127.0.0.1:${fixture.port}`;
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(source, binary);
  if (!windows) chmodSync(binary, 0o755);
  const registration = await cli(
    "install",
    "--bun",
    process.execPath,
    "--executor",
    join(repository, "packages/executor/executor.ts"),
    ...(windows
      ? ["--browser", "chrome-for-testing"]
      : ["--host-dir", join(root, "NativeMessagingHosts")]),
  );
  expect(registration.code).toBe(0);
  observer = await launchFixture(profile, {
    executablePath: chrome,
    headless: true,
    env,
    viewport: null,
    args: ["--remote-debugging-port=0"],
  });
  for (const page of observer.pages()) page.on("dialog", () => undefined);
  observer.on("page", (page) => page.on("dialog", () => undefined));
  const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
  adb = fakeAdb(port);
  await new Promise<void>((done) => adb.listen(0, "127.0.0.1", done));
  const address = adb.address();
  if (address === null || typeof address === "string") throw new Error("no ADB port");
  env.ADB_SERVER_SOCKET = `tcp:127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  serve?.kill();
  await serve?.exited;
  await observer?.close().catch(() => undefined);
  adb?.close();
  fixture?.stop(true);
  if (process.env.NDS_E2E_DIAGNOSTICS === "1" && existsSync(serveLog)) {
    console.error(`phone log:\n${readFileSync(serveLog, "utf8")}`);
  }
  rmSync(runtime, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("a phone and its browser are listed", async () => {
  const listed = await cli("phones");
  expect(listed.code).toBe(0);
  expect(listed.body.phones).toEqual([
    {
      serial,
      state: "device",
      model: "NDS_test_phone",
      browsers: [{ socket: "chrome_devtools_remote", product: expect.stringContaining("Chrome/") }],
    },
  ]);
});

test("the phone's host serves its browser", async () => {
  serve = Bun.spawn([binary, "phone", "serve", serial], {
    env,
    stdout: "ignore",
    stderr: Bun.file(serveLog),
  });
  await until(async () => (await phone("status")).body.enabled === true, "the phone link");
  const status = await phone("status");
  expect(String(status.body.browser)).toStartWith("Chrome/");
  // The desktop host is another one: this runtime directory has none.
  expect((await cli("status")).code).not.toBe(0);
});

test("agent code acts in a tab it opens and the browser shows the result", async () => {
  expect((await phone("session", "new", "mobile")).code).toBe(0);
  await until(async () => {
    const listed = (await phone("session", "list")).body;
    return (
      Array.isArray(listed) &&
      listed.some(
        (session: Record<string, unknown>) =>
          session.project === "mobile" && session.executor === true,
      )
    );
  }, "the executor");
  const result = await run(
    "mobile",
    `state.page = await context.newPage(); await state.page.goto("${origin}/"); await state.page.getByRole("button", { name: "Increment" }).click(); return await state.page.locator("#c").textContent()`,
  );
  expect(result.code).toBe(0);
  expect(result.body.value).toBe("1");
  const page = observer.pages().find((page) => page.url() === `${origin}/`);
  expect(await page?.locator("#c").textContent()).toBe("1");
});

test("the owner's tabs stay outside the agent session", async () => {
  const owner = await observer.newPage();
  await owner.goto(`${origin}/owner`);
  const result = await run("mobile", "JSON.stringify(context.pages().map((page) => page.url()))");
  expect(JSON.parse(String(result.body.value))).toEqual([`${origin}/`]);
});

test("a page the agent's tab opens joins its session", async () => {
  const result = await run(
    "mobile",
    `await state.page.goto("${origin}/opener");
     const [popup] = await Promise.all([context.waitForEvent("page"), state.page.getByRole("button", { name: "Open" }).click()]);
     await popup.waitForLoadState();
     return popup.url()`,
  );
  expect(result.body.value).toBe(`${origin}/popup`);
});

test("screenshots and owner notifications reach the phone", async () => {
  const result = await run(
    "mobile",
    `const shot = await state.page.screenshot();
     const notified = await notifyOwner(state.page, "Pass the check, it's yours");
     const cleared = await clearOwner(state.page);
     return JSON.stringify({ png: shot.subarray(1, 4).toString(), notification: notified.notification, cleared })`,
  );
  const value = JSON.parse(String(result.body.value));
  expect(value).toEqual({
    png: "PNG",
    notification: expect.stringMatching(/^nds-owner-\d+-1$/),
    cleared: {},
  });
  const posted = shells.find((command) => command.startsWith("cmd notification post"));
  expect(posted).toBe(
    `cmd notification post -S bigtext -t 'NDS agent mobile needs you' '${value.notification}' 'Pass the check, it'\\''s yours (127.0.0.1:${fixture.port})'`,
  );
  expect(shells).toContain(
    `cmd notification snooze --for 315360000000 '0|com.android.shell|2020|${value.notification}|2000'`,
  );
});

test("closing the session closes its tabs on the phone", async () => {
  expect((await phone("session", "close", "mobile")).code).toBe(0);
  await until(
    async () =>
      !observer
        .pages()
        .some((page) => page.url().startsWith(`${origin}/`) && !page.url().endsWith("/owner")),
    "closing the agent's tabs",
    10_000,
  );
  expect(observer.pages().some((page) => page.url() === `${origin}/owner`)).toBe(true);
});

// Android stops a browser in the background; `phone serve` waits for it and serves it again.
test("the phone's host comes back when the browser does", async () => {
  for (const stream of streams) stream.destroy();
  await until(
    async () => (await phone("status")).code !== 0,
    "the host ending with the browser",
    10_000,
  );
  await until(
    async () => (await phone("status")).body.enabled === true,
    "the host serving the browser again",
    20_000,
  );
  expect(JSON.stringify((await phone("session", "list")).body)).toBe("[]");
});

test("the owner's stop ends the phone's host", async () => {
  if (windows) {
    // Windows has no SIGINT for another process; the host ends with its process.
    serve?.kill();
  } else {
    serve?.kill("SIGINT");
    expect(await serve?.exited).toBe(0);
  }
  await serve?.exited;
  expect((await phone("status")).code).not.toBe(0);
});
