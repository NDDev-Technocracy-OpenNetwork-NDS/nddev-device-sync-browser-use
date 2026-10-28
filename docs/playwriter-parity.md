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
| `process` (with `exit`, `chdir` refused) | Same; `cwd()` is `artifacts`. |
| `importModule` | Same name for `import()`. Playwriter limits it to an allowlist; ours loads what `import()` loads. |
| Timers, `fetch`, `Buffer`, `crypto`, `AbortController`, `AbortSignal`, `structuredClone`, URL and text codecs | Same. An aborted script's intervals stop with it. |
| `snapshot`, `accessibilitySnapshot` | Same engine, ported: flattened wrappers, a locator per interactive line, diffs, search, `interactiveOnly`, parts and frames. Every locator reaches the element its line shows, also inside frames. |
| `refToLocator`, screenshot label refs | Same; refs resolve through the last view that showed them. Also `ref({ page, ref })`. |
| `getLatestLogs`, `clearAllLogs` | Same. |
| `waitForPageLoad` | Same. |
| `inspect`, `getCleanHTML`, `getPageMarkdown` | Same. |
| `screenshotWithAccessibilityLabels`, `resizeImage`, `resizeImageForAgent` | Same; images stay in `artifacts`. |
| `getLocatorStringForElement` | Same. |
| `inspectPinnedElement`, right-click pinning | Same, with "Pin this element for the NDS agent" and `pinnedElements({ page })`. |
| `recording`, `ghostCursor`, `createDemoVideo` | Same. |
| `getCDPSession`, `createDebugger`, `createEditor`, `getStylesForLocator`, `formatStylesAsText`, `getReactComponentInfo`, `getReactSource` | Same. |
| Human-action recorder | `recorder` in code, and `-s <project> recorder start|stop|status` on the CLI. |
| `resetPlaywright` | Left out: a stuck script is aborted at its deadline, and an executor that cannot answer is replaced on fresh debugger sessions. |
| `stream` (live RTMP streaming) | Left out: it sends the owner's tab to an outside service. `recording` keeps video on the device. |
| `chrome` (Ghost Browser APIs) | Left out: Ghost Browser only. |
| `cloud` | Left out: a vendor service. |
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
| `recorder start`, `recorder stop`, `recorder status` | `-s <project> recorder start|stop|status`. |
| `browser list`, other browsers | `devices` and `--device <name>`: another of the owner's devices runs the command beside its browser, over the owner's own ssh. |
| `session update` (rename, colour), `session reset` | Left out: a session's group is named by its project; resets happen at deadlines. |
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
| Download events | Same: `waitForEvent("download")` gives the URL and suggested name. Chrome refuses an extension's `Page.setDownloadBehavior`, so the file keeps the browser's own folder. |
| Screencast shared between clients | Not shared: one recording per tab. |
