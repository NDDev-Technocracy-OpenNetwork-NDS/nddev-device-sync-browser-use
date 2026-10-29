// Owner-facing switches for agent control and for what agent activity is collected; the worker
// applies and reports both.
type Observation = "full" | "standard" | "off";
type Status = { enabled: boolean; observation?: Observation; connected: boolean; tabs?: number };

const state = document.getElementById("state");
const toggle = document.getElementById("toggle") as HTMLButtonElement | null;
const profiles = [...document.querySelectorAll<HTMLButtonElement>("button[data-profile]")];
const described = document.getElementById("observation");
const DESCRIPTIONS: Record<Observation, string> = {
  full: "Agents' actions, pages' network and console, kept for agents to read; secrets removed.",
  standard: "Only names, timings and outcomes of agent actions; no page content.",
  off: "Nothing is collected; the recorder is off.",
};

function show(status: Status): void {
  if (!state || !toggle) return;
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
  if (described) described.textContent = DESCRIPTIONS[current];
  document.body.dataset.observation = current;
}

toggle?.addEventListener("click", async () => {
  toggle.disabled = true;
  const enabled = toggle.dataset.enabled !== "true";
  show((await chrome.runtime.sendMessage({ type: "set", enabled })) as Status);
});

for (const button of profiles) {
  button.addEventListener("click", async () => {
    for (const each of profiles) each.disabled = true;
    show(
      (await chrome.runtime.sendMessage({
        type: "observe",
        profile: button.dataset.profile,
      })) as Status,
    );
  });
}

void chrome.runtime.sendMessage({ type: "get" }).then((status) => show(status as Status));
