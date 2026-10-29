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
void chrome.runtime.sendMessage({ type: "get" }).then((status) => show(status));
