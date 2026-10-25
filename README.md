# NDDev OpenNetwork · browser-use

AGPL-3.0-only NDS module. [NDDev OpenNetwork](https://nddev.ai).

Agent browser automation inside owner-granted Chrome tab groups, as defined by
[ADR 0015](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync/blob/dev/standarts/decisions/0015-agent-browser-automation.md).
The pinned MV3 extension (`packages/extension`) attaches only to NDS tab groups and
talks to the Rust host through Chrome native messaging. The host serves agents
on a private Unix socket and runs each session's Playwright code in a Bun
executor (`packages/executor`) connected to a session-scoped CDP endpoint. There is
no TCP listener, debugging port, tunnel or vendor telemetry.

Agent CLI: `nds-browser-use session new <project>`, then
`nds-browser-use -s <project> -e '<playwright code>'`; `status`,
`session list` and `session close` complete the surface. `install` registers
the host for one Chrome profile root; loading the unpacked extension stays the
owner's action. Status: alpha work in progress, Linux only, not qualified and
not a replacement for Playwriter in current NDS acceptance.

Agent code runs as an async function body with `context`, `browser`, a
persistent `state` object, `artifacts` (the session's private directory for
screenshots and files, removed with the session), `snapshot(page)` for an
ARIA snapshot, and `fetch`/timers. A single expression is returned; otherwise
use `return`. `context.pages()` lists only the session's tabs, and
`context.newCDPSession(page)` gives raw CDP for those tabs. Each reply lists
the tabs with `target` and `document`; pass `--expect <target>:<document>` to
refuse running against a replaced document.

Limits: Chrome serves WebAuthn only to a focused page, so a passkey step needs
`page.bringToFront()` and visibly activates the agent tab. Browser-chrome and
OS dialogs, real authenticators' user verification, downloads events,
browser-wide cookies, new browser contexts and permission grants are outside
`chrome.debugger`.

Run `just check`, then `just browser-check` with `NDS_TEST_CHROME` set to the
Chrome for Testing build pinned in `provider.lock.json`.

Release journals live in [GitHub Releases](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync-browser-use/releases).
