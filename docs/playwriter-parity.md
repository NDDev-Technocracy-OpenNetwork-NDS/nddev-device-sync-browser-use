# Playwriter parity

nds-browser-use covers what [Playwriter](https://github.com/remorses/playwriter) gives agents in the
owner's own Chrome, under NDS rules: no vendor service, no telemetry leaving the device, no port or
tunnel. Ported code keeps Playwriter's MIT notice. This table is the checklist; each row names our
form or why it is left out.

## Agent code

| Playwriter | nds-browser-use |
| --- | --- |
| `context`, `browser`, `state`, `console`, `require`, `import()` | Same. `import()` and `require` resolve relative paths in `artifacts`. |
| `signal` | Same: the script's own AbortSignal. |
| No global `page`, with a hint | Same: a bare `page` says to keep one in `state.page`. |
| `process` (with `exit`, `chdir` refused) | Same; `cwd()` is `artifacts`. |
| `importModule` | Same name for `import()`. Playwriter limits it to an allowlist; ours loads what `import()` loads. |
| `require` with a scoped `fs` (writes only in the session's folder and the temporary folder) | Plain `require` from `artifacts`. Playwriter's scope is a guard, not a boundary, since its `import()` loads any module; agents here write where their task needs and keep files in `artifacts`. |
| Timers, `fetch`, `Buffer`, `crypto`, `AbortController`, `AbortSignal`, `structuredClone`, URL and text codecs | Same. An aborted script's intervals stop with it. |
| `snapshot`, `accessibilitySnapshot` | Same engine, ported: flattened wrappers, a locator per interactive line, diffs, search, `interactiveOnly`, parts and frames. Every locator reaches the element its line shows, also inside frames. |
| `refToLocator`, screenshot label refs | Same; refs resolve through the last view that showed them. Also `ref({ page, ref })`. |
| `getLatestLogs`, `clearAllLogs` | Same: an array of lines, empty when there are none; a search keeps five lines around each match with `---` between. Errors and warnings also name their source, unless it is another extension's console wrapper. |
| `waitForPageLoad` | Same. |
| `inspect`, `getCleanHTML`, `getPageMarkdown` | Same options. `getCleanHTML` and `getPageMarkdown` start with the page's `URL:` line, as snapshots do. |
| `screenshotWithAccessibilityLabels`, `resizeImage`, `resizeImageForAgent` | Same, with `locator` and `interactiveOnly`; images stay in `artifacts`, and the result names the image and gives the snapshot. |
| `getLocatorStringForElement` | Same. |
| `inspectPinnedElement`, right-click pinning | Same, with "Pin this element for the NDS agent" and `pinnedElements({ page })`. |
| `recording`, `ghostCursor`, `createDemoVideo` | Same engine, ported: a handle with `stop`, `cancel`, `setPage` and the manual clock's `wait(ms)`, a constant frame rate, page audio, a hardware H.264 encoder where one works, `.mp4`/`.mov`/`.mkv`/`.webm` written atomically. Better on the owner's tabs: `aspectRatio` also fits a tab without an emulated viewport and clears the override after; Playwriter leaves such a tab as it is. |
| Ghost cursor always on: every Playwright mouse action shows it, it fades after 5 s | Same: the extension moves it after each of the agent's own mouse commands, never with the owner's mouse, and hides it from screenshots; `ghostCursor.hide` turns it off until `show`. |
| `getCDPSession`, `createDebugger`, `createEditor`, `getStylesForLocator`, `formatStylesAsText`, `getReactComponentInfo`, `getReactSource` | Same. |
| Human-action recorder | Same engine: Playwright's codegen recorder gives each action its locator, code and aria snapshot, with live-region messages and frames. Better on secrets: Playwriter hides every typed value; here a value stays unless its field is a password, one-time-code or card field by what it is, and a snapshot shows field values only when they were typed into such plain fields. The timeline lives in the activity journal beside the pages' requests, and needs the full observation profile. |
| Toolbar "Record skill" button | The popup's "Record what I do" starts and stops the recorder of the agent group of the owner's tab; it reports a running execution of the agent instead of waiting for it. |
| `resetPlaywright` | Left out: a stuck script is aborted at its deadline, and an executor that cannot answer is replaced on fresh debugger sessions. |
| `stream` (live RTMP streaming) | Left out: it sends the owner's tab to an outside service. `recording` keeps video on the device. |
| `chrome` (Ghost Browser APIs) | Left out: Ghost Browser only. |
| `cloud` | Left out: a vendor service. |
| Performance examples | Same kind, in the guide and checked in e2e: buffered web vitals, `Performance.getMetrics`, CPU and network throttling, measures of the agent's own steps. Chrome gives extensions no `Profiler` domain, so neither offers a CPU profile. |
| Bot checks | Never solved or bypassed. `checks()` reports them and `notifyOwner()` hands them to the owner. |

## Results

| Playwriter | nds-browser-use |
| --- | --- |
| Plain text: warnings and page errors, `Console output:`, `[return value]`; 10000 characters | Same, with Playwright objects as tags, no internals and no control codes. |
| Timeout aborts the script and keeps state | Same; callbacks the script registered stop acting with it, and its listeners and routes are removed. |
| Playwright waits end before the deadline | Same; a stuck action fails with Playwright's reason. |

## CLI

| Playwriter | nds-browser-use |
| --- | --- |
| `session new`, `session list`, `session delete` | `session new`, `session list`, `session close [--keep-tabs]`; idle sessions close after 30 minutes. |
| `-e`, `-f`, `--timeout` | Same, plus `-f -` (stdin), `--expect <target>:<document>` and `--json`. |
| `skill` | Same: prints the agent guide. |
| `recorder start`, `recorder stop`, `recorder status`, `recorder events`, `recorder frame` | `-s <project> recorder start|stop|status`; `recorder events [ids] [--type] [--errors] [--exclude] [--full]` and `recorder frame <id> [--offset]` read the journal in Rust, also without the host. |
| `browser list`, other browsers | `devices` and `--device <name>`: another of the owner's devices runs the command beside its browser, over the owner's own ssh. |
| `session update` (rename, colour), `session reset` | Left out: a session's group is named by its project; resets happen at deadlines. |
| `--timeout` up to minutes, `PLAYWRITER_EXEC_TIMEOUT` | At most 25 s per execution, so a session never blocks long; long work keeps its promise in `state` and a later execution awaits it, as `createDemoVideo` does. |
| `session new --direct <cdp>`, `--remote <id>` (sharing a browser through a tunnel), `--browser headless` | Left out: no remote-debugging endpoint, tunnel or second browser; phones are reached through the owner's ADB server instead ([mobile.md](mobile.md)). |
| `browser start`, `browser install` (bundled Chromium) | Left out for now: agents use the owner's own Chrome. CI uses Chrome for Testing with the extension. |
| `serve restart`, `logfile` | Not needed: Chrome starts and stops the host; telemetry stays on the device. |
| MCP server, `cloud` commands | Left out by NDS policy. |

## Relay

| Playwriter | nds-browser-use |
| --- | --- |
| Runtime disable, then enable, and wait for contexts | Same. |
| Restricted child targets detached | Same. |
| Other extensions' frames removed before attach | Same, for the exact agent tab only. |
| Reattach and setup replay after Chrome's own detach | Same, at most 5 in 5 seconds. |
| Per-command deadlines, noisy network events dropped | Same. |
| Download events | Same: `waitForEvent("download")` gives the URL and suggested name. |
| Download files | Better. Chrome refuses an extension's `Page.setDownloadBehavior` in both, so Playwriter's `saveAs()` finds no file. Here the extension's `downloads` permission names the browser's file of each download an agent tab, or a tab it opened, started; the host keeps a copy in the session and removes the browser's copy and list entry. `saveAs()`, `path()`, `createReadStream()` and `failure()` answer from it, also after the page closed, for a form's POST, a one-time link, a revoked `blob:`, a frame of another site and a file that opens in a new tab (reported on the opener, under the name the browser saved it with: Chrome tells an extension the site's name only through `downloads.onDeterminingFilename`, and listening to it would make Chrome ignore the file names other extensions choose for their own downloads). A download no agent tab announced is loaded again through the tab. |
| Screenshot without own UI, scrollbars and caret | Same: the extension hides the ghost cursor, scrollbars and caret while Chrome captures, and the labels of a labelled screenshot stay. |
| Screencast shared between clients | Not shared: one recording per tab. |
| Popup windows relocated into the main window | Same: a popup window an agent tab opens, such as a sign-in window, joins the agent group as a tab of its opener's window, and keeps `window.opener`. |
| In-page toolbar: pin mode with shift-click multi-select | The context menu's "Pin this element for the NDS agent", once per element. |
| "Copy React Component Source Path" menu | Left out of the menu; agents call `getReactSource` and `getReactComponentInfo`. |
