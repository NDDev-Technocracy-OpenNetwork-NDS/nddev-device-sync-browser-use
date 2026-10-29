"use strict";
// A popup opened as a page of its own, as in tests, names the tab it acts for.
const forTab = Number(new URLSearchParams(location.search).get("tab")) || undefined;
const state = document.getElementById("state");
const toggle = document.getElementById("toggle");
const profiles = [...document.querySelectorAll("button[data-profile]")];
const described = document.getElementById("observation");
const DESCRIPTIONS = {
    full: "Agents' actions, pages' network and console, kept for agents to read; secrets removed.",
    standard: "Only names, timings and outcomes of agent actions; no page content.",
    off: "Nothing is collected; the recorder is off.",
};
function show(status) {
    if (!state || !toggle)
        return;
    const host = status.connected ? "host connected" : "host not connected";
    state.textContent =
        status.hostContract !== undefined
            ? `The NDS host and this extension do not match (host contract ${status.hostContract}): update the extension, or run \`nds-browser-use install\` for a newer host.`
            : `${status.enabled ? "Enabled" : "Disabled"} · ${host}`;
    document.body.dataset.compatible = String(status.hostContract === undefined);
    toggle.textContent = status.enabled ? "Disable agent control" : "Enable agent control";
    toggle.dataset.enabled = String(status.enabled);
    toggle.disabled = false;
    const current = status.observation ?? "full";
    for (const button of profiles) {
        button.setAttribute("aria-pressed", String(button.dataset.profile === current));
        button.disabled = false;
    }
    if (described)
        described.textContent = DESCRIPTIONS[current];
    document.body.dataset.observation = current;
    showPrivate(status);
}
// Private sites: the owner adds the site of the tab and removes any listed one.
const privateList = document.getElementById("private");
const privateAdd = document.getElementById("private-add");
function showPrivate(status) {
    if (!privateList || !privateAdd)
        return;
    const sites = status.privateSites ?? [];
    privateList.replaceChildren(...sites.map((site) => {
        const item = document.createElement("li");
        item.textContent = site;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = `Keep content of ${site} again`;
        remove.addEventListener("click", () => void changePrivate("remove", site));
        item.append(remove);
        return item;
    }));
    const site = status.site;
    privateAdd.disabled = !site || sites.includes(site);
    privateAdd.dataset.site = site ?? "";
    privateAdd.textContent = site
        ? sites.includes(site)
            ? `${site} is private`
            : `Keep ${site} private`
        : "Keep this site private";
}
async function changePrivate(action, site) {
    show((await chrome.runtime.sendMessage({ type: "private", action, site, tab: forTab })));
}
privateAdd?.addEventListener("click", () => {
    const site = privateAdd.dataset.site;
    if (site)
        void changePrivate("add", site);
});
toggle?.addEventListener("click", async () => {
    toggle.disabled = true;
    const enabled = toggle.dataset.enabled !== "true";
    show((await chrome.runtime.sendMessage({ type: "set", enabled })));
});
for (const button of profiles) {
    button.addEventListener("click", async () => {
        for (const each of profiles)
            each.disabled = true;
        show((await chrome.runtime.sendMessage({
            type: "observe",
            profile: button.dataset.profile,
        })));
    });
}
const record = document.getElementById("record");
const recording = document.getElementById("recording");
const REFUSED = {
    no_agent_tab: "Open a tab of an agent group to record what you do there.",
    session_not_found: "This agent group has no open session.",
    busy: "The agent is running code; try again in a moment.",
    permission_required: "Agent control is disabled.",
    extension_unavailable: "The NDS host is not connected.",
    timeout: "The NDS host did not answer.",
};
function recorded(answer) {
    if (!record || !recording)
        return;
    const active = answer.recording === true;
    record.textContent = active ? "Stop recording" : "Record what I do";
    record.dataset.recording = String(active);
    record.disabled = answer.error === "no_agent_tab";
    document.body.dataset.recording = answer.error ? "error" : String(active);
    recording.textContent = answer.error
        ? (REFUSED[answer.error] ?? answer.message ?? answer.error)
        : active
            ? `Recording your actions in this agent group${answer.events ? ` (${answer.events} so far)` : ""}.`
            : answer.id
                ? `Recorded ${answer.events ?? 0} actions; the agent reads them with \`recorder events\`.`
                : "Your clicks, typing and navigations in this group become steps the agent can replay.";
}
async function ask(action) {
    recorded((await chrome.runtime.sendMessage({ type: "record", action, tab: forTab })));
}
record?.addEventListener("click", () => {
    record.disabled = true;
    void ask(record.dataset.recording === "true" ? "stop" : "start");
});
// The newest steps of the agent group of the owner's tab, as its activity journal holds them.
const recentList = document.getElementById("recent");
const recentNote = document.getElementById("recent-note");
function step(line) {
    try {
        const record = JSON.parse(line);
        const time = typeof record.at === "string" ? record.at.slice(11, 19) : "";
        const what = [record.api, record.method, record.locator, record.url, record.text, record.name]
            .filter((part) => typeof part === "string" && part !== "")
            .join(" ");
        return `${time}  ${String(record.type)}${record.private ? " (private)" : ""}  ${what}`;
    }
    catch {
        return line;
    }
}
async function showRecent() {
    if (!recentList || !recentNote)
        return;
    const answer = (await chrome.runtime.sendMessage({ type: "recent", tab: forTab }));
    const lines = answer.lines ?? [];
    recentList.replaceChildren(...lines
        .slice()
        .reverse()
        .map((line) => {
        const item = document.createElement("li");
        item.textContent = step(line);
        return item;
    }));
    recentNote.textContent = answer.error
        ? answer.error === "no_agent_tab"
            ? "Open a tab of an agent group to see what its agent did."
            : "The NDS host did not answer."
        : lines.length === 0
            ? "Nothing yet; the journal keeps agents' steps in the full observation profile."
            : "Newest first. Agents read all of it with `nds-browser-use -s <project> activity`.";
    document.body.dataset.recent = String(lines.length);
}
void chrome.runtime
    .sendMessage({ type: "get", tab: forTab })
    .then((status) => show(status));
void showRecent();
void ask("status");
