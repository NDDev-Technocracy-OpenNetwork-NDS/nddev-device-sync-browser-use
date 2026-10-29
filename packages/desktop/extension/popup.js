"use strict";
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
    state.textContent = `${status.enabled ? "Enabled" : "Disabled"} · ${host}`;
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
}
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
// A popup opened as a page of its own, as in tests, names the tab it acts for.
const forTab = Number(new URLSearchParams(location.search).get("tab")) || undefined;
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
void chrome.runtime.sendMessage({ type: "get" }).then((status) => show(status));
void ask("status");
