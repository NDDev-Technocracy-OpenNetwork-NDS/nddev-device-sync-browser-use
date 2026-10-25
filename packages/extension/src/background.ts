// Thin browser layer for ADR 0015: the Rust host owns sessions and policy.
// This worker only attaches chrome.debugger to tabs in NDS-managed groups and
// relays their CDP traffic over native messaging. Other tabs are never touched.

const HOST = "ai.nddev.nds.browser_use";
const PROTOCOL = "1.3";
const ENABLED = "enabled";
const GROUPS = "groups";

type HostRequest =
  | { type: "cdp"; id: number; tab: number; session?: string; method: string; params?: object }
  | { type: "open"; id: number; group: string; url: string }
  | { type: "close"; id: number; tab: number }
  | { type: "claim"; id: number; group: string }
  | { type: "release"; id: number; group: string; close: boolean }
  | { type: "tabs"; id: number; tabs: number[] };

class Refusal extends Error {}

let port: chrome.runtime.Port | undefined;
let enabled = true;
let retry = 1000;
// Group key -> Chrome group id. Persisted for worker restarts in this browser session.
let groups = new Map<string, number>();
// Attached agent tab -> its group key.
const attached = new Map<number, string>();
// One attach attempt per tab, shared by concurrent callers.
const attaching = new Map<number, Promise<unknown>>();
// Tabs this worker is grouping itself; their announcement belongs to that path,
// not to the owner-sharing handler.
const grouping = new Set<number>();

async function load(): Promise<void> {
  const local = await chrome.storage.local.get(ENABLED);
  enabled = local[ENABLED] !== false;
  const session = await chrome.storage.session.get(GROUPS);
  groups = new Map(Object.entries((session[GROUPS] ?? {}) as Record<string, number>));
  await badge();
}

function saveGroups(): Promise<void> {
  return chrome.storage.session.set({ [GROUPS]: Object.fromEntries(groups) });
}

async function badge(): Promise<void> {
  await chrome.action.setBadgeText({ text: enabled ? (port ? "" : "…") : "OFF" });
}

function send(message: object): void {
  port?.postMessage(message);
}

function connect(): void {
  if (port) return;
  const next = chrome.runtime.connectNative(HOST);
  port = next;
  next.onMessage.addListener((message: HostRequest) => {
    void handle(message);
  });
  next.onDisconnect.addListener(() => {
    // The host owned every session; without it no agent may keep control.
    port = undefined;
    void detachAll().then(badge);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60_000);
  });
  send({ type: "hello", protocol: PROTOCOL, userAgent: navigator.userAgent, enabled });
  void badge();
}

async function handle(message: HostRequest): Promise<void> {
  retry = 1000;
  try {
    send({ type: "result", id: message.id, result: await dispatch(message) });
  } catch (error) {
    const refusal = error instanceof Refusal;
    send({
      type: "result",
      id: message.id,
      error: {
        code: refusal ? error.message : "cdp_error",
        message: refusal ? error.message : String((error as Error).message ?? error),
      },
    });
  }
}

async function dispatch(message: HostRequest): Promise<unknown> {
  if (!enabled) throw new Refusal("permission_required");
  switch (message.type) {
    case "cdp": {
      if (!attached.has(message.tab)) throw new Refusal("target_closed");
      const target: chrome.debugger.DebuggerSession = { tabId: message.tab };
      if (message.session) target.sessionId = message.session;
      return (await chrome.debugger.sendCommand(target, message.method, message.params)) ?? {};
    }
    case "open": {
      const tab = await chrome.tabs.create({ url: message.url, active: false });
      if (tab.id === undefined) throw new Refusal("target_closed");
      const id = tab.id;
      return own(id, async () => {
        await join(id, message.group);
        return { tab: id, target: await attach(id, message.group) };
      });
    }
    case "close": {
      if (!attached.has(message.tab)) throw new Refusal("target_closed");
      await chrome.tabs.remove(message.tab);
      return {};
    }
    case "claim": {
      const tabs = await owned(message.group);
      const result = [];
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        result.push({ tab: tab.id, target: await attach(tab.id, message.group) });
      }
      return { tabs: result };
    }
    case "release": {
      for (const [tab, group] of attached) {
        if (group !== message.group) continue;
        attached.delete(tab);
        if (message.close) await chrome.tabs.remove(tab).catch(() => undefined);
        else await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
      }
      return {};
    }
    case "tabs": {
      const result = [];
      for (const id of message.tabs) {
        if (!attached.has(id)) continue;
        const tab = await chrome.tabs.get(id).catch(() => undefined);
        if (!tab) continue;
        // The current main-frame loader identifies the document agents see now.
        const tree = (await chrome.debugger
          .sendCommand({ tabId: id }, "Page.getFrameTree")
          .catch(() => undefined)) as { frameTree?: { frame?: { loaderId?: string } } } | undefined;
        const document = tree?.frameTree?.frame?.loaderId;
        result.push({ tab: id, url: tab.url ?? "", title: tab.title ?? "", document });
      }
      return { tabs: result };
    }
  }
}

async function owned(group: string): Promise<chrome.tabs.Tab[]> {
  const id = groups.get(group);
  if (id === undefined) return [];
  const exists = await chrome.tabGroups.get(id).catch(() => undefined);
  if (!exists) {
    groups.delete(group);
    await saveGroups();
    return [];
  }
  return chrome.tabs.query({ groupId: id });
}

async function join(tab: number, group: string): Promise<void> {
  const current = groups.get(group);
  const valid =
    current !== undefined && (await chrome.tabGroups.get(current).catch(() => undefined));
  if (valid) {
    await chrome.tabs.group({ tabIds: [tab], groupId: current });
    return;
  }
  const created = await chrome.tabs.group({ tabIds: [tab] });
  await chrome.tabGroups.update(created, { title: group, color: "cyan", collapsed: false });
  groups.set(group, created);
  await saveGroups();
}

async function own<T>(tab: number, work: () => Promise<T>): Promise<T> {
  grouping.add(tab);
  try {
    return await work();
  } finally {
    grouping.delete(tab);
  }
}

function attach(tab: number, group: string): Promise<unknown> {
  const current = attaching.get(tab);
  if (current) return current;
  const next = (async () => {
    if (!attached.has(tab)) {
      await chrome.debugger.attach({ tabId: tab }, PROTOCOL);
      attached.set(tab, group);
    }
    const info = (await chrome.debugger.sendCommand({ tabId: tab }, "Target.getTargetInfo")) as {
      targetInfo: unknown;
    };
    return info.targetInfo;
  })().finally(() => attaching.delete(tab));
  attaching.set(tab, next);
  return next;
}

async function detachAll(): Promise<void> {
  const tabs = [...attached.keys()];
  attached.clear();
  await Promise.all(
    tabs.map((tab) => chrome.debugger.detach({ tabId: tab }).catch(() => undefined)),
  );
}

function groupKey(groupId: number | undefined): string | undefined {
  for (const [key, id] of groups) if (id === groupId) return key;
  return undefined;
}

// Tabs being announced; several Chrome events can report the same new tab.
const adopting = new Set<number>();

async function adopt(tab: number, group: string): Promise<void> {
  if (!enabled || !port || attached.has(tab) || adopting.has(tab)) return;
  adopting.add(tab);
  try {
    // A failed attach leaves the tab unattached; nothing is announced.
    const target = await attach(tab, group).catch(() => undefined);
    if (target !== undefined) send({ type: "attached", tab, group, target });
  } finally {
    adopting.delete(tab);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !attached.has(source.tabId)) return;
  send({ type: "event", tab: source.tabId, session: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined || !attached.delete(source.tabId)) return;
  send({ type: "detached", tab: source.tabId, reason });
});

// A tab created inside an agent group (for example with the group's "+")
// belongs to that agent area.
chrome.tabs.onCreated.addListener((tab) => {
  const group = groupKey(tab.groupId);
  if (tab.id !== undefined && group !== undefined) void adopt(tab.id, group);
});

// Popups and target=_blank links opened by an agent tab stay in its area.
// webNavigation names the real source tab, unlike `openerTabId`, and works
// whether or not Chrome grouped the new tab itself.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const group = attached.get(details.sourceTabId);
  if (group === undefined) return;
  const id = details.tabId;
  void own(id, async () => {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    if (!tab) return;
    if (groupKey(tab.groupId) !== group) await join(id, group).catch(() => undefined);
    await adopt(id, group);
  });
});

// Moving a tab into an agent group shares it; moving it out revokes control.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.groupId === undefined || grouping.has(tabId)) return;
  const current = attached.get(tabId);
  const target = groupKey(change.groupId);
  if (current !== undefined && current !== target) {
    void revoke(tabId);
  } else if (current === undefined && target !== undefined) {
    void adopt(tabId, target);
  }
});

// Closing tabs and windows also clears their group; that is a closed target
// reported by onDetach, not the owner moving the tab out of the agent area.
async function revoke(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const window = tab && (await chrome.windows.get(tab.windowId).catch(() => undefined));
  if (!tab || !window || groupKey(tab.groupId) !== undefined) return;
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
  send({ type: "detached", tab: tabId, reason: "revoked" });
}

chrome.tabGroups.onRemoved.addListener((group) => {
  const key = groupKey(group.id);
  if (key === undefined) return;
  groups.delete(key);
  void saveGroups();
});

// The owner's switch in the action popup: disabling detaches every agent tab
// and the host refuses new work until it is enabled again.
async function setEnabled(value: boolean): Promise<void> {
  enabled = value;
  await chrome.storage.local.set({ [ENABLED]: enabled });
  if (!enabled) await detachAll();
  send({ type: "control", enabled });
  if (!port) connect();
  await badge();
}

chrome.runtime.onMessage.addListener(
  (message: { type?: string; enabled?: boolean }, sender, reply) => {
    // Only this extension's own pages (the popup) may change the switch.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))
      return false;
    if (message.type === "set" && typeof message.enabled === "boolean") {
      void setEnabled(message.enabled).then(() =>
        reply({ enabled, connected: port !== undefined }),
      );
      return true;
    }
    if (message.type === "get")
      reply({ enabled, connected: port !== undefined, tabs: attached.size });
    return false;
  },
);

chrome.runtime.onStartup.addListener(connect);
void load().then(connect);
