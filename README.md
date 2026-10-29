# NDDev OpenNetwork · browser-use

AGPL-3.0-only NDS module. [NDDev OpenNetwork](https://nddev.ai).

Agent browser automation inside owner-granted Chrome tab groups, as defined by
[ADR 0015](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync/blob/dev/standarts/decisions/0015-agent-browser-automation.md).
The pinned MV3 extension (`packages/extension`) attaches only to NDS tab groups and
talks to the Rust host through Chrome native messaging. The host serves agents
on a private Unix socket and runs each session's Playwright code in a Bun
executor (`packages/executor`) connected to a session-scoped CDP endpoint. There is
no TCP listener, debugging port, tunnel or vendor telemetry.

What it covers of Playwriter, row by row: [Playwriter parity](docs/playwriter-parity.md).

Agent CLI: `nds-browser-use skill` prints the [agent guide](docs/agent-guide.md),
which an agent reads once per task. `nds-browser-use session new <project>`, then
`nds-browser-use -s <project> -e '<playwright code>'`; `status`,
`session list` and `session close` complete the surface. An agent closes its
session when its task is done; that closes the session's tabs too, unless
`--keep-tabs` leaves them for the owner. A session that runs nothing for 30
minutes closes by itself with its tabs; owned sessions stay with the NDS
component that composes them. A session's executor
starts with the session, and `session list` reports `executor: true` once it is
ready; an execution that times out while the executor is still starting
leaves the start running for the next one. `install` registers
the host for one Chrome profile root; loading the unpacked extension stays the
owner's action. Status: alpha work in progress. Linux, macOS and Windows are
each accepted in CI with a real browser; none has been qualified on an owner
device. Not a replacement for Playwriter in current NDS acceptance.

Agent code runs as an async function body. It gets:
- `context` and `browser`;
- a persistent `state` object;
- `signal`, its own abort signal;
- `artifacts`, the session's private directory for screenshots and files, removed with the session;
- the helpers below;
- `fetch` and timers.

A single expression is returned; otherwise use `return`. `context.pages()` lists only the session's
tabs, and `context.newCDPSession(page)` gives raw CDP for those tabs.

- **Replies.** A reply is plain text in Playwriter's form: `[WARNING]` and `[PAGE ERROR]` lines,
  then `Console output:`, then `[return value]`. It is cut at 10000 characters, and Playwright
  objects print as tags. `--json` gives the protocol answer with each tab's `target` and
  `document`; `--expect <target>:<document>` refuses to run against a replaced document.
- **Timeouts.** A script still running at its deadline is aborted: its later Playwright calls
  throw, also from callbacks it registered, and its listeners, routes and locator handlers are
  removed. The session keeps its executor and state. A script that cannot be aborted is stopped,
  and its state is reset. Playwright's default waits end before the deadline, so a stuck action
  fails with its reason first.

[docs/agent-guide.md](docs/agent-guide.md), printed by `nds-browser-use skill`, is the full guide
for agents.

- `snapshot({ page })` returns the page's accessibility tree, headed by its URL.
  - Unnamed wrappers are flattened, and every interactive line ends with a Playwright locator,
    preferring a test id, then an id, then role and name.
  - The first call shows the whole page; later calls show only the lines that changed, when that
    is shorter. A navigation starts over.
  - `search` shows the first ten matches with five lines of context; `showDiffSinceLastCall: false`
    shows the whole page again.
  - Equal locators carry `>> nth=N`. A `locator` or `frame` shows only that part, and its
    locators are relative to it; `interactiveOnly` keeps only the controls.
  - Refs such as `[ref=e5]` appear in screenshot labels and in the snapshot of a frame of another
    process. `ref({ page, ref })` or `refToLocator({ ref, page })` reaches that element through
    its frame, until the next view that shows refs.
- `getLatestLogs({ page, sinceLastCall, search, count })` reads the page's console messages and
  errors, kept from the moment the session first saw the page. With `sinceLastCall` it returns
  only what is new, and `clearAllLogs()` forgets every page's logs.
- `waitForPageLoad({ page, timeout })` waits until the document is complete
  and its own requests have finished, ignoring analytics, ads, long polls and
  streams, and reports `{ success, readyState, pendingRequests, waitTimeMs }`.
- `inspect({ locator, properties })` describes an element's box, scroll state,
  styles, visibility, input state and aria attributes.
- `getCleanHTML({ locator })` returns an element's HTML without scripts,
  styles and SVG, one indented line per element, and `getPageMarkdown({ page })`
  the main article as text through Mozilla Readability; both take `search` and
  diff like snapshots.
- `screenshotWithAccessibilityLabels({ page })` writes a screenshot into
  `artifacts` with a label on every visible interactive element, named by the
  ref of the snapshot it returns, for layouts where position matters.
  `resizeImageForAgent({ input, maxDimension })` makes a smaller copy through
  ffmpeg, which must be on PATH.
- `getLocatorStringForElement(locator)` returns a stable locator string for a
  script: a test id, a unique role and name, an id, or a tag path.
- `recording.start({ page, outputPath })` records a tab as video through
  ffmpeg, across navigations, with a ghost cursor that follows agent mouse
  actions; `recording.stop({ page })` returns the file, its duration and the
  execution times, which `createDemoVideo(...)` uses to speed up the waits
  between executions. A cut that outlasts one execution is kept in `state` and
  awaited in a later one. `ghostCursor.show/hide({ page })` controls the cursor.
- `getCDPSession({ page })`, `createDebugger({ cdp })` (breakpoints, stepping,
  local variables, evaluation in a paused frame), `createEditor({ cdp, page })`
  (search scripts and style sheets, edit style sheets live, override a script
  on its next load, since Chrome no longer edits a running script),
  `getStylesForLocator({ locator, cdp })` with `formatStylesAsText(...)`, and
  `getReactComponentInfo`/`getReactSource({ locator })` for React builds.
- `recorder.start()` records what a person does in the session's tabs, for
  turning a workflow into a skill: clicks, fills, choices, key presses and
  submissions with locators, navigations, API and failed requests without
  their bodies, console and page errors, dialogs, toasts, and a frame of each
  visual change, at most two a second, for 20 minutes or 500 MB. Password and
  payment values are recorded as `[redacted]`. `recorder.stop()` ends it,
  `recorder.events({ type, errors, full, ids })` prints its timeline, and
  `recorder.frame({ eventId, offset })` names the frame closest to an event.
  Recordings live in `artifacts`, removed with the session, unless
  `recorder.start({ outputDir })` names another directory.
- `require` and `import()` load Node.js built-ins, packages and local modules;
  relative paths resolve in `artifacts`, the executor's working directory.
- `pinnedElements({ page })` lists the elements the owner pinned in an agent
  tab with right-click, "Pin this element for the NDS agent": each is
  `globalThis.ndsPinnedElemN` in the page and `[data-nds-pin="N"]` for a
  locator. Tabs outside the agent groups cannot be pinned.

A result also carries `[PAGE ERROR]` lines for uncaught errors and
`[WARNING] New page opened` lines for new tabs of the pages an agent keeps in
`state`, so a failure or a popup is seen without asking for it.

Bot checks such as Cloudflare Turnstile, reCAPTCHA and hCaptcha, and sign-in confirmations such
as Google's "Verify it's you", are for a person to pass, so agent code never acts inside one.
`checks(page)` lists the visible checks of a page, each with its vendor and whether it is passed.
When one stays unsolved, `notifyOwner(page, reason)` shows the owner a Chrome
notification that names the agent and the site and opens the tab when clicked.
The agent continues with other work, checks the page again later and calls
`clearOwner(page)` once the check is passed; closing the tab also clears it.
Fewer checks appear when agents work in the owner's profile without request
bursts and use an official API or CLI where one exists.

Agent tabs keep working through other extensions and executor replacements:

- **Other extensions' frames.** A password manager's inline menu or a similar frame from another
  extension would make Chrome refuse to attach to a tab, or detach the debugger from it. Before
  each attach to an agent tab, the extension removes such `chrome-extension://` frames from that
  tab only; this is why it holds `scripting` with access to all sites, used on no other tab. A
  tab Chrome detaches anyway is attached again and restored at most five times in five seconds:
  agents see its execution contexts and frames gone, and Playwright's setup is replayed.
  Restricted child targets (other extensions' and browser pages) are detached and never reach
  agents.
- **Replacement executors.** A replacement starts on fresh debugger sessions of the same tabs, so
  nothing the earlier executor enabled, intercepted or exposed survives. Every client that
  enables `Runtime` on a tab is told the page's execution contexts again.

Limits: Chrome serves WebAuthn only to a focused page, so a passkey step needs
`page.bringToFront()` and visibly activates the agent tab. Chrome keeps every
extension out of `chrome://` pages and the Chrome Web Store. Browser-chrome
and OS dialogs, real authenticators' user verification, browser-wide cookies, new
browser contexts and permission grants are outside `chrome.debugger`. Chrome also
refuses an extension's `Page.setDownloadBehavior`, so a download stays in the
browser's folder; the executor loads its URL again through the tab with the page's
cookies, which gives agent code `saveAs()`, `path()`, `createReadStream()` and `failure()` for
every download except one that answered a form's POST or that a site serves only once.

## Devices

An agent can drive the browser of another of the owner's devices: `nds-browser-use --device <name>
...` (or `NDS_BROWSER_DEVICE`) runs the command with that device's own CLI over the owner's existing
ssh, so agent code runs beside that browser. Nothing listens, forwards a port or opens a tunnel;
each device keeps its own host, extension, tab groups and owner. `nds-browser-use devices` lists the
devices with their status, and `-s <project> artifact (list | <path> [--output <file>])` lists a
session's artifacts or copies one, here or from a device; only regular files inside the session's
own area are read.

Devices are named in `devices.json` beside `host.json` in the configuration directory, a regular
file only its owner can write:

```json
{ "schema": 1, "devices": { "pc": { "ssh": "pc" } } }
```

`ssh` is an ssh host or alias, reached with `BatchMode=yes`; `cli` sets the CLI's path on the device
(default `~/.local/share/nds-browser-use/bin/nds-browser-use`, where `just install` puts it); or
`command` gives an absolute program and its arguments instead. Code goes to the device on stdin,
never on a command line.

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
