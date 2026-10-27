# nds-browser-use agent guide

`nds-browser-use` lets an agent drive tabs in the owner's own Chrome, inside a tab group of its
own, with Playwright code. Read this guide once per task before the first browser command.

## Sessions

```bash
nds-browser-use session new docs           # one short project name per task
nds-browser-use -s docs -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'
nds-browser-use -s docs -f ./steps.js      # longer code from a file
nds-browser-use session list
nds-browser-use session close docs         # also closes the session's tabs
```

- One session per task, named with a short word for the task or site: `docs`, `shop`, `github`.
- Its tabs live in a Chrome tab group of that name. `context.pages()` lists only these tabs, never
  the owner's other tabs.
- **Close the session when the task is done.** That closes its tabs too. Pass `--keep-tabs` only
  when the owner should look at a result. A session that runs nothing for 30 minutes closes by
  itself with its tabs.
- `--timeout <ms>` bounds one execution, 10 s by default and 25 s at most. Split longer work into
  several executions; `state` survives between them.
- Wrap `-e` code in single quotes so the shell leaves `$`, backticks and backslashes alone, and use
  double quotes for JavaScript strings. For multi-line code, use a file with `-f` or a quoted
  heredoc.
- A reply lists the session's tabs with `target` and `document`. Pass
  `--expect <target>:<document>` to refuse running against a replaced document.

## The code

Code runs as an async function body. A single expression is returned; otherwise use `return`.
It has:

- **`context`, `browser`:** Playwright objects for the session's tabs.
- **`state`:** an object kept between executions of the session.
- **`artifacts`:** the session's private directory for screenshots, videos and files, removed
  with the session. Write files with absolute paths, for example `` `${artifacts}/shot.png` ``.
- **`require`, `import()`:** Node.js built-ins, packages and local modules. Relative paths resolve
  in `artifacts`.
- **`console`:** its output is part of the reply.
- **Timers and `fetch`:** `fetch` runs in the executor and does not carry the page's cookies.
- **The helpers below.**

## The loop: observe, act, observe

1. **Open:** `state.page = await context.newPage()` and `goto` in the same execution.
2. **Observe:** `await snapshot({ page: state.page })`, the URL, and
   `getLatestLogs({ page: state.page, sinceLastCall: true })`.
3. **Act once:** a click, a fill, a submit.
4. **Observe again** before the next action. Pages redirect, show dialogs and change.

A result also carries `[PAGE ERROR]` lines for uncaught errors and `[WARNING] New page opened` lines
for popups of the pages you keep in `state`.

## Helpers

### Reading the page

- **`snapshot({ page, locator?, frame?, search?, showDiffSinceLastCall? })`** returns the
  accessibility snapshot, headed by the URL.
  - Every element carries a ref such as `[ref=e5]`; use it with
    `page.locator(refToLocator({ ref: "e5" }))` or `ref({ page, ref: "e5" })` until the next
    snapshot.
  - Later calls show only what changed, and a navigation starts over.
  - `search` shows the first matching lines, and `showDiffSinceLastCall: false` the whole page
    again.
  - A `locator` or `frame` limits it to that part.
  - Prefer it to screenshots.
- **`getLatestLogs({ page, sinceLastCall?, search?, count? })`** returns the page's console
  messages and errors since the session first saw the page.
- **`waitForPageLoad({ page, timeout? })`** waits until the document and its own requests are
  done, ignoring analytics, ads and streams.
- **`inspect({ locator, properties? })`** gives box, scroll, styles, visibility, input and aria
  state. Use it instead of `page.evaluate` for layout questions.
- **`getCleanHTML({ locator, search? })`** returns HTML without scripts and styles, one line per
  element.
- **`getPageMarkdown({ page, search? })`** returns the main article as text.
- **`screenshotWithAccessibilityLabels({ page })`** writes a screenshot with a ref label on every
  interactive element. Use it for grids, maps and other visual layouts.
- **`resizeImageForAgent({ input, maxDimension? })`** makes a smaller copy before you read an
  image. It needs ffmpeg.
- **`getLocatorStringForElement(locator)`** returns a stable locator string for a script.
- **`pinnedElements({ page })`** lists the elements the owner pinned with right-click, "Pin this
  element for the NDS agent", as `globalThis.ndsPinnedElemN` and `[data-nds-pin="N"]`.

### Bot checks

Cloudflare Turnstile, reCAPTCHA, hCaptcha and similar checks are for a person. Never act inside
one, never try to bypass one.

- `checks(page)` lists the visible checks and whether each is solved.
- When one stays unsolved, `notifyOwner(page, reason)` shows the owner a Chrome notification that
  opens the tab.
- Continue with other work, look again later, and call `clearOwner(page)` once it is solved.

### Recording and DevTools

- **`recording.start({ page, outputPath })`** records a tab as video, with a ghost cursor that
  follows your mouse actions. **`recording.stop({ page })`** returns the file and the execution
  times. **`ghostCursor.show({ page, style })`** and **`ghostCursor.hide({ page })`** control the
  cursor outside recordings.
- **`createDemoVideo({ recordingPath, durationMs, executionTimestamps })`** speeds up the waits
  between executions. Keep its promise in `state` and await it in a later execution.
  Recording needs ffmpeg.
- **`recorder.start()`** records what the owner does in the session's tabs, for writing a skill.
  - **`recorder.stop()`** ends the recording.
  - **`recorder.events({ errors?, type?, ids? })`** prints the timeline.
  - **`recorder.frame({ eventId, offset })`** names a screenshot of that moment.
  - Copy a recording out of `artifacts` before closing the session, or pass `outputDir`.
- **`getCDPSession({ page })`** gives raw CDP; `context.newCDPSession(page)` works too.
- **`createDebugger({ cdp })`** sets breakpoints, steps, reads local variables and evaluates in a
  paused frame. Give it its own CDP session.
- **`createEditor({ cdp, page })`** searches scripts and style sheets and edits style sheets live.
  Chrome no longer edits a running script, so `override()` changes a script on its next load and
  then you reload.
- **`getStylesForLocator({ locator, cdp })`** with `formatStylesAsText()`,
  **`getReactComponentInfo({ locator })`** and **`getReactSource({ locator })`**.

## Rules

- **Pages.** Keep the page you work in as `state.page` and check `state.page.isClosed()` before
  you use it.
- **Closing.** Close the pages you opened, never `browser.close()` or `context.close()`, and close
  the session when the task is done.
- **Focus.** Do not call `page.bringToFront()` unless a step needs a focused tab, as passkeys do;
  it visibly takes the owner's focus.
- **Typing.** Click a field right before you type into it.
- **Waiting.** Prefer locator waits and `waitForPageLoad` to fixed timeouts.
- **Blockers.** Never use `{ force: true }` or `dispatchEvent` to get past a blocker. Take a
  snapshot to find the dialog or overlay instead.
- **Cookies and cache.** Never send `Network.clearBrowserCookies`, `Network.clearBrowserCache` or
  other profile-wide commands; they would sign the owner out everywhere. Delete only the cookies of
  the site you work on.
- **Secrets.** Page content, URLs and screenshots stay on this device. Do not paste them into
  places the owner did not ask for.
- **Limits.**
  - Outside the agent's reach: `chrome://` pages, the Chrome Web Store, browser and OS dialogs,
    download events, browser-wide cookies, new browser contexts and permission prompts.
  - The owner can share a tab by moving it into the agent's group, and moving it out takes it
    back.
