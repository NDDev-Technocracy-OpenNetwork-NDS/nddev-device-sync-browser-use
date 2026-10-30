// Thin browser layer for ADR 0015: the Rust host owns sessions and policy.
// This worker only attaches chrome.debugger to tabs in NDS-managed groups and
// relays their CDP traffic over native messaging. Other tabs are never touched.

import { type FrameTree, Restore, restricted } from "./restore.js";

const HOST = "ai.nddev.nds.browser_use";
const PROTOCOL = "1.3";
const ENABLED = "enabled";
// The owner's observation profile (docs/observability.md): what agent activity is collected.
const OBSERVATION = "observation";
type Observation = "full" | "standard" | "off";
const OBSERVATIONS: readonly Observation[] = ["full", "standard", "off"];
const GROUPS = "groups";
// The owner's private sites: agents still work there, but the journal keeps no content of them.
const PRIVATE = "private";
const PRIVATE_LIMIT = 256;
const RELOADED_FOR = "reloadedFor";
const OWNER = "owner:";
const PIN = "nds-pin";
// Installed in every agent tab: remembers the element of the last right-click, for pinning.
const CONTEXT = `if (!globalThis.__ndsContext) { globalThis.__ndsContext = true; addEventListener("contextmenu", (event) => { globalThis.__ndsContextTarget = event.target; }, true); }`;
// Marks that element as the next pin, `[data-nds-pin="N"]`, or names the pin it already is.
const PINNING = `(() => { const target = globalThis.__ndsContextTarget; if (!(target instanceof Element)) return 0; const known = Number(target.getAttribute("data-nds-pin")); if (known) return known; const number = Math.max(0, ...[...document.querySelectorAll("[data-nds-pin]")].map((pin) => Number(pin.getAttribute("data-nds-pin")) || 0)) + 1; target.setAttribute("data-nds-pin", String(number)); return number; })()`;
// This worker's scripts in agent tabs (the right-click listener, the pin marker, the ghost cursor)
// run in an isolated world of this name: the page sees none of their globals or properties, and
// shares only the DOM with them.
const WORLD = "nds";

// Events no agent uses that flood native messaging on busy pages.
const NOISY = new Set(["Network.dataReceived", "Network.resourceChangedPriority"]);
// Setup commands a frozen or discarded tab never answers; an attach or replay waiting on one
// would hang, so each gets a deadline.
const SETUP = new Set([
  "Browser.getWindowForTarget",
  "Emulation.setEmulatedMedia",
  "Emulation.setFocusEmulationEnabled",
  "Log.enable",
  "Network.enable",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.setDownloadBehavior",
  "Page.setLifecycleEventsEnabled",
  "Runtime.disable",
  "Runtime.enable",
  "Runtime.runIfWaitingForDebugger",
  "Target.getTargetInfo",
  "Target.setAutoAttach",
]);
const SETUP_TIMEOUT_MS = 10_000;
// While Chrome captures a screenshot of an agent tab, this worker's ghost cursor, the page's
// scrollbars and the text caret stay out of it; the accessibility labels a labelled screenshot
// draws stay in.
const SHOT_STYLE = "nds-screenshot-style";
const SHOT_HIDE = `(() => { if (document.getElementById("${SHOT_STYLE}")) return; const style = document.createElement("style"); style.id = "${SHOT_STYLE}"; style.textContent = "#nds-ghost-cursor { display: none !important } html { scrollbar-width: none !important } ::-webkit-scrollbar { display: none !important } * { caret-color: transparent !important }"; (document.head ?? document.documentElement).append(style); })()`;
const SHOT_SHOW = `document.getElementById("${SHOT_STYLE}")?.remove()`;
// Chrome draws a tab the owner is not looking at about once a second, and Playwright waits for
// two animation frames before each pointer action: an agent's click in such a tab took two
// seconds, and a screenshot waited for a frame. Chrome draws a tab that is being captured as if
// it were shown, so while an agent works in a tab the worker keeps a screencast of it open, of
// 8x8 pixels and at most one frame every 600 draws, whose frames go nowhere. It ends after
// AWAKE_IDLE_MS without a command, so idle agent tabs cost nothing. The agent's own screencast,
// for a recording, replaces it while it runs.
const AWAKE_IDLE_MS = 20_000;
const AWAKE = { format: "jpeg", quality: 1, maxWidth: 8, maxHeight: 8, everyNthFrame: 600 };
type Awake = { timer: ReturnType<typeof setTimeout> | undefined; on: boolean; agent: boolean };
const awake = new Map<number, Awake>();

function awakeOf(tab: number): Awake {
  let state = awake.get(tab);
  if (!state) {
    state = { timer: undefined, on: false, agent: false };
    awake.set(tab, state);
  }
  return state;
}

async function wake(tab: number): Promise<void> {
  const state = awakeOf(tab);
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void rest(tab, state), AWAKE_IDLE_MS);
  if (state.on || state.agent) return;
  state.on = true;
  await chrome.debugger.sendCommand({ tabId: tab }, "Page.startScreencast", AWAKE).catch(() => {
    state.on = false;
  });
}

async function rest(tab: number, state: Awake): Promise<void> {
  if (awake.get(tab) !== state || !state.on || state.agent) return;
  state.on = false;
  await chrome.debugger.sendCommand({ tabId: tab }, "Page.stopScreencast").catch(() => undefined);
}

// A tab's debugger session ended or was replaced, and its screencast with it.
function asleep(tab: number): void {
  clearTimeout(awake.get(tab)?.timer);
  awake.delete(tab);
}

// The ghost cursor shows each agent mouse action in an agent tab and fades after 5 s. It moves only after the agent's own Input.dispatchMouseEvent, never with the owner's
// mouse. A cursor the executor installed (ghostCursor.show) follows the mouse itself and is left
// alone, and ghostCursor.hide turns this one off until the next show.
const CURSOR = `((x, y, press) => { if (!document.documentElement || document.documentElement.hasAttribute("data-nds-cursor-off")) return; let host = document.getElementById("nds-ghost-cursor"); if (host && !host.__ndsMove) return; if (!host) { host = document.createElement("div"); host.id = "nds-ghost-cursor"; host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"; const root = host.attachShadow({ mode: "closed" }); const dot = document.createElement("div"); dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(0,0,0,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:0;transition:opacity .3s,transform .1s"; root.append(dot); document.documentElement.append(host); let idle; host.__ndsMove = (x, y, press) => { dot.style.left = x + "px"; dot.style.top = y + "px"; dot.style.opacity = "1"; if (press) { dot.style.transform = "scale(.7)"; setTimeout(() => { dot.style.transform = ""; }, 150); } clearTimeout(idle); idle = setTimeout(() => { dot.style.opacity = "0"; }, 5000); }; } host.__ndsMove(x, y, press); })`;

type HostRequest =
  | {
      type: "cdp";
      id: number;
      group: string;
      tab: number;
      session?: string;
      method: string;
      params?: object;
    }
  | { type: "open"; id: number; group: string; url: string }
  | { type: "close"; id: number; group: string; tab: number }
  | { type: "claim"; id: number; group: string }
  | { type: "release"; id: number; group: string; close: boolean }
  | { type: "tabs"; id: number; tabs: number[] }
  | { type: "forget"; id: number; download: number }
  | { type: "reload"; id?: undefined; version: string }
  | ({ type: "recorded"; request: number } & OwnerRecording)
  | { type: "incompatible"; id?: undefined; contract: number }
  | { type: "journaled"; id?: undefined; request: number; lines: string[] }
  | { type: "about"; id?: undefined; version: string; commit: string };
// One part of a host message larger than Chrome passes from a host (see `connect`).
type Part = { type: "part"; index: number; count: number; data: string };
// Every request but `reload`, which the worker answers by reloading, not with a result, and the
// host's answer to the owner's recorder button.
type Answered = Exclude<
  HostRequest,
  | { type: "reload" }
  | { type: "recorded" }
  | { type: "incompatible" }
  | { type: "journaled" }
  | { type: "about" }
>;
// The recorder of the agent group that holds the owner's tab, as the popup shows it.
type OwnerRecording = {
  recording?: boolean;
  id?: string;
  events?: number;
  error?: string;
  message?: string;
};

class Refusal extends Error {}

let port: chrome.runtime.Port | undefined;
let enabled = true;
let observation: Observation = "full";
let privateSites: string[] = [];
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
  // The tab's target, which a reattached session must still report.
  target?: string | undefined;
  // The execution context of this worker's isolated world in the tab's current document.
  world?: number | undefined;
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
// What each attached tab's session needs restored after Chrome detached it on its own.
const restore = new Restore();
// A reattach in progress per tab; commands and releases of the tab wait for it.
const reattaching = new Map<number, Promise<boolean>>();
// Child sessions of restricted targets, detached as they appear; their events never reach agents.
const ignored = new Set<string>();

// Sends one command; setup commands get a deadline.
async function command(
  target: chrome.debugger.DebuggerSession,
  method: string,
  params?: object,
): Promise<unknown> {
  const sent = chrome.debugger.sendCommand(target, method, params);
  if (!SETUP.has(method)) return sent;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sent,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          report("browser.cdp.setup_timeout", "timeout");
          reject(new Error(`${method} got no answer; the tab may be frozen`));
        }, SETUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function load(): Promise<void> {
  const local = await chrome.storage.local.get([ENABLED, OBSERVATION, PRIVATE]);
  enabled = local[ENABLED] !== false;
  privateSites = Array.isArray(local[PRIVATE])
    ? (local[PRIVATE] as unknown[]).filter((site): site is string => typeof site === "string")
    : [];
  observation = OBSERVATIONS.find((profile) => profile === local[OBSERVATION]) ?? "full";
  const session = await chrome.storage.session.get(GROUPS);
  groups = new Map(Object.entries((session[GROUPS] ?? {}) as Record<string, number>));
  await badge();
}

function saveGroups(): Promise<void> {
  return chrome.storage.session.set({ [GROUPS]: Object.fromEntries(groups) });
}

// The contract of a connected host that refused this worker's, which the popup explains.
let hostContract: number | undefined;
const CONTRACT = 2;

// The icon tells the owner the state at a glance: the number of agent tabs, OFF, a host that is
// not running, or one that does not match.
async function badge(): Promise<void> {
  const tabs = [...attached.keys()].filter(usable).length;
  const [text, color] = !enabled
    ? ["OFF", "#646b78"]
    : !port
      ? ["…", "#b26a00"]
      : hostContract !== undefined
        ? ["!", "#c4322b"]
        : [tabs > 0 ? String(tabs) : "", "#0b7a8a"];
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
  await chrome.action.setBadgeText({ text });
}

function send(message: object): void {
  port?.postMessage(message);
}

type Reported =
  | "browser.target.reattached"
  | "browser.target.restricted"
  | "browser.target.foreign_frames_removed"
  | "browser.cdp.setup_timeout";
type ReportedError = "attach_failed" | "target_changed" | "reattach_limit" | "timeout";

// One event about this worker's own Chrome work for the host's telemetry: a fixed name, an
// outcome and a fixed error type, never anything of a page.
function report(event: Reported, error?: ReportedError): void {
  const outcome = error === undefined ? "ok" : error === "timeout" ? "error" : "rejected";
  send(
    error === undefined
      ? { type: "telemetry", event, outcome }
      : { type: "telemetry", event, outcome, error },
  );
}

// The parts of one larger message arrive back to back; together they are at most this long.
const PARTS_LIMIT = 32 * 1_048_576;

function connect(): void {
  if (port) return;
  const next = chrome.runtime.connectNative(HOST);
  port = next;
  // The message being joined on this connection: its parts so far and their length.
  let joining: { count: number; data: string[]; length: number } | undefined;
  const join = (part: Part): HostRequest | undefined => {
    if (part.index === 0) joining = { count: part.count, data: [], length: 0 };
    const whole = joining;
    if (!whole || part.count !== whole.count || part.index !== whole.data.length) {
      // A part out of order belongs to no message this worker can read.
      joining = undefined;
      return undefined;
    }
    whole.data.push(part.data);
    whole.length += part.data.length;
    if (whole.length > PARTS_LIMIT) {
      joining = undefined;
      return undefined;
    }
    if (whole.data.length < whole.count) return undefined;
    joining = undefined;
    try {
      return JSON.parse(whole.data.join("")) as HostRequest;
    } catch {
      return undefined;
    }
  };
  next.onMessage.addListener((received: HostRequest | Part) => {
    const message = received.type === "part" ? join(received) : received;
    if (!message) return;
    if (message.type === "reload") void reloadFor(message.version);
    else if (message.type === "recorded") recorded.get(message.request)?.(message);
    else if (message.type === "journaled") journaled.get(message.request)?.(message.lines);
    else if (message.type === "about") {
      hostBuild = { version: message.version, commit: message.commit };
      for (const done of abouts.splice(0)) done();
    } else if (message.type === "incompatible") {
      // The host speaks another contract: nothing an agent asks can work until one is updated.
      hostContract = message.contract;
      void badge();
    } else void handle(message);
  });
  next.onDisconnect.addListener(() => {
    // The host owned every session; without it no agent may keep control.
    port = undefined;
    hostContract = undefined;
    hostBuild = undefined;
    void detachAll().then(badge);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60_000);
  });
  send({
    type: "hello",
    protocol: PROTOCOL,
    version: chrome.runtime.getManifest().version,
    // The host admits only this contract: every cdp and close request names its group.
    contract: CONTRACT,
    userAgent: navigator.userAgent,
    enabled,
    // The host takes agent downloads' files from this worker (see `downloads` below).
    downloads: chrome.downloads !== undefined,
    // The host may send a message larger than Chrome passes in parts this worker joins.
    parts: true,
    observation,
    private: privateSites,
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

async function handle(message: Answered): Promise<void> {
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
// Agent downloads. Chrome refuses an extension's `Page.setDownloadBehavior`, so an agent tab's
// download is saved in the browser's own folder, and the downloads API names that file. A
// download is the agent's when an agent tab announced its URL to CDP within `BIND_MS`, or when it
// came from a tab an agent tab opened, which closes before any debugger reaches it; that one is
// reported to Playwright on the opener. The finished file goes to the host, which keeps a copy in
// the session and then asks for the browser's copy to go. Every other download is the owner's
// and is never touched.
const BIND_MS = 10_000;
const CANDIDATES = 64;
type Candidate = { group: string; tab: number; url: string; at: number; name?: string };
type AgentDownload = {
  group: string;
  tab: number;
  urls: string[];
  // The name the site suggested; the browser may have saved the file under another one.
  name?: string;
  guid?: string;
  begun: boolean;
  // Its steps run in order: the opener reports a download begun before it reports it finished.
  steps: Promise<void>;
};
// Agent tabs' CDP announcements, the first URLs of tabs agent tabs opened, downloads not yet
// matched to either, and the agent's downloads.
const announced: Candidate[] = [];
const openedUrls: Candidate[] = [];
// A download not yet matched remembers that it ended: a small file can be complete before its
// agent tab's CDP event reaches this worker on a loaded machine.
const unmatched = new Map<number, { urls: string[]; at: number; ended?: boolean }>();
const agentDownloads = new Map<number, AgentDownload>();
// Tabs agent tabs opened, and the CDP guids of their own download events, which are not relayed.
const openedTabs = new Map<number, number>();
const silenced = new Set<string>();

function note(list: Candidate[], candidate: Candidate): void {
  const now = Date.now();
  while (list.length > 0 && (now - (list[0]?.at ?? 0) > BIND_MS || list.length >= CANDIDATES)) {
    list.shift();
  }
  list.push(candidate);
}

function claim(list: Candidate[], urls: string[]): Candidate | undefined {
  const now = Date.now();
  const index = list.findIndex((each) => now - each.at <= BIND_MS && urls.includes(each.url));
  return index < 0 ? undefined : list.splice(index, 1)[0];
}

// Records an agent tab's own download event; false for one that is not relayed, because its tab
// is one an agent tab opened and the download is reported on the opener instead.
function announce(tab: number, method: string, fields: Record<string, unknown>): boolean {
  const guid = String(fields.guid ?? "");
  if (method === "Page.downloadProgress") return !silenced.has(guid);
  const since = openedTabs.get(tab);
  if (since !== undefined && Date.now() - since <= BIND_MS) {
    silenced.add(guid);
    return false;
  }
  const group = attached.get(tab)?.life.group;
  const url = String(fields.url ?? "");
  const name = typeof fields.suggestedFilename === "string" ? fields.suggestedFilename : undefined;
  if (!group || !url) return true;
  const waiting = [...unmatched].find(([, item]) => item.urls.includes(url));
  if (waiting) {
    const [id, item] = waiting;
    unmatched.delete(id);
    const download: AgentDownload = {
      group,
      tab,
      urls: item.urls,
      ...(name ? { name } : {}),
      begun: true,
      steps: Promise.resolve(),
    };
    agentDownloads.set(id, download);
    // Its end was reported while it was nobody's yet.
    if (item.ended) step(download, () => finish(id, download));
  } else {
    note(announced, { group, tab, url, at: Date.now(), ...(name ? { name } : {}) });
  }
  return true;
}

function spawned(group: string, opener: number, tab: number, url: string): void {
  const now = Date.now();
  openedTabs.set(tab, now);
  for (const [id, at] of openedTabs) if (now - at > BIND_MS) openedTabs.delete(id);
  if (url) note(openedUrls, { group, tab: opener, url, at: now });
}

function urlsOf(item: chrome.downloads.DownloadItem): string[] {
  return [...new Set([item.url, item.finalUrl])].filter((url): url is string => Boolean(url));
}

// The opener reports a download its new tab started, as Chrome would for its own frame: the main
// frame of a tab has the tab's target id.
async function begin(
  id: number,
  download: AgentDownload,
  item: chrome.downloads.DownloadItem,
): Promise<void> {
  if (download.begun || !download.guid) return;
  download.begun = true;
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const frameId = targets.find(
    (target) => target.tabId === download.tab && target.type === "page",
  )?.id;
  if (!frameId || !usable(download.tab)) {
    agentDownloads.delete(id);
    return;
  }
  const name =
    item.filename.split(/[\\/]/).pop() ||
    new URL(item.finalUrl || item.url).pathname.split("/").pop() ||
    "download";
  download.name = name;
  send({
    type: "event",
    tab: download.tab,
    method: "Page.downloadWillBegin",
    params: {
      frameId,
      guid: download.guid,
      url: item.finalUrl || item.url,
      suggestedFilename: name,
    },
  });
}

async function finish(id: number, download: AgentDownload): Promise<void> {
  agentDownloads.delete(id);
  const [item] = await chrome.downloads.search({ id }).catch(() => []);
  if (!item) return;
  const complete = item.state === "complete";
  if (download.guid && download.begun) {
    send({
      type: "event",
      tab: download.tab,
      method: "Page.downloadProgress",
      params: {
        guid: download.guid,
        totalBytes: item.fileSize,
        receivedBytes: item.bytesReceived,
        state: complete ? "completed" : "canceled",
      },
    });
  }
  send({
    type: "download",
    group: download.group,
    id,
    urls: download.urls,
    ...(download.name ? { name: download.name } : {}),
    state: complete ? "complete" : "interrupted",
    ...(complete ? { path: item.filename } : { error: item.error ?? "interrupted" }),
  });
}

// The host kept the file: the browser's copy and its entry in the download list go.
async function forget(id: number): Promise<object> {
  await chrome.downloads.removeFile(id).catch(() => undefined);
  await chrome.downloads.erase({ id }).catch(() => undefined);
  return {};
}

chrome.downloads?.onCreated.addListener((item) => {
  const urls = urlsOf(item);
  const now = Date.now();
  for (const [id, waiting] of unmatched) if (now - waiting.at > BIND_MS) unmatched.delete(id);
  const direct = claim(announced, urls);
  if (direct) {
    agentDownloads.set(item.id, {
      group: direct.group,
      tab: direct.tab,
      urls,
      ...(direct.name ? { name: direct.name } : {}),
      begun: true,
      steps: Promise.resolve(),
    });
    return;
  }
  const from = claim(openedUrls, urls);
  if (from && usable(from.tab)) {
    const download: AgentDownload = {
      group: from.group,
      tab: from.tab,
      urls,
      guid: crypto.randomUUID(),
      begun: false,
      steps: Promise.resolve(),
    };
    agentDownloads.set(item.id, download);
    if (item.filename) step(download, () => begin(item.id, download, item));
    return;
  }
  if (unmatched.size < CANDIDATES) unmatched.set(item.id, { urls, at: now });
});

function step(download: AgentDownload, next: () => Promise<void>): void {
  download.steps = download.steps.then(next).catch(() => undefined);
}

chrome.downloads?.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  const ended = state === "complete" || state === "interrupted";
  const download = agentDownloads.get(delta.id);
  if (!download) {
    const waiting = unmatched.get(delta.id);
    if (waiting && ended) waiting.ended = true;
    return;
  }
  if (delta.filename?.current || ended) {
    step(download, async () => {
      const [item] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
      if (item) await begin(delta.id, download, item);
    });
  }
  if (ended) step(download, () => finish(delta.id, download));
});

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

async function dispatch(message: Answered): Promise<unknown> {
  // Releasing stays possible while the owner's switch is off, so the host can finish closing, and
  // so does removing the browser's copy of an agent download the host already kept.
  if (!enabled && message.type !== "release" && message.type !== "forget") {
    throw new Refusal("permission_required");
  }
  switch (message.type) {
    case "cdp": {
      // The command belongs to exactly the attachment it found: after every wait and right before
      // every command or record, that attachment must still hold the tab. A later life's
      // attachment of the same tab never receives an earlier command, nor its recorded setup.
      const held = usable(message.tab);
      // A request of another group, or one without its group, never acts on this attachment.
      if (!held || held.life.group !== message.group) throw new Refusal("target_closed");
      const still = (): void => {
        if (usable(message.tab) !== held) throw new Refusal("target_closed");
      };
      if (message.method === "NDS.notifyOwner") return notifyOwner(message.tab, message.params);
      if (message.method === "NDS.clearOwner") return clearOwner(message.tab);
      await reattaching.get(message.tab);
      still();
      if (!message.session) {
        // An agent's own screencast replaces the worker's; any other command wakes the tab.
        if (message.method === "Page.startScreencast") {
          // The worker's screencast ends first, so the agent's starts afresh and gets its first
          // frame at once, as without the worker.
          const state = awakeOf(message.tab);
          state.agent = true;
          if (state.on) {
            state.on = false;
            await chrome.debugger
              .sendCommand({ tabId: message.tab }, "Page.stopScreencast")
              .catch(() => undefined);
            still();
          }
        } else {
          await wake(message.tab);
          still();
        }
      }
      const target: chrome.debugger.DebuggerSession = { tabId: message.tab };
      if (message.session) target.sessionId = message.session;
      if (message.method === "Runtime.enable") {
        // Chrome reports execution contexts only when Runtime goes from disabled to enabled. A
        // later client of the tab, such as a replacement executor or a raw CDP session, would
        // otherwise never learn them, and its evaluations would wait forever.
        await command(target, "Runtime.disable").catch(() => undefined);
        still();
      }
      if (message.session) return (await command(target, message.method, message.params)) ?? {};
      if (message.method === "Page.captureScreenshot") {
        await command(target, "Runtime.evaluate", { expression: SHOT_HIDE }).catch(() => undefined);
        try {
          return (await command(target, message.method, message.params)) ?? {};
        } finally {
          await command(target, "Runtime.evaluate", { expression: SHOT_SHOW }).catch(
            () => undefined,
          );
        }
      }
      // Setup that would outgrow what a reattach can restore is refused before Chrome sees it; the
      // room is held from here until the answer, so concurrent setup shares the bounds.
      const release = restore.reserve(message.tab, message.method, message.params);
      if (!release) throw new Refusal("capacity");
      try {
        const params = restore.chromeParams(message.tab, message.method, message.params);
        const result = (await command(target, message.method, params)) ?? {};
        still();
        if (message.method === "Input.dispatchMouseEvent") point(message.tab, message.params);
        if (message.method === "Page.stopScreencast" && !message.session) {
          // The agent's screencast ended, and with it the worker's; the next command wakes it.
          const state = awakeOf(message.tab);
          state.agent = false;
          state.on = false;
        }
        return restore.record(message.tab, message.method, message.params, result);
      } finally {
        release();
      }
    }
    case "open": {
      const life = lives.get(message.group);
      if (!life?.open) throw new Refusal("target_closed");
      return admitted(life, opened(life, message.url));
    }
    case "close": {
      const held = usable(message.tab);
      if (!held || held.life.group !== message.group) throw new Refusal("target_closed");
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
    case "forget":
      return forget(message.download);
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
  // A tab of an agent area that exists opens in that area's window, so it never shows up in the
  // window the owner works in on its way there.
  const area = groups.get(life.group);
  const windowId =
    area === undefined
      ? undefined
      : (await chrome.tabGroups.get(area).catch(() => undefined))?.windowId;
  const tab = await chrome.tabs.create(
    windowId === undefined ? { url, active: false } : { url, active: false, windowId },
  );
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
        await removeForeignFrames(tab, life);
        // Frame cleanup admits nothing. The attach itself needs exactly this life, still its
        // group's open life, and a tab that did not move and is in that group now.
        const before = await chrome.tabs.get(tab).catch(() => undefined);
        if (
          !life.open ||
          lives.get(life.group) !== life ||
          attempt.moved ||
          !before ||
          groupKey(before.groupId) !== life.group
        )
          throw new Refusal("target_closed");
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
        void badge();
        restore.startSession(tab);
        await remember(tab, () => usable(tab) === attachment);
      } else if (attachment.revoked || attachment.pending) {
        throw new Refusal("target_closed");
      }
      const info = (await command({ tabId: tab }, "Target.getTargetInfo")) as {
        targetInfo: { targetId?: string };
      };
      // A claim or an adoption reports only the attachment it holds now: the same record, of the
      // group's current open life, neither moved out nor still unconfirmed.
      if (
        attached.get(tab) !== attachment ||
        attachment.life !== life ||
        !life.open ||
        lives.get(life.group) !== life ||
        attachment.revoked ||
        attachment.pending
      )
        throw new Refusal("target_closed");
      attachment.target = info.targetInfo.targetId;
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
      // A reattach in progress ends first, so the session it may create is the one detached.
      await reattaching.get(tab);
      // What held during the wait is decided again: an attachment that ended or no longer holds
      // its tab never acts, and a tab the owner took back meanwhile is detached, never closed.
      if (attachment.ended) return;
      if (attached.get(tab) !== attachment) throw new Refusal("target_closed");
      if (close && !attachment.revoked) await chrome.tabs.remove(tab);
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
  if (attached.get(tab) !== attachment) return;
  attached.delete(tab);
  asleep(tab);
  void badge();
  restore.endSession(tab);
  // No agent holds the tab any more, so nobody would clear its check or act on it.
  void chrome.notifications.clear(`${OWNER}${tab}`).catch(() => undefined);
}

// Removes other extensions' frames from an agent tab before a debugger session starts on it:
// Chrome refuses to attach to a tab that holds one, and detaches from a tab when one navigates.
// Per ADR 0015 only the current agent life's own tab is touched, and only those frame elements:
// the life must still be its group's open life, the tab must be in that group now, and a
// reattach must still hold the tab's attachment. A stale continuation touches nothing.
async function removeForeignFrames(
  tab: number,
  life: Life,
  attachment?: Attachment,
): Promise<void> {
  const current = await chrome.tabs.get(tab).catch(() => undefined);
  const admitted =
    current !== undefined &&
    life.open &&
    lives.get(life.group) === life &&
    groupKey(current.groupId) === life.group &&
    (attachment === undefined || (attached.get(tab) === attachment && !attachment.revoked));
  if (!admitted) return;
  // Best effort: a page that refuses scripts still gets its attach attempt.
  await Promise.resolve()
    .then(() =>
      chrome.scripting.executeScript({
        target: { tabId: tab, allFrames: true },
        func: (own: string) => {
          let removed = 0;
          const remove = (root: Document | ShadowRoot): void => {
            for (const frame of root.querySelectorAll("iframe")) {
              const source = frame.src || frame.getAttribute("src") || "";
              if (
                source.startsWith("chrome-extension://") &&
                !source.startsWith(`chrome-extension://${own}/`)
              ) {
                frame.remove();
                removed++;
              }
            }
            for (const element of root.querySelectorAll("*")) {
              const shadow =
                element instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(element) : null;
              if (shadow) remove(shadow);
            }
          };
          remove(document);
          return removed;
        },
        args: [chrome.runtime.id],
      }),
    )
    .then((results) => {
      const removed = results.reduce((sum, frame) => sum + (Number(frame.result) || 0), 0);
      if (removed > 0) report("browser.target.foreign_frames_removed");
    })
    .catch(() => undefined);
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
    if (target && usable(tab)?.life === life)
      send({ type: "attached", tab, group: life.group, target: target.value });
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

// Moves the ghost cursor to an agent mouse event's point; it never delays or fails the event.
// The cursor's moves of one tab, in the order the agent's mouse events came.
const cursorSteps = new Map<number, Promise<unknown>>();

function point(tab: number, params: object | undefined): void {
  const { type, x, y } = (params ?? {}) as { type?: unknown; x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x + y)) return;
  const expression = `${CURSOR}(${x}, ${y}, ${type === "mousePressed"})`;
  const next = (cursorSteps.get(tab) ?? Promise.resolve())
    .then(() => inWorld(tab, expression))
    .catch(() => undefined);
  cursorSteps.set(tab, next);
  void next.then(() => {
    if (cursorSteps.get(tab) === next) cursorSteps.delete(tab);
  });
}

// Evaluates in this worker's isolated world of the tab's main frame. Chrome keeps one world of a
// name per frame, the one `remember` installs into; its context changes with each document, so a
// stale one is asked for again once.
async function inWorld(
  tab: number,
  expression: string,
  returnByValue = false,
): Promise<{ result?: { value?: unknown } }> {
  const attachment = attached.get(tab);
  if (!attachment) throw new Refusal("target_closed");
  for (let attempt = 0; ; attempt++) {
    if (attachment.world === undefined) {
      const { frameTree } = (await chrome.debugger.sendCommand(
        { tabId: tab },
        "Page.getFrameTree",
      )) as {
        frameTree: { frame: { id: string } };
      };
      const { executionContextId } = (await chrome.debugger.sendCommand(
        { tabId: tab },
        "Page.createIsolatedWorld",
        { frameId: frameTree.frame.id, worldName: WORLD },
      )) as { executionContextId: number };
      attachment.world = executionContextId;
    }
    try {
      return (await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", {
        expression,
        contextId: attachment.world,
        returnByValue,
      })) as { result?: { value?: unknown } };
    } catch (error) {
      attachment.world = undefined;
      if (attempt > 0) throw error;
    }
  }
}

// A check in an agent tab that only a person passes, such as a CAPTCHA. One notification per tab
// names the agent and the site and stays until the owner opens the tab from it, the agent clears
// it, or the agent's hold on the tab ends: its session closed, the tab left the agent group, or
// it closed. A notification never outlives the check it asks for. The agent keeps working.
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
    buttons: [{ title: "Open the tab" }],
    requireInteraction: true,
  });
  return { notification: id };
}

// The owner opens the tab a notification asks for: its group is expanded, the tab made active and
// its window brought forward or, where the desktop refuses focus, marked for attention.
async function openForOwner(tab: number): Promise<void> {
  const page = await chrome.tabs.get(tab).catch(() => undefined);
  if (!page) return;
  if (page.groupId >= 0) {
    await chrome.tabGroups.update(page.groupId, { collapsed: false }).catch(() => undefined);
  }
  await chrome.tabs.update(tab, { active: true }).catch(() => undefined);
  await chrome.windows
    .update(page.windowId, { focused: true, drawAttention: true })
    .catch(() => undefined);
}

async function clearOwner(tab: number): Promise<object> {
  await chrome.notifications.clear(`${OWNER}${tab}`);
  return {};
}

// The element of a right-click in an agent tab is remembered there, for the owner's pin. Each of
// its two commands goes out only while `admitted` still holds.
async function remember(tab: number, admitted: () => boolean): Promise<void> {
  if (!admitted()) return;
  await chrome.debugger
    .sendCommand({ tabId: tab }, "Page.addScriptToEvaluateOnNewDocument", {
      source: CONTEXT,
      worldName: WORLD,
    })
    .catch(() => undefined);
  if (!admitted()) return;
  await inWorld(tab, CONTEXT).catch(() => undefined);
}

// The owner points an agent at an element: right-click, "Pin this element for the NDS agent".
// Only tabs in an agent group can be pinned; the agent lists the pins with pinnedElements().
async function pin(tab: number): Promise<void> {
  const attachment = usable(tab);
  const id = `pin:${tab}`;
  if (!attachment) {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "NDS agent pin",
      message:
        "Only tabs in an NDS agent group can be pinned; move this tab into the agent's group first.",
    });
    return;
  }
  const { result } = await inWorld(tab, PINNING, true);
  const number = typeof result?.value === "number" ? result.value : 0;
  // Agent code reaches the pin as `globalThis.ndsPinnedElemN` too: the page's own world gets that
  // one name, only once the owner pinned.
  if (number > 0) {
    await chrome.debugger
      .sendCommand({ tabId: tab }, "Runtime.evaluate", {
        expression: `globalThis.ndsPinnedElem${number} = document.querySelector('[data-nds-pin="${number}"]')`,
      })
      .catch(() => undefined);
  }
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: `NDS agent ${attachment.life.group}`,
    message: number
      ? `Pinned as ndsPinnedElem${number}.`
      : "Right-click the element itself to pin it.",
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PIN,
      title: chrome.i18n.getMessage("pinElement"),
      contexts: ["all"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === PIN && tab?.id !== undefined) void pin(tab.id).catch(() => undefined);
});

function ownerOpened(id: string): void {
  if (!id.startsWith(OWNER)) return;
  void chrome.notifications.clear(id).catch(() => undefined);
  void openForOwner(Number(id.slice(OWNER.length)));
}
chrome.notifications.onClicked.addListener(ownerOpened);
chrome.notifications.onButtonClicked?.addListener((id) => ownerOpened(id));

// Owner notifications of an earlier worker point at checks and holds this worker does not know;
// they are cleared rather than left to open a tab no agent watches.
void chrome.notifications
  .getAll?.()
  .then((all) =>
    Promise.all(
      Object.keys(all ?? {})
        .filter((id) => id.startsWith(OWNER))
        .map((id) => chrome.notifications.clear(id)),
    ),
  )
  .catch(() => undefined);

// A removed tab ends its debugger session; Chrome may report the removal before the detach.
chrome.tabs.onRemoved.addListener((tab) => {
  void chrome.notifications.clear(`${OWNER}${tab}`);
  const attachment = attached.get(tab);
  if (!attachment) return;
  ended(tab, attachment);
  send({ type: "detached", tab, reason: "target_closed" });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tab = source.tabId;
  if (tab === undefined || !usable(tab) || NOISY.has(method)) return;
  if (source.sessionId && ignored.has(source.sessionId)) return;
  const fields = (params ?? {}) as Record<string, unknown>;
  if (method === "Target.attachedToTarget") {
    const info = fields.targetInfo as { url?: string } | undefined;
    if (restricted(info?.url, [chrome.runtime.id])) {
      // Another extension's frame or a browser page: one command to it ends the whole tab
      // session. It is detached on the session that reported it, which also lets it run on.
      const child = String(fields.sessionId);
      ignored.add(child);
      report("browser.target.restricted");
      void chrome.debugger
        .sendCommand(source, "Target.detachFromTarget", { sessionId: child })
        .catch(() => undefined);
      return;
    }
  }
  if (method === "Target.detachedFromTarget" && ignored.delete(String(fields.sessionId))) return;
  // The worker's own screencast frames go nowhere: they are answered and dropped.
  if (method === "Page.screencastFrame" && !source.sessionId && !awake.get(tab)?.agent) {
    void chrome.debugger
      .sendCommand(source, "Page.screencastFrameAck", { sessionId: fields.sessionId })
      .catch(() => undefined);
    return;
  }
  if (method === "Page.downloadWillBegin" || method === "Page.downloadProgress") {
    if (!announce(tab, method, fields)) return;
  }
  restore.track(tab, !source.sessionId, method, fields);
  send({ type: "event", tab, session: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tab = source.tabId;
  const attachment = tab === undefined ? undefined : attached.get(tab);
  if (tab === undefined || !attachment) return;
  // Chrome detached a live agent tab on its own, most often because another extension's frame
  // navigated in it. The tab is attached again and restored, a few times in a row at most.
  const live = reason === "target_closed" && usable(tab) && !reattaching.has(tab);
  if (live && restore.mayReattach(tab, Date.now())) {
    const attempt = admitted(attachment.life, reattach(tab, attachment))
      .then(({ outcome, error }) => {
        report("browser.target.reattached", error);
        settle(tab, attachment, reason, outcome);
        return outcome === "restored";
      })
      .finally(() => {
        if (reattaching.get(tab) === attempt) reattaching.delete(tab);
      });
    reattaching.set(tab, attempt);
    return;
  }
  if (live) report("browser.target.reattached", "reattach_limit");
  lose(tab, attachment, reason);
});

function lose(tab: number, attachment: Attachment, reason: string): void {
  ended(tab, attachment);
  send({ type: "detached", tab, reason });
}

// What a reattach left behind: the tab restored; no session of this worker on it; or a session
// it attached but could neither restore nor detach. A tab not restored names why, for telemetry.
type Outcome = "restored" | "gone" | "held";
type Reattached = { outcome: Outcome; error?: "attach_failed" | "target_changed" };

// Agents lose a tab that was not restored. A session this worker still holds is never counted as
// ended: it stays recorded, out of agents' reach, until a detach resolves or Chrome reports its
// end, so a release cannot confirm while it lives.
function settle(tab: number, attachment: Attachment, reason: string, outcome: Outcome): void {
  if (outcome === "restored" || attachment.ended) return;
  if (outcome === "gone") {
    lose(tab, attachment, reason);
    return;
  }
  attachment.revoked = true;
  send({ type: "detached", tab, reason });
}

// Attaches a tab again after Chrome detached it on its own and restores what agents saw: the old
// session's contexts and child sessions are reported gone, frames that vanished meanwhile are
// detached, and Playwright's setup is replayed. Exactly this attachment must still be current
// before the attach and after every later wait; a tab whose target changed, that left its agent
// group or whose life closed meanwhile gets no further command and is detached again.
async function reattach(tab: number, attachment: Attachment): Promise<Reattached> {
  const current = () => usable(tab) === attachment;
  asleep(tab);
  send({ type: "event", tab, method: "Runtime.executionContextsCleared", params: {} });
  for (const child of restore.takeChildren(tab))
    send({ type: "event", tab, method: "Target.detachedFromTarget", params: { sessionId: child } });
  await removeForeignFrames(tab, attachment.life, attachment);
  // Frame cleanup admits nothing; the attach itself needs this attachment still current.
  if (!current()) return { outcome: "gone", error: "attach_failed" };
  try {
    await chrome.debugger.attach({ tabId: tab }, PROTOCOL);
  } catch {
    return { outcome: "gone", error: "attach_failed" };
  }
  let error: "attach_failed" | "target_changed" = "attach_failed";
  // A session of this worker exists from here on. It ends only through a detach that resolved or
  // Chrome's own report, never because a step failed.
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    if (!current()) throw new Refusal("target_closed");
    const value = await work();
    if (!current()) throw new Refusal("target_closed");
    return value;
  };
  try {
    const info = (await step(() => command({ tabId: tab }, "Target.getTargetInfo"))) as {
      targetInfo: { targetId?: string };
    };
    if (info.targetInfo.targetId !== attachment.target) {
      error = "target_changed";
      throw new Refusal("target_closed");
    }
    const { frameTree } = (await step(() => command({ tabId: tab }, "Page.getFrameTree"))) as {
      frameTree: FrameTree;
    };
    for (const frameId of restore.takeRemovedFrames(tab, frameTree))
      send({
        type: "event",
        tab,
        method: "Page.frameDetached",
        params: { frameId, reason: "remove" },
      });
    await restore.replay(tab, (method, params) =>
      step(() => command({ tabId: tab }, method, params)),
    );
    await step(() => remember(tab, current));
    return { outcome: "restored" };
  } catch {
    // The cleanup acts only for this attachment: once Chrome reported its session ended, or the
    // tab belongs to another attachment, the session is not this worker's to detach.
    if (attachment.ended || attached.get(tab) !== attachment) return { outcome: "gone", error };
    const outcome = await chrome.debugger.detach({ tabId: tab }).then(
      () => "gone" as const,
      () => "held" as const,
    );
    return { outcome, error };
  }
}

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
  spawned(life.group, details.sourceTabId, id, details.url);
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
async function setObservation(profile: Observation): Promise<void> {
  observation = profile;
  send({ type: "observation", profile });
  await chrome.storage.local.set({ [OBSERVATION]: profile });
}

async function setEnabled(value: boolean): Promise<void> {
  enabled = value;
  if (!enabled) closeAll();
  send({ type: "control", enabled });
  await chrome.storage.local.set({ [ENABLED]: enabled });
  if (!enabled) await detachAll();
  if (!port) connect();
  await badge();
}

// The owner's recorder button: the host runs `recorder.start()`, `stop()` or `status()` in the
// session of the agent group that holds the owner's tab, as `recorder start` does for an agent,
// so an agent later reads what the owner did. The popup names its tab only when it is opened as
// a page of its own (tests); otherwise it is the active tab of the last focused window.
const RECORD_REPLY_MS = 15_000;
const recorded = new Map<number, (answer: OwnerRecording) => void>();
let records = 0;

async function record(action: string, tab: number | undefined): Promise<OwnerRecording> {
  const id =
    tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1;
  const held = usable(id);
  if (!held) return { error: "no_agent_tab" };
  if (!port) return { error: "extension_unavailable" };
  const request = ++records;
  return new Promise((done) => {
    const timer = setTimeout(() => finish({ error: "timeout" }), RECORD_REPLY_MS);
    function finish(answer: OwnerRecording): void {
      clearTimeout(timer);
      recorded.delete(request);
      done(answer);
    }
    recorded.set(request, finish);
    send({ type: "record", request, group: held.life.group, action });
  });
}

// The popup's view of the owner's tab: the agent group it belongs to, the newest steps the
// journal holds of that group, and the site the owner may keep private.
const journaled = new Map<number, (lines: string[]) => void>();
let journals = 0;

async function tabOf(tab: number | undefined): Promise<chrome.tabs.Tab | undefined> {
  if (tab !== undefined) return chrome.tabs.get(tab).catch(() => undefined);
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}

function siteOf(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

async function recent(tab: number | undefined): Promise<{ lines?: string[]; error?: string }> {
  const id = (await tabOf(tab))?.id ?? -1;
  const held = usable(id);
  if (!held) return { error: "no_agent_tab" };
  if (!port) return { error: "extension_unavailable" };
  const request = ++journals;
  return new Promise((done) => {
    const timer = setTimeout(() => finish(undefined), RECORD_REPLY_MS);
    function finish(lines: string[] | undefined): void {
      clearTimeout(timer);
      journaled.delete(request);
      done(lines ? { lines } : { error: "timeout" });
    }
    journaled.set(request, finish);
    send({ type: "journal", request, group: held.life.group });
  });
}

async function setPrivate(sites: string[]): Promise<void> {
  privateSites = [...new Set(sites)].sort().slice(0, PRIVATE_LIMIT);
  send({ type: "private", sites: privateSites });
  await chrome.storage.local.set({ [PRIVATE]: privateSites });
}

// The connected host's build, asked for once per connection; the popup's footer names it.
let hostBuild: { version: string; commit: string } | undefined;
const abouts: (() => void)[] = [];

async function about(): Promise<void> {
  if (hostBuild || !port) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 1000);
    abouts.push(() => {
      clearTimeout(timer);
      done();
    });
    send({ type: "about" });
  });
}

async function status(tab: number | undefined): Promise<object> {
  const [owner] = await Promise.all([tabOf(tab), about()]);
  const site = siteOf(owner?.url);
  const group = owner?.id === undefined ? undefined : usable(owner.id)?.life.group;
  return {
    enabled,
    observation,
    connected: port !== undefined,
    hostContract,
    tabs: [...attached.keys()].filter(usable).length,
    privateSites,
    version: chrome.runtime.getManifest().version,
    hasTab: owner !== undefined,
    ...(hostBuild ? { host: hostBuild } : {}),
    ...(site ? { site } : {}),
    ...(group ? { group } : {}),
  };
}

chrome.runtime.onMessage.addListener(
  (
    message: {
      type?: string;
      enabled?: boolean;
      profile?: string;
      action?: string;
      tab?: number;
      site?: string;
    },
    sender,
    reply,
  ) => {
    // Only this extension's own pages (the popup) may change the switch.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))
      return false;
    const tab = typeof message.tab === "number" ? message.tab : undefined;
    // Every answer reflects, and every change starts from, the owner's stored settings.
    const answer = (work: () => Promise<unknown>): true => {
      void loaded.then(work).then(reply);
      return true;
    };
    if (message.type === "set" && typeof message.enabled === "boolean") {
      const value = message.enabled;
      return answer(() => setEnabled(value).then(() => status(tab)));
    }
    const profile = OBSERVATIONS.find((each) => each === message.profile);
    if (message.type === "observe" && profile) {
      return answer(() => setObservation(profile).then(() => status(tab)));
    }
    if (message.type === "private" && (message.action === "add" || message.action === "remove")) {
      const site = message.site?.toLowerCase();
      const add = message.action === "add";
      return answer(() =>
        setPrivate(
          add
            ? site
              ? [...privateSites, site]
              : privateSites
            : privateSites.filter((each) => each !== site),
        ).then(() => status(tab)),
      );
    }
    if (message.type === "recent") return answer(() => recent(tab));
    if (
      message.type === "record" &&
      (message.action === "start" || message.action === "stop" || message.action === "status")
    ) {
      const action = message.action;
      return answer(() => record(action, tab));
    }
    if (message.type === "get") return answer(() => status(tab));
    return false;
  },
);

// The owner's stored settings, read once per worker. Nothing reaches the host before them: a
// browser start or an update fires its event before storage answers, and a hello with the
// defaults would let the host record what the owner turned off. Unreadable storage leaves the
// defaults.
const loaded = load().catch(() => undefined);

// Browser start and install/update/reload each start the worker; all of them connect once the
// settings are known.
function start(): void {
  void loaded.then(connect);
}
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
start();
