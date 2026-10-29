// The worker's own-life rules against a scripted chrome API. Each test loads a fresh worker, holds
// Chrome's answers where a race lies, and checks what the host and Chrome see.
import { expect, test } from "bun:test";

type Message = Record<string, unknown>;
type Listener = (...args: unknown[]) => unknown;
type Tab = { id: number; groupId: number; windowId: number; url: string };
type Session = { tabId: number; sessionId?: string };
type Download = {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  state: string;
  fileSize: number;
  bytesReceived: number;
  error?: string;
};

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
  // Every detach the worker attempted, whether Chrome accepted it or not.
  readonly detachAttempts: number[] = [];
  // Commands that fail, and commands whose answer waits, by method.
  readonly failing = new Set<string>();
  readonly heldCommands = new Map<string, ReturnType<typeof deferred>>();
  readonly actions: string[] = [];
  readonly notifications: { id: string; message: string }[] = [];
  // Notifications Chrome still shows, by id, and the clears and focus calls the worker made.
  readonly shown = new Set<string>();
  readonly focus: string[] = [];
  readonly notificationClicked = new Event();
  readonly notificationButton = new Event();
  readonly evaluated: string[] = [];
  // Every command sent to Chrome, as "method tab" or "method tab/session".
  readonly commands: string[] = [];
  // Tabs whose frames the worker removed foreign iframes from, and cleanups that wait, by tab.
  readonly scripted: number[] = [];
  readonly heldScripts = new Map<number, ReturnType<typeof deferred>>();
  readonly menu = new Event();
  // Downloads Chrome knows, by id, and the files and list entries the worker removed.
  readonly downloads = new Map<number, Download>();
  readonly removed: string[] = [];
  readonly downloadCreated = new Event();
  readonly downloadChanged = new Event();
  readonly navigationTarget = new Event();
  readonly posted: Message[] = [];
  readonly port = { onMessage: new Event(), onDisconnect: new Event() };
  // The execution context of each Runtime.evaluate: 7 is the worker's isolated world.
  readonly worlds: (number | undefined)[] = [];
  // The action badge as the worker last set it, and messages from the extension's own pages.
  badge = "";
  readonly popup = new Event();
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

  // Chrome starts a download and later finishes it, as its downloads API reports them.
  download(id: number, url: string, finalUrl = url): Download {
    const item = {
      id,
      url,
      finalUrl,
      filename: "",
      state: "in_progress",
      fileSize: 0,
      bytesReceived: 0,
    };
    this.downloads.set(id, item);
    this.downloadCreated.fire({ ...item });
    return item;
  }

  finish(id: number, filename: string, state = "complete"): void {
    const item = this.downloads.get(id);
    if (!item) throw new Error(`No download ${id}`);
    Object.assign(item, { filename, state, fileSize: 5, bytesReceived: 5 });
    this.downloadChanged.fire({ id, filename: { current: filename } });
    this.downloadChanged.fire({ id, state: { current: state } });
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
      action: {
        setBadgeText: async ({ text }: { text: string }) => {
          this.badge = text;
        },
      },
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
        onMessage: this.popup,
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
        update: async (id: number, change?: { active?: boolean }) => {
          if (change?.active) this.focus.push(`tab ${id}`);
          return this.tab(id);
        },
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
        update: async (id: number, change?: { collapsed?: boolean }) => {
          if (change?.collapsed === false) this.focus.push(`group ${id}`);
          return { id };
        },
        onRemoved: event(),
      },
      windows: {
        get: async (id: number) => ({ id }),
        update: async (id: number, change?: { focused?: boolean }) => {
          if (change?.focused) this.focus.push(`window ${id}`);
          return { id };
        },
      },
      debugger: {
        attach: async ({ tabId }: Session) => {
          await this.held.get(tabId)?.promise;
          if (this.sessions.has(tabId)) throw new Error("Another debugger is already attached.");
          this.actions.push(`attach ${tabId}`);
          this.sessions.add(tabId);
        },
        detach: async ({ tabId }: Session) => {
          this.detachAttempts.push(tabId);
          if (this.failingDetach.has(tabId)) throw new Error("Detach failed.");
          if (!this.sessions.delete(tabId)) throw new Error("Debugger is not attached.");
          this.actions.push(`detach ${tabId}`);
        },
        sendCommand: async (
          { tabId, sessionId }: Session,
          method: string,
          params?: { expression?: string; contextId?: number },
        ) => {
          if (!this.sessions.has(tabId)) throw new Error("Debugger is not attached.");
          this.commands.push(`${method} ${tabId}${sessionId ? `/${sessionId}` : ""}`);
          await this.heldCommands.get(method)?.promise;
          if (this.failing.has(method)) throw new Error(`${method} failed.`);
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
          if (method === "Runtime.evaluate" && params?.expression) {
            this.evaluated.push(params.expression);
            this.worlds.push(params.contextId);
            if (params.expression.includes('setAttribute("data-nds-pin"')) {
              return { result: { value: 1 } };
            }
          }
          return method === "Target.getTargetInfo" ? { targetInfo: { targetId: `t${tabId}` } } : {};
        },
        getTargets: async () =>
          [...this.sessions].map((tabId) => ({ tabId, type: "page", id: `t${tabId}` })),
        onEvent: this.events.cdp,
        onDetach: this.events.detached,
      },
      downloads: {
        search: async ({ id }: { id: number }) => {
          const item = this.downloads.get(id);
          return item ? [{ ...item }] : [];
        },
        removeFile: async (id: number) => {
          this.removed.push(`file ${id}`);
        },
        erase: async ({ id }: { id: number }) => {
          this.removed.push(`entry ${id}`);
          return [id];
        },
        onCreated: this.downloadCreated,
        onChanged: this.downloadChanged,
      },
      scripting: {
        executeScript: async ({ target }: { target: { tabId: number } }) => {
          this.scripted.push(target.tabId);
          await this.heldScripts.get(target.tabId)?.promise;
          return [];
        },
      },
      webNavigation: { onCreatedNavigationTarget: this.navigationTarget },
      notifications: {
        create: async (id: string, options: { message: string }) => {
          this.notifications.push({ id, message: options.message });
          this.shown.add(id);
          return id;
        },
        clear: async (id: string) => this.shown.delete(id),
        getAll: async () => Object.fromEntries([...this.shown].map((id) => [id, true])),
        onClicked: this.notificationClicked,
        onButtonClicked: this.notificationButton,
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
  expect(
    await send({ type: "cdp", group: "p", tab: 1, method: "Runtime.evaluate" })(),
  ).toMatchObject({
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
  // Attaching installs the listener that remembers the element of a right-click, in the worker's
  // isolated world, which the page cannot see.
  const listener = browser.evaluated.findIndex((expression) =>
    expression.includes("__ndsContextTarget"),
  );
  expect(listener).toBeGreaterThanOrEqual(0);
  expect(browser.worlds[listener]).toBe(7);
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
  // Only the pin itself reaches the page's own world, by its one name.
  const named = browser.evaluated.filter((expression) => expression.includes("ndsPinnedElem"));
  expect(named).toEqual([
    `globalThis.ndsPinnedElem1 = document.querySelector('[data-nds-pin="1"]')`,
  ]);
  expect(browser.worlds[browser.evaluated.indexOf(named[0] ?? "")]).toBeUndefined();
});

test("an owner notification ends with the agent's hold on its tab", async () => {
  const { browser, send } = await worker({ p: P }, [
    [1, P],
    [2, P],
  ]);
  await send({ type: "claim", group: "p" })();
  const notify = (tab: number) =>
    send({
      type: "cdp",
      group: "p",
      tab,
      method: "NDS.notifyOwner",
      params: { reason: "Pass it" },
    })();
  expect(await notify(1)).toMatchObject({ result: { notification: "owner:1" } });
  expect(await notify(2)).toMatchObject({ result: { notification: "owner:2" } });
  expect(browser.shown).toEqual(new Set(["owner:1", "owner:2"]));
  // The owner takes tab 2 out of the agent group: its check is no agent's any more.
  browser.move(2, -1);
  await until(() => !browser.shown.has("owner:2"));
  // The session releases the rest without closing tabs: nothing stays to ask for a person.
  await send({ type: "release", group: "p", close: false })();
  await until(() => browser.shown.size === 0);
  expect(browser.tabs.has(1)).toBe(true);
});

test("an owner notification opens its tab, its group and its window", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  await send({ type: "cdp", group: "p", tab: 1, method: "NDS.notifyOwner", params: {} })();
  browser.notificationClicked.fire("owner:1");
  await until(() => browser.focus.includes("window 1"));
  expect(browser.focus).toEqual([`group ${P}`, "tab 1", "window 1"]);
  expect(browser.shown.has("owner:1")).toBe(false);
  // Its button does the same; a notification for a tab that is gone opens nothing.
  await send({ type: "cdp", group: "p", tab: 1, method: "NDS.notifyOwner", params: {} })();
  browser.focus.length = 0;
  browser.notificationButton.fire("owner:1", 0);
  await until(() => browser.focus.includes("window 1"));
  browser.focus.length = 0;
  browser.notificationClicked.fire("owner:77");
  await Bun.sleep(20);
  expect(browser.focus).toEqual([]);
});

test("a new worker clears the owner notifications an earlier one left", async () => {
  const browser = new Browser({ p: P }, [[1, P]]);
  browser.shown.add("owner:1");
  browser.shown.add("pin:1");
  (globalThis as unknown as { chrome: unknown }).chrome = browser.api();
  const source = "../src/background.ts";
  await import(`${source}?worker=${loads++}`);
  await until(() => !browser.shown.has("owner:1"));
  expect(browser.shown).toEqual(new Set(["pin:1"]));
});

test("Runtime.enable makes Chrome report the page's execution contexts again", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const runtime = () => browser.commands.filter((sent) => /^Runtime\.(en|dis)able/.test(sent));
  await send({ type: "cdp", group: "p", tab: 1, method: "Runtime.enable" })();
  expect(runtime()).toEqual(["Runtime.disable 1", "Runtime.enable 1"]);
  // A child session gets the same on that session.
  await send({ type: "cdp", group: "p", tab: 1, session: "frame", method: "Runtime.enable" })();
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
    await send({ type: "cdp", group: "p", tab: 1, method })();
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
  expect(
    await send({ type: "cdp", group: "p", tab: 1, method: "Runtime.evaluate" })(),
  ).toMatchObject({
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
  expect(
    await send({ type: "cdp", group: "p", tab: 1, method: "Runtime.evaluate" })(),
  ).toMatchObject({
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

test("a reattach that cannot restore or detach keeps its session until a release detaches it", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.failing.add("Page.getFrameTree");
  browser.failingDetach.add(1);
  const before = browser.posted.length;
  browser.end(1);
  await until(() => browser.posted.slice(before).find((posted) => posted.type === "detached"));
  // The new session lives on; no release may confirm the tab is out of this worker's control.
  expect(browser.sessions.has(1)).toBe(true);
  expect(await send({ type: "release", group: "p", close: false })()).toMatchObject({
    error: { code: "cdp_error" },
  });
  expect(await send({ type: "claim", group: "p" })()).toMatchObject({ error: { code: "busy" } });
  browser.failingDetach.delete(1);
  expect(await send({ type: "release", group: "p", close: false })()).toMatchObject({
    result: { released: true },
  });
  expect(browser.sessions.has(1)).toBe(false);
});

test("a release that waited for a reattach never closes a tab the owner took back", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.held.set(1, deferred());
  browser.end(1);
  await Bun.sleep(5);
  const release = send({ type: "release", group: "p", close: true });
  await Bun.sleep(5);
  browser.move(1, -1);
  browser.held.get(1)?.resolve();
  await release();
  await Bun.sleep(10);
  expect(browser.actions).not.toContain("remove 1");
  expect(browser.tabs.has(1)).toBe(true);
});

test("a reattach that lost its tab while waiting replays nothing into it", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  await send({ type: "cdp", group: "p", tab: 1, method: "Page.enable" })();
  const info = deferred();
  browser.heldCommands.set("Target.getTargetInfo", info);
  browser.commands.length = 0;
  browser.end(1);
  await until(() => browser.sessions.has(1));
  browser.move(1, -1);
  info.resolve();
  await until(() => !browser.sessions.has(1));
  await Bun.sleep(10);
  expect(browser.commands).not.toContain("Page.enable 1");
  expect(browser.commands).not.toContain("Runtime.evaluate 1");
});

test("a revoke that waited for a reattach acts on nothing the reattach ended", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.held.set(1, deferred());
  browser.end(1);
  await Bun.sleep(5);
  // The owner takes the tab back while the reattach waits for Chrome.
  browser.move(1, -1);
  await Bun.sleep(5);
  browser.held.get(1)?.resolve();
  await until(() => browser.posted.find((posted) => posted.type === "detached"));
  await Bun.sleep(20);
  // The reattach detached its own new session once; nothing acted on the tab afterwards.
  expect(browser.detachAttempts).toEqual([1]);
  expect(browser.actions).not.toContain("remove 1");
});

test("setup a reattach could not restore in full is refused before it reaches Chrome", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const script = "Page.addScriptToEvaluateOnNewDocument";
  for (let index = 0; index < 256; index++)
    await send({
      type: "cdp",
      group: "p",
      tab: 1,
      method: script,
      params: { source: `${index}` },
    })();
  browser.commands.length = 0;
  expect(
    await send({ type: "cdp", group: "p", tab: 1, method: script, params: { source: "over" } })(),
  ).toMatchObject({ error: { code: "capacity" } });
  expect(browser.commands).toEqual([]);
});

test("of two setup commands in flight for the last slot exactly one is admitted", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const script = "Page.addScriptToEvaluateOnNewDocument";
  for (let index = 0; index < 255; index++)
    await send({
      type: "cdp",
      group: "p",
      tab: 1,
      method: script,
      params: { source: `${index}` },
    })();
  const held = deferred();
  browser.heldCommands.set(script, held);
  const first = send({ type: "cdp", group: "p", tab: 1, method: script, params: { source: "a" } });
  await Bun.sleep(5);
  const second = send({ type: "cdp", group: "p", tab: 1, method: script, params: { source: "b" } });
  expect(await second()).toMatchObject({ error: { code: "capacity" } });
  held.resolve();
  expect(await first()).toMatchObject({ result: {} });
  expect(browser.commands.filter((sent) => sent.startsWith(script)).length).toBe(256 + 1);
});

test("a tab that moves during frame cleanup is never attached", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  const cleanup = deferred();
  browser.heldScripts.set(1, cleanup);
  const claim = send({ type: "claim", group: "p" });
  await until(() => browser.scripted.includes(1));
  browser.move(1, -1);
  cleanup.resolve();
  expect(await claim()).toMatchObject({ result: { tabs: [] } });
  expect(browser.actions).not.toContain("attach 1");
});

test("a reattach that loses its tab between the pin script's two commands sends no second", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const pin = deferred();
  browser.heldCommands.set("Page.addScriptToEvaluateOnNewDocument", pin);
  browser.commands.length = 0;
  browser.end(1);
  await until(() => browser.commands.includes("Page.addScriptToEvaluateOnNewDocument 1"));
  browser.move(1, -1);
  pin.resolve();
  await until(() => !browser.sessions.has(1));
  await Bun.sleep(10);
  expect(browser.commands).not.toContain("Runtime.evaluate 1");
});

test("a failed reattach never detaches the session another life took on its tab meanwhile", async () => {
  const { browser, send } = await worker({ p: P, q: Q }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  await send({ type: "claim", group: "q" })();
  const tree = deferred();
  browser.heldCommands.set("Page.getFrameTree", tree);
  browser.end(1);
  await until(() => browser.commands.includes("Page.getFrameTree 1"));
  // Chrome ends the new session too, and life q takes the tab.
  browser.end(1);
  browser.move(1, Q);
  await until(() => browser.sessions.has(1));
  const attempts = browser.detachAttempts.length;
  tree.resolve();
  await Bun.sleep(20);
  expect(browser.detachAttempts.length).toBe(attempts);
  expect(browser.sessions.has(1)).toBe(true);
  expect(
    await send({ type: "cdp", group: "q", tab: 1, method: "Runtime.evaluate" })(),
  ).toMatchObject({
    result: {},
  });
});

test("a command held while its life ends never reaches the next life's attachment", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const disable = deferred();
  browser.heldCommands.set("Runtime.disable", disable);
  const enable = send({ type: "cdp", group: "p", tab: 1, method: "Runtime.enable" });
  await until(() => browser.commands.includes("Runtime.disable 1"));
  expect(await send({ type: "release", group: "p", close: false })()).toMatchObject({
    result: { released: true },
  });
  await send({ type: "claim", group: "p" })();
  browser.heldCommands.delete("Runtime.disable");
  browser.commands.length = 0;
  disable.resolve();
  expect(await enable()).toMatchObject({ error: { code: "target_closed" } });
  expect(browser.commands).not.toContain("Runtime.enable 1");
});

test("setup answered after its life ended is never recorded for the next life", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  const answer = deferred();
  browser.heldCommands.set("Page.enable", answer);
  const enable = send({ type: "cdp", group: "p", tab: 1, method: "Page.enable" });
  await until(() => browser.commands.includes("Page.enable 1"));
  await send({ type: "release", group: "p", close: false })();
  await send({ type: "claim", group: "p" })();
  browser.heldCommands.delete("Page.enable");
  answer.resolve();
  expect(await enable()).toMatchObject({ error: { code: "target_closed" } });
  // A reattach of the new life replays nothing the old one set up.
  browser.commands.length = 0;
  browser.end(1);
  await until(() => browser.sessions.has(1) && browser.commands.includes("Runtime.evaluate 1"));
  expect(browser.commands).not.toContain("Page.enable 1");
});

test("a command waiting for a reattach that failed is refused, not sent to the tab", async () => {
  const { browser, send } = await worker({ p: P, q: Q }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.commands.length = 0;
  browser.held.set(1, deferred());
  browser.end(1);
  await Bun.sleep(5);
  const waiting = send({ type: "cdp", group: "p", tab: 1, method: "Runtime.evaluate" });
  await Bun.sleep(5);
  browser.move(1, Q);
  browser.held.get(1)?.resolve();
  expect(await waiting()).toMatchObject({ error: { code: "target_closed" } });
  // The old command went nowhere; life q's own attach then sends only its pin script.
  expect(browser.commands).not.toContain("Runtime.evaluate 1");
});

test("a command or close of another group never acts on the tab", async () => {
  const { browser, send } = await worker({ p: P, q: Q }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  await send({ type: "claim", group: "q" })();
  // The owner moves p's tab into q; p is released, and q's claim takes the tab.
  browser.move(1, Q);
  await send({ type: "release", group: "p", close: false })();
  await send({ type: "claim", group: "q" })();
  expect(browser.sessions.has(1)).toBe(true);
  browser.commands.length = 0;
  // Requests p queued earlier arrive now: they refuse instead of acting on q's attachment.
  expect(
    await send({ type: "cdp", group: "p", tab: 1, method: "Runtime.evaluate" })(),
  ).toMatchObject({ error: { code: "target_closed" } });
  expect(await send({ type: "close", group: "p", tab: 1 })()).toMatchObject({
    error: { code: "target_closed" },
  });
  // A request without its group never acts either.
  expect(await send({ type: "cdp", tab: 1, method: "Runtime.evaluate" })()).toMatchObject({
    error: { code: "target_closed" },
  });
  expect(browser.commands).toEqual([]);
  expect(browser.tabs.has(1)).toBe(true);
  expect(
    await send({ type: "cdp", group: "q", tab: 1, method: "Runtime.evaluate" })(),
  ).toMatchObject({ result: {} });
});

// A host of another contract says so; the badge and the popup tell the owner why nothing works.
test("a host of another contract is shown to the owner", async () => {
  const { browser } = await worker({ p: P }, [[1, P]]);
  browser.port.onMessage.fire({ type: "incompatible", contract: 3 });
  await until(() => browser.badge === "!");
  const status = await new Promise<Record<string, unknown>>((reply) =>
    browser.popup.fire(
      { type: "get" },
      { id: "worker", url: "chrome-extension://worker/popup.html" },
      reply,
    ),
  );
  expect(status).toMatchObject({ connected: true, hostContract: 3 });
});

// An agent tab's download is told to the host with its finished file, and only the host's word
// that it kept a copy lets the browser's copy and its list entry go.
test("an agent tab's download goes to the host, and the browser copy only once the host kept it", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.events.cdp.fire({ tabId: 1 }, "Page.downloadWillBegin", {
    guid: "g1",
    url: "https://example.test/final.pdf",
    frameId: "t1",
    suggestedFilename: "final.pdf",
  });
  browser.download(5, "https://example.test/export", "https://example.test/final.pdf");
  browser.finish(5, "/home/owner/Downloads/final.pdf");
  const reported = await until(() => browser.posted.find((posted) => posted.type === "download"));
  expect(reported).toEqual({
    type: "download",
    group: "p",
    id: 5,
    urls: ["https://example.test/export", "https://example.test/final.pdf"],
    name: "final.pdf",
    state: "complete",
    path: "/home/owner/Downloads/final.pdf",
  });
  expect(browser.removed).toEqual([]);
  expect(await send({ type: "forget", download: 5 })()).toMatchObject({ result: {} });
  expect(browser.removed).toEqual(["file 5", "entry 5"]);
});

// A small file can be complete before the agent tab's CDP event reaches the worker, on a loaded
// machine: the download is still the agent's, and it goes to the host once the event arrives.
test("a download that finished before its agent tab announced it still goes to the host", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.download(9, "https://example.test/small.bin");
  browser.finish(9, "/home/owner/Downloads/small (1).bin");
  await Bun.sleep(10);
  expect(browser.posted.find((posted) => posted.type === "download")).toBeUndefined();
  browser.events.cdp.fire({ tabId: 1 }, "Page.downloadWillBegin", {
    guid: "g9",
    url: "https://example.test/small.bin",
    frameId: "t1",
    suggestedFilename: "small.bin",
  });
  const reported = await until(() => browser.posted.find((posted) => posted.type === "download"));
  expect(reported).toMatchObject({
    group: "p",
    id: 9,
    name: "small.bin",
    state: "complete",
    path: "/home/owner/Downloads/small (1).bin",
  });
});

// A tab an agent tab opened closes once its download starts, before any debugger reaches it; its
// download is reported on the opener, and its own events never reach the host.
test("a download from a tab an agent tab opened is reported on the opener", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.navigationTarget.fire({ sourceTabId: 1, tabId: 30, url: "https://example.test/file" });
  browser.download(6, "https://example.test/file");
  browser.finish(6, "/home/owner/Downloads/file.csv");
  await until(() => browser.posted.find((posted) => posted.type === "download"));
  const events = browser.posted.filter((posted) => posted.type === "event" && posted.tab === 1);
  expect(events.map((event) => event.method)).toEqual([
    "Page.downloadWillBegin",
    "Page.downloadProgress",
  ]);
  const [begun, ended] = events.map((event) => event.params as Record<string, unknown>);
  expect(begun).toMatchObject({
    frameId: "t1",
    url: "https://example.test/file",
    suggestedFilename: "file.csv",
  });
  expect(ended).toMatchObject({ guid: begun?.guid, state: "completed", totalBytes: 5 });
  expect(browser.posted.find((posted) => posted.type === "download")).toMatchObject({
    group: "p",
    id: 6,
    state: "complete",
  });
});

// The owner's own downloads, in tabs of no agent, are never reported or removed.
test("a download no agent tab announced stays the owner's", async () => {
  const { browser, send } = await worker({ p: P }, [[1, P]]);
  await send({ type: "claim", group: "p" })();
  browser.events.cdp.fire({ tabId: 1 }, "Page.downloadWillBegin", {
    guid: "g1",
    url: "https://example.test/agent.pdf",
  });
  browser.download(7, "https://owner.test/mine.pdf");
  browser.finish(7, "/home/owner/Downloads/mine.pdf");
  browser.download(8, "https://example.test/failed.pdf");
  browser.events.cdp.fire({ tabId: 1 }, "Page.downloadWillBegin", {
    guid: "g2",
    url: "https://example.test/failed.pdf",
  });
  browser.finish(8, "", "interrupted");
  const failed = await until(() => browser.posted.find((posted) => posted.type === "download"));
  expect(failed).toMatchObject({
    id: 8,
    state: "interrupted",
    urls: ["https://example.test/failed.pdf"],
  });
  await Bun.sleep(20);
  expect(browser.posted.filter((posted) => posted.type === "download")).toHaveLength(1);
  expect(browser.removed).toEqual([]);
});
