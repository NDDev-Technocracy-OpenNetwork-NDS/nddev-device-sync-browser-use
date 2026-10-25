// Owner-facing switch for agent control; the worker applies and reports it.
type Status = { enabled: boolean; connected: boolean; tabs?: number };

const state = document.getElementById("state");
const toggle = document.getElementById("toggle") as HTMLButtonElement | null;

function show(status: Status): void {
  if (!state || !toggle) return;
  const host = status.connected ? "host connected" : "host not connected";
  state.textContent = `${status.enabled ? "Enabled" : "Disabled"} · ${host}`;
  toggle.textContent = status.enabled ? "Disable agent control" : "Enable agent control";
  toggle.dataset.enabled = String(status.enabled);
  toggle.disabled = false;
}

toggle?.addEventListener("click", async () => {
  toggle.disabled = true;
  const enabled = toggle.dataset.enabled !== "true";
  show((await chrome.runtime.sendMessage({ type: "set", enabled })) as Status);
});

void chrome.runtime.sendMessage({ type: "get" }).then((status) => show(status as Status));
