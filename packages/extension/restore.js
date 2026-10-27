// What an agent tab's debugger session needs restored after Chrome detached it on its own.
//
// Chrome detaches chrome.debugger from a whole tab when one of its frames starts navigating to
// another extension's chrome-extension:// page, for example the inline menu a password manager
// injects when a field gets focus (Chromium issue 498987209, Won't Fix). The worker then attaches
// again and replays the setup Playwright sent on the tab's root session, so the page agents hold
// stays usable. Pure rules only; the worker owns every chrome.* call.
//
// Adapted from Playwriter's extension/src/session-reattach.ts (MIT License, Copyright (c) 2026
// Tommy D. Rossi, https://github.com/remorses/playwriter).
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
// The restore state of every attached agent tab. Only tabs with an entry are recorded, so a late
// result for a released tab is ignored.
export class Restore {
    sessions = new Map();
    nextScript = 1;
    startSession(tab) {
        this.sessions.set(tab, {
            setup: new Map(),
            frames: new Set(),
            children: new Set(),
            reattaches: [],
        });
    }
    endSession(tab) {
        this.sessions.delete(tab);
    }
    // Whether one more reattach fits the window; a fitting one is counted.
    mayReattach(tab, now) {
        const session = this.sessions.get(tab);
        if (!session)
            return false;
        session.reattaches = session.reattaches.filter((time) => now - time < REATTACH_WINDOW_MS);
        if (session.reattaches.length >= MAX_REATTACHES)
            return false;
        session.reattaches.push(now);
        return true;
    }
    // Follows the frames the tab's root session reports and the child sessions of every level.
    track(tab, root, method, params) {
        const session = this.sessions.get(tab);
        if (!session)
            return;
        if (root && method === "Page.frameAttached")
            session.frames.add(String(params.frameId));
        // A swapped frame became out-of-process; its child session reports it from now on.
        if (root && method === "Page.frameDetached")
            session.frames.delete(String(params.frameId));
        if (method === "Target.attachedToTarget")
            session.children.add(String(params.sessionId));
        if (method === "Target.detachedFromTarget")
            session.children.delete(String(params.sessionId));
    }
    // The child sessions Chrome dropped with the detach; each is forgotten as it is returned.
    takeChildren(tab) {
        const session = this.sessions.get(tab);
        if (!session)
            return [];
        const children = [...session.children];
        session.children.clear();
        return children;
    }
    // Frames agents still know that the reattached frame tree no longer holds.
    takeRemovedFrames(tab, tree) {
        const frames = this.sessions.get(tab)?.frames;
        if (!frames)
            return [];
        const ids = (node) => [
            node.frame.id,
            ...(node.childFrames ?? []).flatMap(ids),
        ];
        const live = new Set(ids(tree));
        const removed = [...frames].filter((frame) => !live.has(frame));
        for (const frame of removed)
            frames.delete(frame);
        return removed;
    }
    // Agents got a stable init script identifier; Chrome's own changes with every attach.
    chromeParams(tab, method, params) {
        if (method !== "Page.removeScriptToEvaluateOnNewDocument")
            return params;
        const identifier = params?.identifier;
        const chrome = this.sessions.get(tab)?.setup.get(`script:${identifier}`)?.scriptIdentifier;
        return chrome ? { ...params, identifier: chrome } : params;
    }
    // Records a successful root-session command when it is setup; any other command is ignored.
    // An init script's result is returned with the stable identifier agents keep.
    record(tab, method, params, result) {
        const setup = this.sessions.get(tab)?.setup;
        if (!setup)
            return result;
        // The latest command moves to the end, so a replay keeps the order agents gave.
        const put = (key, command) => {
            setup.delete(key);
            setup.set(key, command);
        };
        const [domain = "", command = ""] = method.split(".");
        const fields = params;
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
            const identifier = `nds-${this.nextScript++}`;
            // The script already ran in the current documents; a replay is for later ones only.
            put(`script:${identifier}`, {
                method,
                params: { ...params, runImmediately: false },
                scriptIdentifier: result?.identifier,
            });
            return { ...result, identifier };
        }
        if (command === "enable")
            put(domain, { method, params });
        else if (command === "disable")
            setup.delete(domain);
        else if (method === "Page.removeScriptToEvaluateOnNewDocument")
            setup.delete(`script:${fields?.identifier}`);
        else if (method === "Runtime.addBinding")
            put(`binding:${fields?.name}`, { method, params });
        else if (method === "Runtime.removeBinding")
            setup.delete(`binding:${fields?.name}`);
        else if (domain === "Emulation" && command.startsWith("clear"))
            setup.delete(`Emulation.set${command.slice("clear".length)}`);
        else if ((domain === "Emulation" && command.startsWith("set")) || REPLAYED_SETTERS.has(method))
            put(method, { method, params });
        return result;
    }
    // Replays the recorded setup in order. One rejected command must not drop the tab; the failed
    // methods are returned.
    async replay(tab, send) {
        const failed = [];
        for (const command of this.sessions.get(tab)?.setup.values() ?? []) {
            try {
                const result = await send(command.method, command.params);
                if (command.method === "Page.addScriptToEvaluateOnNewDocument")
                    command.scriptIdentifier = result.identifier;
            }
            catch {
                failed.push(command.method);
            }
        }
        return failed;
    }
}
// A child target agents may never reach: another extension's page, or a browser-internal one.
// Chrome refuses commands to them in a way that ends the whole tab session.
export function restricted(url, own) {
    if (!url)
        return false;
    if (url.startsWith("chrome-extension://")) {
        const id = url.slice("chrome-extension://".length).split("/")[0] ?? "";
        return !own.includes(id);
    }
    return ["chrome://", "chrome-untrusted://", "devtools://", "edge://"].some((prefix) => url.startsWith(prefix));
}
