// What an agent tab's debugger session needs restored after Chrome detached it on its own.
//
// Chrome detaches chrome.debugger from a whole tab when one of its frames starts navigating to
// another extension's chrome-extension:// page, for example the inline menu a password manager
// injects when a field gets focus (Chromium issue 498987209, Won't Fix). The worker then attaches
// again and replays the setup Playwright sent on the tab's root session, so the page agents hold
// stays usable. Pure rules only; the worker owns every chrome.* call.
//
// Adapted from MIT-licensed code by Tommy D. Rossi (NOTICE.md).

// A setup command as sent to Chrome; an init script also keeps Chrome's current identifier.
export type SetupCommand = {
  method: string;
  params?: object | undefined;
  scriptIdentifier?: string | undefined;
};

type TabSession = {
  // Setup in replay order. Keys make a later command replace or remove an earlier one, so
  // Network.disable removes Network.enable.
  setup: Map<string, SetupCommand>;
  // Frames reported by Page.frameAttached; a frame removed while detached never reports it.
  frames: Set<string>;
  // Child sessions (out-of-process frames, workers) Chrome attached under the tab.
  children: Set<string>;
  reattaches: number[];
  // The size of the recorded setup, by the measure `size` gives.
  bytes: number;
  // Room held for setup commands sent but not answered yet, so concurrent ones share the bounds.
  reservedCommands: number;
  reservedBytes: number;
};

// The setup a tab may record, so restoring it stays finite: a command that would grow it past
// either bound is refused before it reaches Chrome, never recorded short.
export const MAX_SETUP_COMMANDS = 256;
export const MAX_SETUP_BYTES = 1_048_576;

function size(command: SetupCommand): number {
  return command.method.length + JSON.stringify(command.params ?? {}).length;
}

// Where a command goes in the recorded setup: under a key it puts, a key it deletes, or nowhere.
type Effect = { put: string } | { remove: string } | undefined;

function effect(method: string, params: object | undefined): Effect {
  const [domain = "", command = ""] = method.split(".");
  const fields = params as { identifier?: string; name?: string } | undefined;
  if (method === "Page.addScriptToEvaluateOnNewDocument") return { put: "script:" };
  if (command === "enable") return { put: domain };
  if (command === "disable") return { remove: domain };
  if (method === "Page.removeScriptToEvaluateOnNewDocument")
    return { remove: `script:${fields?.identifier}` };
  if (method === "Runtime.addBinding") return { put: `binding:${fields?.name}` };
  if (method === "Runtime.removeBinding") return { remove: `binding:${fields?.name}` };
  if (domain === "Emulation" && command.startsWith("clear"))
    return { remove: `Emulation.set${command.slice("clear".length)}` };
  if ((domain === "Emulation" && command.startsWith("set")) || REPLAYED_SETTERS.has(method))
    return { put: method };
  return undefined;
}

// An extension that injects its frame again right after every attach must not loop forever.
export const MAX_REATTACHES = 5;
export const REATTACH_WINDOW_MS = 5_000;

const REPLAYED_SETTERS = new Set([
  "Page.setLifecycleEventsEnabled",
  "Page.setInterceptFileChooserDialog",
  "Page.setBypassCSP",
  "Network.setExtraHTTPHeaders",
  "Network.setCacheDisabled",
  "Network.setBypassServiceWorker",
  "Network.emulateNetworkConditions",
  "Network.setUserAgentOverride",
  "Security.setIgnoreCertificateErrors",
  "Target.setAutoAttach",
]);

export type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };

// The restore state of every attached agent tab. Only tabs with an entry are recorded, so a late
// result for a released tab is ignored.
export class Restore {
  private readonly sessions = new Map<number, TabSession>();
  private nextScript = 1;

  startSession(tab: number): void {
    this.sessions.set(tab, {
      setup: new Map(),
      frames: new Set(),
      children: new Set(),
      reattaches: [],
      bytes: 0,
      reservedCommands: 0,
      reservedBytes: 0,
    });
  }

  endSession(tab: number): void {
    this.sessions.delete(tab);
  }

  // Whether one more reattach fits the window; a fitting one is counted.
  mayReattach(tab: number, now: number): boolean {
    const session = this.sessions.get(tab);
    if (!session) return false;
    session.reattaches = session.reattaches.filter((time) => now - time < REATTACH_WINDOW_MS);
    if (session.reattaches.length >= MAX_REATTACHES) return false;
    session.reattaches.push(now);
    return true;
  }

  // Follows the frames the tab's root session reports and the child sessions of every level.
  track(tab: number, root: boolean, method: string, params: Record<string, unknown>): void {
    const session = this.sessions.get(tab);
    if (!session) return;
    if (root && method === "Page.frameAttached") session.frames.add(String(params.frameId));
    // A swapped frame became out-of-process; its child session reports it from now on.
    if (root && method === "Page.frameDetached") session.frames.delete(String(params.frameId));
    if (method === "Target.attachedToTarget") session.children.add(String(params.sessionId));
    if (method === "Target.detachedFromTarget") session.children.delete(String(params.sessionId));
  }

  // The child sessions Chrome dropped with the detach; each is forgotten as it is returned.
  takeChildren(tab: number): string[] {
    const session = this.sessions.get(tab);
    if (!session) return [];
    const children = [...session.children];
    session.children.clear();
    return children;
  }

  // Frames agents still know that the reattached frame tree no longer holds.
  takeRemovedFrames(tab: number, tree: FrameTree): string[] {
    const frames = this.sessions.get(tab)?.frames;
    if (!frames) return [];
    const ids = (node: FrameTree): string[] => [
      node.frame.id,
      ...(node.childFrames ?? []).flatMap(ids),
    ];
    const live = new Set(ids(tree));
    const removed = [...frames].filter((frame) => !live.has(frame));
    for (const frame of removed) frames.delete(frame);
    return removed;
  }

  // Agents got a stable init script identifier; Chrome's own changes with every attach.
  chromeParams(tab: number, method: string, params?: object): object | undefined {
    if (method !== "Page.removeScriptToEvaluateOnNewDocument") return params;
    const identifier = (params as { identifier?: string } | undefined)?.identifier;
    const chrome = this.sessions.get(tab)?.setup.get(`script:${identifier}`)?.scriptIdentifier;
    return chrome ? { ...params, identifier: chrome } : params;
  }

  // Reserves room for a setup command before it is sent, counting the room that commands still
  // in flight hold, so concurrent commands near a bound cannot all fit. Every pending put holds a
  // whole new entry, even when its key is recorded now: a removal of that key while it waits must
  // not hand its room to another command. Answers false when it does not fit; otherwise a
  // release, to call once the command answered or failed, after `record`.
  reserve(tab: number, method: string, params: object | undefined): (() => void) | false {
    const session = this.sessions.get(tab);
    const change = effect(method, params);
    if (!session || !change || !("put" in change)) return () => {};
    const script = change.put === "script:";
    const bytes = size({ method, params: script ? { ...params, runImmediately: false } : params });
    if (
      session.setup.size + session.reservedCommands + 1 > MAX_SETUP_COMMANDS ||
      session.bytes + session.reservedBytes + bytes > MAX_SETUP_BYTES
    )
      return false;
    session.reservedCommands += 1;
    session.reservedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.reservedCommands -= 1;
      session.reservedBytes -= bytes;
    };
  }

  // Records a successful root-session command when it is setup; any other command is ignored.
  // An init script's result is returned with the stable identifier agents keep.
  record(tab: number, method: string, params: object | undefined, result: unknown): unknown {
    const session = this.sessions.get(tab);
    const change = effect(method, params);
    if (!session || !change) return result;
    const { setup } = session;
    const remove = (key: string) => {
      const previous = setup.get(key);
      if (!previous) return;
      session.bytes -= size(previous);
      setup.delete(key);
    };
    // The latest command moves to the end, so a replay keeps the order agents gave.
    const put = (key: string, command: SetupCommand) => {
      remove(key);
      setup.set(key, command);
      session.bytes += size(command);
    };
    if ("remove" in change) {
      remove(change.remove);
      return result;
    }
    if (change.put === "script:") {
      const identifier = `nds-${this.nextScript++}`;
      // The script already ran in the current documents; a replay is for later ones only.
      put(`script:${identifier}`, {
        method,
        params: { ...params, runImmediately: false },
        scriptIdentifier: (result as { identifier?: string } | undefined)?.identifier,
      });
      return { ...(result as object), identifier };
    }
    put(change.put, { method, params });
    return result;
  }

  // Replays the recorded setup in order. One rejected command must not drop the tab; the failed
  // methods are returned.
  async replay(
    tab: number,
    send: (method: string, params?: object) => Promise<unknown>,
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const command of this.sessions.get(tab)?.setup.values() ?? []) {
      try {
        const result = await send(command.method, command.params);
        if (command.method === "Page.addScriptToEvaluateOnNewDocument")
          command.scriptIdentifier = (result as { identifier?: string }).identifier;
      } catch {
        failed.push(command.method);
      }
    }
    return failed;
  }
}

// A child target agents may never reach: another extension's page, or a browser-internal one.
// Chrome refuses commands to them in a way that ends the whole tab session.
export function restricted(url: string | undefined, own: readonly string[]): boolean {
  if (!url) return false;
  if (url.startsWith("chrome-extension://")) {
    const id = url.slice("chrome-extension://".length).split("/")[0] ?? "";
    return !own.includes(id);
  }
  return ["chrome://", "chrome-untrusted://", "devtools://", "edge://"].some((prefix) =>
    url.startsWith(prefix),
  );
}
