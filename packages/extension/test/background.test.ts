// The worker's own-life rules against a scripted chrome API. Each test loads a fresh worker, holds
// Chrome's answers where a race lies, and checks what the host and Chrome see.
import { expect, test } from "bun:test";

type Message = Record<string, unknown>;
type Listener = (...args: unknown[]) => unknown;
type Tab = { id: number; groupId: number; windowId: number; url: string };
type Session = { tabId: number; sessionId?: string };

class Event {
  readonly listeners: Listener[] = [];
  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }
  fire(...args: unknown[]): void {
    for (const listener of this.listeners) listener(...args);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Chrome as far as the worker uses it: tabs in groups, debugger sessions, and one native port.
class Browser {
  readonly tabs = new Map<number, Tab>();
  readonly sessions = new Set<number>();
  readonly held = new Map<number, ReturnType<typeof deferred>>();
  readonly failingDetach = new Set<number>();
  readonly actions: string[] = [];
  readonly notifications: { id: string; message: string }[] = [];
  readonly evaluated: string[] = [];
  // Every command sent to Chrome, as "method tab" or "method tab/session".
  readonly commands: string[] = [];
  // Tabs whose frames the worker removed foreign iframes from.
  readonly scripted: number[] = [];
  readonly menu = new Event();
  readonly posted: Message[] = [];
  readonly port = { onMessage: new Event(), onDisconnect: new Event() };
  readonly events = {
    tabsCreated: new Event(),
    tabsUpdated: new Event(),
    tabsRemoved: new Event(),
    detached: new Event(),
    cdp: new Event(),
  };
  private next = 100;

  constructor(groups: Record<string, number>, tabs: [number, number][]) {
    this.groups = groups;
    for (const [id, groupId] of tabs)
      this.tabs.set(id, { id, groupId, windowId: 1, url: "https://example.test/" });
  }
  readonly groups: Record<string, number>;

  tab(id: number): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  }

  // The owner drags a tab into another group, or out of every group with -1.
  move(id: number, groupId: number): void {
    this.tab(id).groupId = groupId;
    this.events.tabsUpdated.fire(id, { groupId });
  }

  // Chrome ends a debugger session by itself.
  end(id: number): void {
    this.sessions.delete(id);
    this.events.detached.fire({ tabId: id }, "target_closed");
  }

  api() {
    const event = () => new Event();
    return {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({ groups: this.groups }), set: async () => {} },
      },
      action: { setBadgeText: async () => {} },
      runtime: {
        id: "worker",
        getURL: (path: string) => `chrome-extension://worker/${path}`,
        getManifest: () => ({ version: "0.0.4" }),
        reload: () => {},
        connectNative: () => ({
          postMessage: (message: Message) => this.posted.push(message),
          onMessage: this.port.onMessage,
          onDisconnect: this.port.onDisconnect,
        }),
        onMessage: event(),
        onStartup: event(),
        onInstalled: event(),
      },
      tabs: {
        get: async (id: number) => this.tab(id),
        query: async ({ groupId }: { groupId: number }) =>
          [...this.tabs.values()].filter((tab) => tab.groupId === groupId),
        create: async ({ url }: { url: string }) => {
          const tab = { id: this.next++, groupId: -1, windowId: 1, url };
          this.tabs.set(tab.id, tab);
          return tab;
        },
        group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
          for (const id of tabIds) this.move(id, groupId ?? 99);
          return groupId ?? 99;
        },
        update: async (id: number) => this.tab(id),
        remove: async (id: number) => {
          this.actions.push(`remove ${id}`);
          this.tab(id);
          this.tabs.delete(id);
          if (this.sessions.has(id)) this.end(id);
          this.events.tabsRemoved.fire(id);
        },
        onCreated: this.events.tabsCreated,
        onUpdated: this.events.tabsUpdated,
        onRemoved: this.events.tabsRemoved,
      },
      tabGroups: {
        get: async (id: number) => ({ id }),
        update: async () => ({}),
        onRemoved: event(),
      },
      windows: { get: async (id: number) => ({ id }), update: async () => ({}) },
      debugger: {
        attach: async ({ tabId }: Session) => {
          await this.held.get(tabId)?.promise;
          if (this.sessions.has(tabId)) throw new Error("Another debugger is already attached.");
          this.actions.push(`attach ${tabId}`);
          this.sessions.add(tabId);
        },
        detach: async ({ tabId }: Session) => {
          if (this.failingDetach.has(tabId)) throw new Error("Detach failed.");
          if (!this.sessions.delete(tabId)) throw new Error("Debugger is not attached.");
          this.actions.push(`detach ${tabId}`);
        },
        sendCommand: async (
          { tabId, sessionId }: Session,
          method: string,
          params?: { expression?: string },
        ) => {
          if (!this.sessions.has(tabId)) throw new Error("Debugger is not attached.");
          this.commands.push(`${method} ${tabId}${sessionId ? `/${sessionId}` : ""}`);
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Runtime.evaluate" && params?.expression) {
            this.evaluated.push(params.expression);
            if (params.expression.includes("ndsPinnedElem")) return { result: { value: 1 } };
          }
          return method === "Target.getTargetInfo" ? { targetInfo: { targetId: `t${tabId}` } } : {};
        },
        onEvent: this.events.cdp,
        onDetach: this.events.detached,
      },
      scripting: {
        executeScript: async ({ target }: { target: { tabId: number } }) => {
          this.scripted.push(target.tabId);
          return [];
        },
      },
      webNavigation: { onCreatedNavigationTarget: event() },
      notifications: {
        create: async (id: string, options: { message: string }) => {
          this.notifications.push({ id, message: options.message });
          return id;
        },
        clear: async () => true,
        onClicked: event(),
      },
      contextMenus: {
        create: () => {},
        removeAll: (done: () => void) => done(),
        onClicked: this.menu,
      },
    };
  }
}

let loads = 0;

async function worker(groups: Record<string, number>, tabs: [number, number][]) {
  const browser = new Browser(groups, tabs);
  (globalThis as unknown as { chrome: unknown }).chrome = browser.api();
  const source = "../src/background.ts";
  await import(`${source}?worker=${loads++}`);
  await until(() => browser.posted.some((message) => message.type === "hello"));
  let id = 0;
  // Sends one host request and returns a function that waits for its answer.
  const send = (message: Message) => {
    const request = { ...message, id: ++id };
    browser.port.onMessage.fire(request);
    return () =>
      until(() =>
        browser.posted.find((posted) => posted.type === "result" && posted.id === request.id),
      );
  };
  return { browser, send };
}

async function until<T>(found: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = found();
    if (value) return value;
    await Bun.sleep(2);
  }
  throw new Error("the worker did not answer");
}

const P = 10;
const Q = 20;

test("an attach the owner interrupts by moving the tab is never published and ends", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  browser.held.set(1, deferred());
  const claim = send({ type: "claim", group: "p" });
  await Bun.sleep(5);
  browser.move(1, -1);
  browser.held.get(1)?.resolve();
  expect(await claim()).toMatchObject({ result: { tabs: [] } });
  await until(() => !browser.sessions.has(1));
  expect(await send({ type: "cdp", tab: 1, method: "Runtime.evaluate" })()).toMatchObject({
    error: { code: "target_closed" },
  });
});

test("a pending attach of one life is never reused by another", async () => {
  const { browser, send } = await worker({ p: P, q: Q }, [[1, P]]);
  browser.held.set(1, deferred());
  const claimP = send({ type: "claim", group: "p" });
  await Bun.sleep(5);
  browser.move(1, Q);
  expect(await send({ type: "claim", group: "q" })()).toMatchObject({ error: { code: "busy" } });
  browser.held.get(1)?.resolve();
  expect(await claimP()).toMatchObject({ result: { tabs: [] } });
  await until(() => !browser.sessions.has(1));
  // Once life p's session ended, life q attaches the tab itself.
  expect(await send({ type: "claim", group: "q" })()).toMatchObject({
    result: { tabs: [{ tab: 1 }] },
  });
  expect(browser.sessions.has(1)).toBe(true);
});

test("release waits for an attach in flight, and nothing attaches after it", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  browser.held.set(1, deferred());
  send({ type: "claim", group: "p" });
  await Bun.sleep(5);
  const release = send({ type: "release", group: "p", close: false });
  await Bun.sleep(20);
  expect(
    browser.posted.some((posted) => posted.result && "released" in (posted.result as object)),
  ).toBe(false);
  browser.held.get(1)?.resolve();
  expect(await release()).toMatchObject({ result: { released: true } });
  expect(browser.sessions.size).toBe(0);
  // A tab the owner adds to the released group stays untouched.
  browser.tabs.set(2, { id: 2, groupId: P, windowId: 1, url: "https://example.test/" });
  browser.events.tabsCreated.fire(browser.tab(2));
  browser.move(2, P);
  await Bun.sleep(20);
  expect(browser.actions).not.toContain("attach 2");
});

test("a failed detach keeps the tab owned until Chrome reports the end", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  expect(await send({ type: "claim", group: "p" })()).toMatchObject({
    result: { tabs: [{ tab: 1 }] },
  });
  browser.failingDetach.add(1);
  expect(await send({ type: "release", group: "p", close: false })()).toMatchObject({
    error: { code: "cdp_error" },
  });
  // The next life waits for the old one: it neither starts nor takes the tab over.
  expect(await send({ type: "claim", group: "p" })()).toMatchObject({ error: { code: "busy" } });
  browser.end(1);
  expect(await send({ type: "release", group: "p", close: false })()).toMatchObject({
    result: { released: true },
  });
  browser.failingDetach.clear();
  expect(await send({ type: "claim", group: "p" })()).toMatchObject({
    result: { tabs: [{ tab: 1 }] },
  });
});

test("a closing release never closes a tab the owner took back", async () => {
  const { browser, send } = await worker({ p: P }, [
    [1, P],
    [2, P],
  ]);
  await send({ type: "claim", group: "p" })();
  browser.move(1, -1);
  expect(await send({ type: "release", group: "p", close: true })()).toMatchObject({
    result: { released: true },
  });
  expect(browser.actions).toContain("remove 2");
  expect(browser.actions).not.toContain("remove 1");
  expect(browser.tabs.has(1)).toBe(true);
  expect(browser.sessions.size).toBe(0);
});

test("the owner pins an element only in an agent tab", async () => {
  const { browser, send } = await worker({ p: P }, [
    [1, P],
    [9, -1],
  ]);
  await send({ type: "claim", group: "p" })();
  // Attaching installs the listener that remembers the element of a right-click.
  expect(browser.evaluated.some((expression) => expression.includes("__ndsContextTarget"))).toBe(
    true,
  );
  browser.menu.fire({ menuItemId: "nds-pin" }, { id: 1 });
  await until(() => browser.notifications.find((note) => note.id === "pin:1"));
  expect(browser.notifications.find((note) => note.id === "pin:1")?.message).toBe(
    "Pinned as ndsPinnedElem1.",
  );
  // A tab outside every agent group is never evaluated; the owner learns why.
  browser.menu.fire({ menuItemId: "nds-pin" }, { id: 9 });
  await until(() => browser.notifications.find((note) => note.id === "pin:9"));
  expect(browser.notifications.find((note) => note.id === "pin:9")?.message).toContain(
    "Only tabs in an NDS agent group",
  );
  expect(
    browser.evaluated.filter((expression) => expression.includes("ndsPinnedElem")),
  ).toHaveLength(1);
});

test("Runtime.enable makes Chrome report the page's execution contexts again", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const runtime = () => browser.commands.filter((sent) => /^Runtime\.(en|dis)able/.test(sent));
  await send({ type: "cdp", tab: 1, method: "Runtime.enable" })();
  expect(runtime()).toEqual(["Runtime.disable 1", "Runtime.enable 1"]);
  // A child session gets the same on that session.
  await send({ type: "cdp", tab: 1, session: "frame", method: "Runtime.enable" })();
  expect(runtime().slice(2)).toEqual(["Runtime.disable 1/frame", "Runtime.enable 1/frame"]);
});

test("another extension's frame is detached and never reaches the host", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const before = browser.posted.length;
  const foreign = { url: "chrome-extension://abcdefghijklmnop/menu.html" };
  browser.events.cdp.fire({ tabId: 1 }, "Target.attachedToTarget", {
    sessionId: "foreign",
    targetInfo: foreign,
  });
  browser.events.cdp.fire({ tabId: 1, sessionId: "foreign" }, "Runtime.consoleAPICalled", {});
  browser.events.cdp.fire({ tabId: 1 }, "Target.detachedFromTarget", { sessionId: "foreign" });
  browser.events.cdp.fire({ tabId: 1 }, "Network.dataReceived", {});
  browser.events.cdp.fire({ tabId: 1 }, "Target.attachedToTarget", {
    sessionId: "frame",
    targetInfo: { url: "https://example.test/frame" },
  });
  await until(() => browser.commands.includes("Target.detachFromTarget 1"));
  const events = browser.posted.slice(before).filter((posted) => posted.type === "event");
  expect(events.map((posted) => posted.method)).toEqual(["Target.attachedToTarget"]);
  expect(events[0]?.params).toMatchObject({ sessionId: "frame" });
  expect(browser.posted.slice(before).filter((posted) => posted.type === "telemetry")).toEqual([
    { type: "telemetry", event: "browser.target.restricted", outcome: "ok" },
  ]);
});

test("a tab Chrome detaches on its own is attached again with its setup", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  for (const method of ["Page.enable", "Network.enable", "Network.disable", "Runtime.enable"])
    await send({ type: "cdp", tab: 1, method })();
  browser.events.cdp.fire({ tabId: 1 }, "Target.attachedToTarget", {
    sessionId: "frame",
    targetInfo: { url: "https://example.test/frame" },
  });
  browser.commands.length = 0;
  browser.scripted.length = 0;
  const before = browser.posted.length;
  browser.end(1);
  await until(() => browser.sessions.has(1) && browser.commands.includes("Runtime.evaluate 1"));
  const posted = browser.posted.slice(before);
  expect(posted.some((message) => message.type === "detached")).toBe(false);
  await until(() => browser.posted.slice(before).find((message) => message.type === "telemetry"));
  expect(browser.posted.slice(before).filter((message) => message.type === "telemetry")).toEqual([
    { type: "telemetry", event: "browser.target.reattached", outcome: "ok" },
  ]);
  expect(posted.filter((message) => message.type === "event").map((event) => event.method)).toEqual(
    ["Runtime.executionContextsCleared", "Target.detachedFromTarget"],
  );
  // The replay keeps Playwright's order and drops what it disabled.
  expect(browser.commands.filter((sent) => sent.endsWith("able 1"))).toEqual([
    "Page.enable 1",
    "Runtime.enable 1",
  ]);
  expect(browser.scripted).toEqual([1]);
  expect(await send({ type: "cdp", tab: 1, method: "Runtime.evaluate" })()).toMatchObject({
    result: {},
  });
});

test("a tab Chrome keeps detaching is given up after a few reattaches", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const restored = () => browser.commands.filter((sent) => sent === "Runtime.evaluate 1").length;
  for (let round = 1; round <= 5; round++) {
    browser.end(1);
    await until(() => browser.sessions.has(1) && restored() === round + 1);
  }
  browser.end(1);
  expect(
    await until(() => browser.posted.find((posted) => posted.type === "detached")),
  ).toMatchObject({ tab: 1, reason: "target_closed" });
  expect(browser.posted.filter((posted) => posted.type === "telemetry").at(-1)).toEqual({
    type: "telemetry",
    event: "browser.target.reattached",
    outcome: "rejected",
    error: "reattach_limit",
  });
  expect(await send({ type: "cdp", tab: 1, method: "Runtime.evaluate" })()).toMatchObject({
    error: { code: "target_closed" },
  });
});

test("foreign frames are removed only from tabs in the agent group", async () => {
  const { browser, send } = await worker({ p: P, q: Q }, [
    [1, P],
    [2, Q],
  ]);
  await send({ type: "claim", group: "p" })();
  expect(browser.scripted).toEqual([1]);
});

test("a stale life or a tab that left its group gets no frame removal", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  await send({ type: "release", group: "p", close: false })();
  browser.scripted.length = 0;
  // The released life's tab moves out and back; no later attach of that life touches it.
  browser.move(1, -1);
  browser.move(1, P);
  await Bun.sleep(30);
  expect(browser.scripted).toEqual([]);
  // A new life scripts the tab it attaches.
  await send({ type: "claim", group: "p" })();
  expect(browser.scripted).toEqual([1]);
});
