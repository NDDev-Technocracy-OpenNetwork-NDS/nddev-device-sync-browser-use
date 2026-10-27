// Thin browser layer for ADR 0015: the Rust host owns sessions and policy.
// This worker only attaches chrome.debugger to tabs in NDS-managed groups and
// relays their CDP traffic over native messaging. Other tabs are never touched.

const HOST = "ai.nddev.nds.browser_use";
const PROTOCOL = "1.3";
const ENABLED = "enabled";
const GROUPS = "groups";
const RELOADED_FOR = "reloadedFor";
const OWNER = "owner:";

type HostRequest =
  | { type: "cdp"; id: number; tab: number; session?: string; method: string; params?: object }
  | { type: "open"; id: number; group: string; url: string }
  | { type: "close"; id: number; tab: number }
  | { type: "claim"; id: number; group: string }
  | { type: "release"; id: number; group: string; close: boolean }
  | { type: "tabs"; id: number; tabs: number[] }
  | { type: "reload"; id?: undefined; version: string };

class Refusal extends Error {}

let port: chrome.runtime.Port | undefined;
let enabled = true;
let retry = 1000;
// Group key -> Chrome group id. Persisted for worker restarts in this browser session.
let groups = new Map<string, number>();

// One life of an agent group, from the host's claim to its release. Work that can attach a tab is
// admitted only while the life is open and stays counted until it settles, so a release closes the
// life before it awaits anything and then waits for that work before it detaches.
type Life = { group: string; open: boolean; close: boolean; work: Set<Promise<unknown>> };
// One debugger session of this worker on an agent tab. It ends only on Chrome's own word: this
// worker's detach or close resolved, or Chrome reported the session or the tab gone.
type Attachment = {
  life: Life;
  ended: boolean;
  // The tab left its agent group; no agent command or release closes it from then on.
  revoked: boolean;
  // Attached, but not yet confirmed in its group; agents cannot use it until it is.
  pending: boolean;
  ending?: Promise<void> | undefined;
};

// Group key -> its current life.
const lives = new Map<string, Life>();
// Attached agent tab -> its attachment.
const attached = new Map<number, Attachment>();
// One attach attempt per tab, bound to the life it attaches for; a tab moved out of that life's
// group meanwhile is marked, because no attachment exists yet that a revoke could mark.
type Attaching = { life: Life; moved: boolean; done: Promise<unknown> };
const attaching = new Map<number, Attaching>();
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
    if (message.type === "reload") void reloadFor(message.version);
    else void handle(message);
  });
  next.onDisconnect.addListener(() => {
    // The host owned every session; without it no agent may keep control.
    port = undefined;
    void detachAll().then(badge);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60_000);
  });
  send({
    type: "hello",
    protocol: PROTOCOL,
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    enabled,
  });
  void badge();
}

// The host found newer files for this unpacked build on disk. One attempt per
// version, recorded in local storage because a reload clears session storage.
async function reloadFor(version: string): Promise<void> {
  const stored = await chrome.storage.local.get(RELOADED_FOR);
  if (stored[RELOADED_FOR] === version) return;
  await chrome.storage.local.set({ [RELOADED_FOR]: version });
  chrome.runtime.reload();
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

// The attachment through which an agent may still act on a tab.
function usable(tab: number): Attachment | undefined {
  const attachment = attached.get(tab);
  return attachment && !attachment.revoked && !attachment.pending && attachment.life.open
    ? attachment
    : undefined;
}

// Counts work for a life until it settles. Callers check that the life is open in the same
// synchronous turn, so a release that closes it cannot miss the work.
function admitted<T>(life: Life, work: Promise<T>): Promise<T> {
  life.work.add(work);
  const settled = () => life.work.delete(work);
  work.then(settled, settled);
  return work;
}

async function drained(life: Life): Promise<void> {
  while (life.work.size > 0) await Promise.allSettled([...life.work]);
}

// The lives of a group that still hold attachments, in addition to its current one.
function holding(group: string): Set<Life> {
  return new Set(
    [...attached.values()].map(({ life }) => life).filter((life) => life.group === group),
  );
}

async function dispatch(message: HostRequest): Promise<unknown> {
  // Releasing stays possible while the owner's switch is off, so the host can finish closing.
  if (!enabled && message.type !== "release") throw new Refusal("permission_required");
  switch (message.type) {
    case "cdp": {
      if (!usable(message.tab)) throw new Refusal("target_closed");
      if (message.method === "NDS.notifyOwner") return notifyOwner(message.tab, message.params);
      if (message.method === "NDS.clearOwner") return clearOwner(message.tab);
      const target: chrome.debugger.DebuggerSession = { tabId: message.tab };
      if (message.session) target.sessionId = message.session;
      return (await chrome.debugger.sendCommand(target, message.method, message.params)) ?? {};
    }
    case "open": {
      const life = lives.get(message.group);
      if (!life?.open) throw new Refusal("target_closed");
      return admitted(life, opened(life, message.url));
    }
    case "close": {
      if (!usable(message.tab)) throw new Refusal("target_closed");
      await chrome.tabs.remove(message.tab);
      return {};
    }
    case "claim": {
      // A claim continues an open life or starts the next one; nothing else starts a life. The
      // next life starts only once every earlier life of the group settled its work and ended
      // every attachment. One still owned, after a release that failed or is still running,
      // refuses the claim; it is never taken over.
      let life = lives.get(message.group);
      if (!life?.open) {
        const earlier = holding(message.group);
        if (life) earlier.add(life);
        for (const previous of earlier) await drained(previous);
        await Promise.allSettled(
          [...attached.values()]
            .filter((held) => earlier.has(held.life))
            .map((held) => held.ending),
        );
        if ([...attached.values()].some((held) => earlier.has(held.life))) {
          throw new Refusal("busy");
        }
        // A concurrent claim may have started the next life meanwhile.
        const current = lives.get(message.group);
        life = current?.open
          ? current
          : { group: message.group, open: true, close: false, work: new Set() };
        lives.set(message.group, life);
      }
      const tabs = await owned(message.group);
      const result = [];
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        // A tab that closed or left the group during the claim is not part of it.
        const target = await attach(tab.id, life).catch((error) => {
          if (life.open && error instanceof Refusal && error.message === "target_closed") return;
          throw error;
        });
        if (target !== undefined) result.push({ tab: tab.id, target });
      }
      return { tabs: result };
    }
    case "release": {
      // The life closes before anything is awaited, so no later work of it can attach a tab. The
      // group is released once its admitted work settled and every tab it attached is confirmed
      // out of this worker's control. A tab that is not stays owned and fails the release, so the
      // host keeps closing. A tab the owner took back is detached, never closed.
      // The lives to end are fixed here: the current one and any earlier one still holding a tab.
      // A life a later claim starts is not among them.
      const ending = holding(message.group);
      const life = lives.get(message.group);
      if (life) {
        life.open = false;
        life.close = message.close;
        ending.add(life);
      }
      for (const old of ending) await drained(old);
      const failures: unknown[] = [];
      for (const [tab, attachment] of [...attached]) {
        if (!ending.has(attachment.life)) continue;
        const close = message.close && !attachment.revoked;
        await relinquish(tab, attachment, close).catch((error) => failures.push(error));
      }
      if (failures.length > 0) throw failures[0];
      return { released: true };
    }
    case "tabs": {
      const result = [];
      for (const id of message.tabs) {
        if (!usable(id)) continue;
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

// An agent tab the host asked for. A tab created for a life that ended meanwhile is closed again
// when that life's release closes its tabs.
async function opened(life: Life, url: string): Promise<unknown> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Refusal("target_closed");
  const id = tab.id;
  try {
    return await own(id, async () => {
      if (!life.open) throw new Refusal("target_closed");
      await join(id, life.group);
      return { tab: id, target: await attach(id, life) };
    });
  } catch (error) {
    if (!life.open && life.close && !attached.has(id)) await chrome.tabs.remove(id).catch(() => {});
    throw error;
  }
}

function attach(tab: number, life: Life): Promise<unknown> {
  if (!life.open) return Promise.reject(new Refusal("target_closed"));
  const current = attaching.get(tab);
  if (current) return current.life === life ? current.done : Promise.reject(new Refusal("busy"));
  const attempt: Attaching = { life, moved: false, done: Promise.resolve() };
  attempt.done = admitted(
    life,
    (async () => {
      let attachment = attached.get(tab);
      // A tab another life still holds stays with that life until its release ends it.
      if (attachment && attachment.life !== life) throw new Refusal("busy");
      if (!attachment) {
        await chrome.debugger.attach({ tabId: tab }, PROTOCOL);
        // The session exists from here on, so it is recorded before anything else is awaited:
        // Chrome's report of its end then finds it, and a release of this life waits for this
        // work and detaches it.
        attachment = { life, ended: false, revoked: attempt.moved, pending: true };
        attached.set(tab, attachment);
        const now = await chrome.tabs.get(tab).catch(() => undefined);
        if (attachment.ended) throw new Refusal("target_closed");
        if (attempt.moved || !now || groupKey(now.groupId) !== life.group) {
          // The owner moved the tab during the attach: it was never usable, and the session ends.
          attachment.revoked = true;
          void relinquish(tab, attachment, false).catch(() => undefined);
          throw new Refusal("target_closed");
        }
        attachment.pending = false;
      } else if (attachment.revoked || attachment.pending) {
        throw new Refusal("target_closed");
      }
      const info = (await chrome.debugger.sendCommand({ tabId: tab }, "Target.getTargetInfo")) as {
        targetInfo: unknown;
      };
      return info.targetInfo;
    })(),
  ).finally(() => {
    if (attaching.get(tab) === attempt) attaching.delete(tab);
  });
  attaching.set(tab, attempt);
  return attempt.done;
}

// Ends this worker's control of one attachment by closing its tab or detaching from it. Only a
// resolved close or detach, or Chrome's own report that this session or tab ended, removes the
// attachment; otherwise it stays owned and the original failure stands.
function relinquish(tab: number, attachment: Attachment, close: boolean): Promise<void> {
  if (attachment.ended) return Promise.resolve();
  // A record that no longer holds its tab never acts, so it cannot end a later attachment.
  if (attached.get(tab) !== attachment) return Promise.reject(new Refusal("target_closed"));
  attachment.ending ??= (async () => {
    try {
      if (close) await chrome.tabs.remove(tab);
      else await chrome.debugger.detach({ tabId: tab });
    } catch (error) {
      if (!attachment.ended) throw error;
    }
    ended(tab, attachment);
  })().finally(() => {
    attachment.ending = undefined;
  });
  return attachment.ending;
}

// Records the end of exactly this attachment, never of a later one on the same tab.
function ended(tab: number, attachment: Attachment): void {
  attachment.ended = true;
  if (attached.get(tab) === attachment) attached.delete(tab);
}

function closeAll(): void {
  for (const life of lives.values()) life.open = false;
}

// The owner's switch and a lost host end every life at once and then the attachments of exactly
// those lives, never of a life a later claim starts. A tab whose detach fails stays owned, so the
// release of its group retries and reports it.
async function detachAll(): Promise<void> {
  const ending = new Set([...lives.values(), ...[...attached.values()].map(({ life }) => life)]);
  for (const life of ending) life.open = false;
  await Promise.all([...ending].map(drained));
  await Promise.all(
    [...attached]
      .filter(([, attachment]) => ending.has(attachment.life))
      .map(([tab, attachment]) => relinquish(tab, attachment, false).catch(() => undefined)),
  );
}

function groupKey(groupId: number | undefined): string | undefined {
  for (const [key, id] of groups) if (id === groupId) return key;
  return undefined;
}

// Tabs being announced; several Chrome events can report the same new tab.
const adopting = new Set<number>();
const ADOPT_ATTEMPTS = 5;
const ADOPT_RETRY_MS = 200;

function exists(tab: number): Promise<boolean> {
  return chrome.tabs.get(tab).then(
    () => true,
    () => false,
  );
}

// A new tab can refuse grouping or a debugger session while Chrome still sets it up, and the
// event that reports it second is dropped while the first adoption runs. So both steps are
// retried while the tab exists, and a final failure reaches the host instead of a silent miss.
async function retried<T>(
  tab: number,
  life: Life,
  work: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await work() };
    } catch {
      if (attempt === ADOPT_ATTEMPTS || !life.open || !port || !(await exists(tab)))
        return undefined;
      await new Promise((done) => setTimeout(done, ADOPT_RETRY_MS * attempt));
    }
  }
}

async function adopted(tab: number, life: Life, failure: "group" | "attach"): Promise<void> {
  if (life.open && port && (await exists(tab))) send({ type: "adoption", tab, failure });
}

// webNavigation can report a new tab before the tabs API knows it.
async function settled(tab: number): Promise<chrome.tabs.Tab | undefined> {
  for (let attempt = 1; attempt <= ADOPT_ATTEMPTS; attempt++) {
    const found = await chrome.tabs.get(tab).catch(() => undefined);
    if (found) return found;
    await new Promise((done) => setTimeout(done, ADOPT_RETRY_MS * attempt));
  }
  return undefined;
}

// Chrome reports a new tab through several events in varying order, and grouping it suppresses
// the group change event. A sweep of the agent group shortly after adopts any tab that ended up
// in it without an announcement.
const SWEEPS_MS = [300, 1500];

// A sweep belongs to the life that scheduled it and does nothing once that life has ended.
function sweep(life: Life): void {
  for (const delay of SWEEPS_MS) {
    setTimeout(() => {
      if (!life.open) return;
      void owned(life.group).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id !== undefined && !attached.has(tab.id)) void adopt(tab.id, life);
        }
      });
    }, delay);
  }
}

async function adopt(tab: number, life: Life): Promise<void> {
  if (!life.open || !port || attached.has(tab) || adopting.has(tab)) return;
  adopting.add(tab);
  try {
    const target = await retried(tab, life, () => attach(tab, life));
    if (!life.open) return;
    if (target) send({ type: "attached", tab, group: life.group, target: target.value });
    else await adopted(tab, life, "attach");
  } finally {
    adopting.delete(tab);
  }
}

// The open life of the agent group a Chrome group id belongs to.
function liveIn(groupId: number | undefined): Life | undefined {
  const group = groupKey(groupId);
  const life = group === undefined ? undefined : lives.get(group);
  return life?.open ? life : undefined;
}

// A check in an agent tab that only a person passes, such as a CAPTCHA. One notification per tab
// names the agent and the site and stays until the owner opens the tab from it, the agent clears
// it, or the tab closes. The agent keeps working meanwhile.
async function notifyOwner(tab: number, params?: object): Promise<{ notification: string }> {
  const reason = (params as { reason?: unknown } | undefined)?.reason;
  const page = await chrome.tabs.get(tab);
  const id = `${OWNER}${tab}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: `NDS agent ${attached.get(tab)?.life.group} needs you`,
    message:
      typeof reason === "string" && reason.trim() !== ""
        ? reason.trim().slice(0, 200)
        : "A check in its tab needs a person.",
    contextMessage: page.url ? new URL(page.url).host : "",
    requireInteraction: true,
  });
  return { notification: id };
}

async function clearOwner(tab: number): Promise<object> {
  await chrome.notifications.clear(`${OWNER}${tab}`);
  return {};
}

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith(OWNER)) return;
  void chrome.notifications.clear(id);
  void chrome.tabs
    .update(Number(id.slice(OWNER.length)), { active: true })
    .then((tab) => tab && chrome.windows.update(tab.windowId, { focused: true }))
    .catch(() => undefined);
});

// A removed tab ends its debugger session; Chrome may report the removal before the detach.
chrome.tabs.onRemoved.addListener((tab) => {
  void chrome.notifications.clear(`${OWNER}${tab}`);
  const attachment = attached.get(tab);
  if (!attachment) return;
  ended(tab, attachment);
  send({ type: "detached", tab, reason: "target_closed" });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !usable(source.tabId)) return;
  send({ type: "event", tab: source.tabId, session: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const attachment = source.tabId === undefined ? undefined : attached.get(source.tabId);
  if (source.tabId === undefined || !attachment) return;
  ended(source.tabId, attachment);
  send({ type: "detached", tab: source.tabId, reason });
});

// A tab created inside an agent group (for example with the group's "+")
// belongs to that agent area.
chrome.tabs.onCreated.addListener((tab) => {
  const life = liveIn(tab.groupId);
  if (tab.id !== undefined && life) void adopt(tab.id, life);
});

// Popups and target=_blank links opened by an agent tab stay in its area.
// webNavigation names the real source tab, unlike `openerTabId`, and works
// whether or not Chrome grouped the new tab itself.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const life = usable(details.sourceTabId)?.life;
  if (!life) return;
  const id = details.tabId;
  sweep(life);
  void admitted(
    life,
    own(id, async () => {
      const tab = await settled(id);
      if (!life.open) return;
      if (!tab) {
        if (port) send({ type: "adoption", tab: id, failure: "tab" });
        return;
      }
      if (
        groupKey(tab.groupId) !== life.group &&
        !(await retried(id, life, () => join(id, life.group)))
      ) {
        await adopted(id, life, "group");
      }
      await adopt(id, life);
    }),
  );
});

// Moving a tab into an agent group shares it; moving it out revokes control.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.groupId === undefined) return;
  const pending = attaching.get(tabId);
  if (pending && pending.life.group !== groupKey(change.groupId)) pending.moved = true;
  if (grouping.has(tabId)) return;
  const attachment = attached.get(tabId);
  if (attachment && attachment.life.group !== groupKey(change.groupId)) {
    // Out of its agent group, whether the owner took it back or Chrome is closing it: from now on
    // no agent command or release closes the tab.
    attachment.revoked = true;
    void revoke(tabId, attachment);
  } else if (!attachment) {
    const life = liveIn(change.groupId);
    if (life) void adopt(tabId, life);
  }
});

// Closing tabs and windows also clears their group; that is a closed target
// reported by onDetach, not the owner moving the tab out of the agent area.
// The owner taking a tab back ended agent access to it already; the detach follows, and one that
// fails keeps the attachment owned, so the release of its group retries it.
async function revoke(tabId: number, attachment: Attachment): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const window = tab && (await chrome.windows.get(tab.windowId).catch(() => undefined));
  if (!tab || !window || groupKey(tab.groupId) !== undefined) return;
  if (attached.get(tabId) !== attachment || attachment.ended || attachment.ending) return;
  send({ type: "detached", tab: tabId, reason: "revoked" });
  await relinquish(tabId, attachment, false).catch(() => undefined);
}

chrome.tabGroups.onRemoved.addListener((group) => {
  const key = groupKey(group.id);
  if (key === undefined) return;
  groups.delete(key);
  void saveGroups();
});

// The owner's switch in the action popup: disabling detaches every agent tab
// and the host refuses new work until it is enabled again.
// The intent reaches the host at once; ending the attachments may take longer or partly fail.
async function setEnabled(value: boolean): Promise<void> {
  enabled = value;
  if (!enabled) closeAll();
  send({ type: "control", enabled });
  await chrome.storage.local.set({ [ENABLED]: enabled });
  if (!enabled) await detachAll();
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
      reply({
        enabled,
        connected: port !== undefined,
        tabs: [...attached.keys()].filter(usable).length,
      });
    return false;
  },
);

// Browser start and install/update/reload each start the worker; both connect.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
void load().then(connect);
