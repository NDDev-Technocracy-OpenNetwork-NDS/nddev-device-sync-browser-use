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
`session list` and `session close` complete the surface. An agent closes its
session when its task is done; that closes the session's tabs too, unless
`--keep-tabs` leaves them for the owner. A session's executor
starts with the session, and `session list` reports `executor: true` once it is
ready; an execution that times out while the executor is still starting
leaves the start running for the next one. `install` registers
the host for one Chrome profile root; loading the unpacked extension stays the
owner's action. Status: alpha work in progress. Linux, macOS and Windows are
each accepted in CI with a real browser; none has been qualified on an owner
device. Not a replacement for Playwriter in current NDS acceptance.

Agent code runs as an async function body with `context`, `browser`, a
persistent `state` object, `artifacts` (the session's private directory for
screenshots and files, removed with the session), the helpers below, and
`fetch`/timers. A single expression is returned; otherwise use `return`.
`context.pages()` lists only the session's tabs, and
`context.newCDPSession(page)` gives raw CDP for those tabs. Each reply lists
the tabs with `target` and `document`; pass `--expect <target>:<document>` to
refuse running against a replaced document.

- `snapshot({ page })` returns the page's accessibility snapshot, headed by its
  URL, in which every element carries a ref such as `[ref=e5]`;
  `page.locator(refToLocator({ ref: "e5" }))` or `ref({ page, ref: "e5" })`
  reaches it until the next snapshot. The first call shows the whole page,
  later calls only the lines that changed, and a navigation starts over.
  `search` (a string or pattern) shows the first matching lines,
  `showDiffSinceLastCall: false` the whole page again, and a `locator` or
  `frame` only that part.
- `getLatestLogs({ page, sinceLastCall, search, count })` reads the page's
  console messages and errors, kept from the moment the session first saw the
  page; with `sinceLastCall` it returns only what is new.
- `waitForPageLoad({ page, timeout })` waits until the document is complete
  and its own requests have finished, ignoring analytics, ads, long polls and
  streams, and reports `{ success, readyState, pendingRequests, waitTimeMs }`.
- `inspect({ locator, properties })` describes an element's box, scroll state,
  styles, visibility, input state and aria attributes.

A result also carries `[PAGE ERROR]` lines for uncaught errors and
`[WARNING] New page opened` lines for new tabs of the pages an agent keeps in
`state`, so a failure or a popup is seen without asking for it.

Bot checks such as Cloudflare Turnstile, reCAPTCHA and hCaptcha are for a person
to pass, so agent code never acts inside one. `checks(page)` lists the visible
checks of a page with their vendor and whether the page holds a passed response.
When one stays unsolved, `notifyOwner(page, reason)` shows the owner a Chrome
notification that names the agent and the site and opens the tab when clicked.
The agent continues with other work, checks the page again later and calls
`clearOwner(page)` once the check is passed; closing the tab also clears it.
Fewer checks appear when agents work in the owner's profile without request
bursts and use an official API or CLI where one exists.

Limits: Chrome serves WebAuthn only to a focused page, so a passkey step needs
`page.bringToFront()` and visibly activates the agent tab. Chrome keeps every
extension out of `chrome://` pages and the Chrome Web Store. Browser-chrome
and OS dialogs, real authenticators' user verification, downloads events,
browser-wide cookies, new browser contexts and permission grants are outside
`chrome.debugger`.

## Owned NDS sessions

Native NDS composition uses `BrowserUse::create_owned` to reserve a fresh
host generation, retains that opaque Rust handle, then calls `open_owned`,
`execute_owned` and `close_owned` with the same handle. Reservation performs
no browser action and starts no executor; a lost reservation reply cannot
start one. Reservations share the existing finite session limit. Existing
project-only CLI operations retain their local, project-oriented meaning.

Successful owned close means the executor has stopped and been reaped,
lifecycle mutations have answered, and an opened generation's release has
been confirmed by the extension with exactly `{"released":true}`. An unopened
reservation needs no browser action. An older `{}` release answer is refused.
A lost or unknown lifecycle mutation still keeps admission
closed: retain the handle instead of adopting or closing another session.

A strict release may end that exact generation's outstanding CDP transport
authority without a command reply. This does not report command success or
undo website actions already issued. CDP admission and bounded enqueue share
the close fence, so an old sender cannot queue work into a replacement.
Older hosts refuse the new private operations; clients never fall back to
project-only operations. The Chrome tab-group boundary remains in force;
installation and extension control remain explicit.

## Privacy

The extension talks only to the NDS host installed on the same device. Page
content, URLs, screenshots and agent code stay on that device: results go to
the local agent that asked for them, and artifacts are deleted with the
session. Nothing is sent to NDDev or third parties; local telemetry carries
event names, outcomes and durations, never page data.

Run `just check`, then `just browser-check` with `NDS_TEST_CHROME` set to the
Chrome for Testing build pinned in `provider.lock.json`. `just install
<browser>` installs locally and then runs `nds-browser-use update`, which
reloads a connected unpacked extension from the new files; `just package`
builds the Chrome Web Store zip.
The host admits the pinned unpacked build and the published store item
`lpnfnhkdjamhnoknoohhmjfhhjkeofio`.

On Windows the host's sockets and configuration live in the user's
`%LOCALAPPDATA%\nds-browser-use`. `just install` is a Unix recipe; run
`nds-browser-use install --bun <bun.exe> --executor <executor.ts> --browser <name>`
from the installed prefix instead. It registers the host in the user's registry
under the key of the browser's branding: the Google Chrome key for Chrome and
Chrome Beta, and the Chromium key for Chromium and Chrome for Testing. CI
exercises only the Chrome for Testing registration.

Release journals live in [GitHub Releases](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync-browser-use/releases).
