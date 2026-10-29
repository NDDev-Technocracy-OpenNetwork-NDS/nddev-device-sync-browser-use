# nds-browser-use agent guide

`nds-browser-use` lets an agent drive tabs in the owner's own Chrome with Playwright code. The
agent's tabs live in a tab group of their own. Read this guide once per task, before the first
browser command.

## Sessions

```bash
nds-browser-use session new docs           # one short project name per task
nds-browser-use -s docs -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'
nds-browser-use -s docs -f ./steps.js      # longer code from a file
nds-browser-use session list
nds-browser-use session close docs         # also closes the session's tabs
```

- **One session per task.** Name it with a short word for the task or site, such as `docs`,
  `shop` or `github`. Its tabs live in a Chrome tab group of that name. `context.pages()` lists
  only these tabs, never the owner's other tabs.
- **Close the session when the task is done.** That closes its tabs too.
  - Pass `--keep-tabs` only when the owner should look at a result.
  - A session that runs nothing for 30 minutes closes by itself, with its tabs.
- **Quoting.** Wrap `-e` code in single quotes, so the shell leaves `$`, backticks and backslashes
  alone, and use double quotes for JavaScript strings. For multi-line code, use a file with `-f`
  or a quoted heredoc:

  ```bash
  nds-browser-use -s docs -f /dev/stdin <<'EOF'
  const rows = await state.page.locator("table tr").allTextContents();
  console.log(rows.join("\n"));
  EOF
  ```

### Replies

A reply is plain text on stdout, in this order:

- `[WARNING]` and `[PAGE ERROR]` lines about pages held in `state`: new tabs, closed pages and
  uncaught errors;
- `Console output:`, with one `[log]`, `[warn]` or `[error]` line per `console` call;
- `[return value] ...`, when the code returned something. Playwright objects print as short tags
  such as `<Page url>`. The Response that `goto` returns is not printed.

Other cases:

- A run with nothing to show says `Code executed successfully (no output)`.
- Output is cut at 10000 characters; narrow it with `search` or a `locator` instead.
- A failed script prints the same text with `Error: ...` on stderr and exits 1.
- A refusal by the host prints `Error (code): message` and exits 2.
- `executor_unavailable` means the session's executor ended, for example when it was updated.
  Its `state` is gone and the tabs stay; run again, and a new executor starts with them.
- `--json` prints the full answer instead, including each tab's `target` and `document`.
- `--expect <target>:<document>` refuses to run against a replaced document.

### Time limits

`--timeout <ms>` bounds one execution: 10 s by default, 25 s at most. Split longer work into
several executions; `state` survives between them.

- **Playwright's own waits** (clicks, `goto`, locators) end before that deadline, so a stuck action
  fails with Playwright's reason, such as `element is not visible` or `no element matched the
  locator`.
- **A script still running at the deadline is aborted**, and the session keeps its state and its
  console output so far.
  - Its later Playwright calls throw, also from callbacks it registered, and `signal` is aborted
    for its own timers.
  - Its event listeners, routes and locator handlers are removed, so pages behave as without
    them. Callbacks of scripts that ended on their own keep working.
  - An action already sent may still complete, so look at the page before you retry.
  - The failure reads `aborted`, and the exit code is 1.
- **A script that blocks the executor**, such as `while (true) {}`, cannot be aborted. It is
  stopped, its state is lost, and the refusal reads `timeout` with exit code 2.

## Devices

Tabs can also run in the browser of another of the owner's devices, near its network and region,
or to spare this one's resources.

- `nds-browser-use devices` lists the configured devices and their status.
- `--device <name>` before a command, or `NDS_BROWSER_DEVICE=<name>`, runs it there:
  `nds-browser-use --device pc session new docs`, then `nds-browser-use --device pc -s docs -e '...'`.
  The code runs on that device, beside its browser, and replies read the same.
- Artifacts stay on the device. `nds-browser-use --device pc -s docs artifact list` lists them, and
  `... artifact shot.png --output ./shot.png` copies one here.
- Each device has its own sessions, tabs and owner. A device that is off or unreachable answers
  `Error (device_unreachable)`; ask the owner rather than retrying in a loop.

## Phones

When the owner serves the browser of an Android phone, tabs can run there too.

- `nds-browser-use --phone <serial>` before a command, or `NDS_BROWSER_PHONE=<serial>`, uses that
  phone's browser: `nds-browser-use --phone R58M12345AB session new shop`.
- `nds-browser-use phones` lists the phones and their browsers.
- You see only the tabs you open there, with the phone's viewport, user agent and touch input.
- `Error (unavailable)` means the owner is not serving that phone. Ask the owner, and never
  start `phone serve` or change the phone's settings yourself.
- In a WebView app, `context.newPage()` fails: such apps cannot open tabs.

## The code

Code runs as an async function body. A single expression is returned; otherwise use `return`.
It has:

- **`context`, `browser`:** Playwright objects for the session's tabs.
- **`state`:** an object kept between executions of the session.
- **`signal`:** this script's AbortSignal, aborted when its execution reaches the deadline.
- **`artifacts`:** the session's private directory for screenshots, videos and files, removed
  with the session. Write files with absolute paths, for example `` `${artifacts}/shot.png` ``.
- **`require`, `import()`, `importModule()`:** Node.js built-ins, packages and local modules.
  Relative paths resolve in `artifacts`.
- **`console`:** its output is part of the reply.
- **`process`:** the executor's process. `cwd()` is `artifacts`; `exit`, `abort` and `chdir` are
  refused, since the session owns the process.
- **Timers and `fetch`:** `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`; an
  interval of an aborted script stops with it. `fetch` runs in the executor and does not carry the page's
  cookies. `Buffer`, `crypto` and `AbortSignal` are Node.js's.
- **The helpers below.**

## The loop: observe, act, observe

Every interaction follows observe, act, observe. Never chain several actions blindly.

1. **Open:** `state.page = await context.newPage()` and `goto` in the same execution.
2. **Observe:** the URL, `await snapshot({ page: state.page })` and
   `getLatestLogs({ page: state.page, sinceLastCall: true })`. Always print the URL; pages
   redirect.
3. **Act once:** a click, a fill or a submit, with a locator from the last snapshot.
4. **Observe again** before the next action. Pages redirect, show dialogs and change. If nothing
   changed, try `waitForPageLoad({ page: state.page, timeout: 3000 })`, or you clicked the wrong
   element.

```js
// Execution 1: open and observe.
state.page = await context.newPage();
await state.page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(state.page.url());
console.log(await snapshot({ page: state.page, locator: state.page.locator("main") }));
```

```js
// Execution 2: act, then observe what changed.
await state.page.locator('role=button[name="Sign in"i]').click();
console.log(state.page.url());
console.log(await snapshot({ page: state.page }));
console.log(getLatestLogs({ page: state.page, sinceLastCall: true }));
```

## Helpers

### Reading the page

- **`snapshot({ page, locator?, frame?, search?, showDiffSinceLastCall?, interactiveOnly? })`**
  returns the page's accessibility tree, headed by the URL. Unnamed wrappers are left out, and
  every interactive line ends with a Playwright locator, for example
  `- button "Save" [id="save"]` or `- role=link[name="Docs"i]`. `accessibilitySnapshot` is the same helper.
  - **Use the locator as it is:** `state.page.locator('[id="save"]').click()`. Never invent a
    selector the snapshot does not show. A `>> nth=N` suffix tells equal locators apart; it is
    positional and holds only for that snapshot, so before a destructive action scope to a unique
    parent such as a dialog, a row or a form instead.
  - Visible text can differ from the DOM's through CSS, such as `text-transform`; match names
    case-insensitively.
  - Later calls show only what changed, when that is shorter; "No changes since last call" means
    nothing did. A navigation starts over.
  - `search` shows the first ten matching lines with five lines around each;
    `showDiffSinceLastCall: false` shows the whole tree again.
  - A `locator` (a dialog, a form, `main`) or a `frame` limits it to that part and saves most of
    the output. Its locators are relative to that part: `part.locator(...)`, `frame.locator(...)`.
    `interactiveOnly: true` keeps only controls and the labels and landmarks around them.
  - Refs such as `[ref=e5]` appear in screenshot labels and in the snapshot of a frame of another
    process. `ref({ page, ref: "e5" })` reaches that element through its frame, and
    `refToLocator({ ref: "e5", page })` gives its selector, until the next labeled screenshot or
    such frame snapshot.
  - Prefer it to screenshots.
- **`getLatestLogs({ page, sinceLastCall?, search?, count? })`** returns the page's console
  messages and errors since the session first saw the page. The first `sinceLastCall` call
  returns everything so far. Logs survive navigation, so errors of the previous load stay visible.
  **`clearAllLogs()`** forgets the logs of every page.
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
- **`inspectPinnedElement(pageUrl, expression)`** gives the outer HTML and React component of a
  pinned element, such as `inspectPinnedElement(url, "globalThis.ndsPinnedElem1")`, and makes its
  tab `state.page`.

### Bot checks and sign-in confirmations

CAPTCHAs (Cloudflare Turnstile, reCAPTCHA, hCaptcha) and sign-in confirmations, such as Google's
"Verify it's you" on a phone, are for a person. Never act inside one, and never try to bypass one.

- `checks(page)` lists the visible checks, and whether each is solved, as
  `{ vendor, solved }`. Vendors include `cloudflare`, `recaptcha`, `hcaptcha` and
  `google-signin`.
- When one stays unsolved, `notifyOwner(page, reason)` shows the owner a Chrome notification that
  opens the tab. Write the reason the way a person reads it, for example "Confirm the sign-in on
  your phone and choose 85".
- Continue with other work, look again later, and call `clearOwner(page)` once it is solved.

Fewer checks appear when you work without request bursts and use an official API or CLI where
one exists.

### Recording and DevTools

- **`state.video = await recording.start({ page, outputPath })`** records a tab as video, with a
  ghost cursor that follows your mouse actions; keep the handle in `state`.
  - **`await state.video.stop()`** returns the file and the execution times;
    `recording.stop({ page })` does the same by page. **`cancel()`** keeps no file.
  - **`setPage(otherPage)`** films another tab from now on.
  - `clock: "manual"` films only **`await state.video.wait(ms)`**, so your thinking stays out.
  - `audio: true` adds the page's sound.
  - `aspectRatio: { width: 16, height: 9 }` fits the viewport while recording and restores it.
  - `.mp4`, `.mov`, `.mkv` or `.webm`. The file appears only when it is complete.
- **`ghostCursor.show({ page, style })`** and **`ghostCursor.hide({ page })`** control the cursor
  outside recordings.
- **`createDemoVideo({ recordingPath, durationMs, executionTimestamps })`** speeds up the waits
  between executions. Keep its promise in `state` and await it in a later execution.
  Recording needs ffmpeg.
- **`recorder.start()`** records what the owner does in the session's tabs, for writing a skill,
  with Playwright's codegen engine: each action carries the locator and the code codegen would
  write. It needs the full observation profile.
  - **`recorder.stop()`** ends the recording.
  - **`await recorder.events({ errors?, type?, ids?, exclude?, full? })`**, or
    `nds-browser-use -s <project> recorder events`, gives the timeline as JSON lines: the person's
    actions (`person-action`), live-region messages (`toast`) and what the pages did meanwhile.
    Each record's `seq` is its id.
  - **`await recorder.frame({ eventId, offset })`**, or `recorder frame <id> --offset 1000`, names
    the screenshot of that moment; an offset of 1000 shows the result of a click.
  - A value typed into a password, one-time-code or card field is never kept.
  - Copy frames out of `artifacts` before closing the session, or pass `outputDir`.
- **`getCDPSession({ page })`** gives raw CDP; `context.newCDPSession(page)` works too.
- **`createDebugger({ cdp })`** sets breakpoints, steps, reads local variables and evaluates in a
  paused frame. Give it its own CDP session.
- **`createEditor({ cdp, page })`** searches scripts and style sheets and edits style sheets live.
  Chrome no longer edits a running script, so `override()` changes a script on its next load and
  then you reload.
- **`getStylesForLocator({ locator, cdp })`** with `formatStylesAsText()`,
  **`getReactComponentInfo({ locator })`** and **`getReactSource({ locator })`**.

## Selectors

- **On an unknown site,** take the locator from the snapshot.
- **On a site whose source you know,** prefer these, in this order:
  1. a test id, such as `[data-testid="submit"]`;
  2. a role and name, such as `getByRole("button", { name: "Save" })`;
  3. text or a label, such as `getByText("Sign in")` or `getByLabel("Email")`;
  4. semantic attributes, such as `input[name="email"]`.
- **Avoid** classes, generated ids and long CSS paths; they change.
- **Narrow a locator** with `filter`:
  `state.page.locator("tr").filter({ hasText: "Jane" }).getByRole("button")`.
- **Several matches** throw a strict mode error that lists every match with a locator of its
  own (`aka getByRole(...)`); use one of those, or scope to a unique parent. Do not guess with
  `.first()` or `.nth(n)`: the position changes with the page.

## Pages and tabs

- **Keep your page in `state`.** Keep the page you work in as `state.page`, and check
  `state.page.isClosed()` before you use it. A closed page held in `state` is reported with a
  `[WARNING]`.
- **New tabs.** A link or `window.open` from your page opens a tab in your session, reported as
  `[WARNING] New page opened ... it is context.pages()[N]`. Wait for it with
  `context.waitForEvent("page")` around the click that opens it.
- **The owner's tabs.** The owner can share a tab by moving it into your group; it then appears
  in `context.pages()`. Moving it out takes it back.
- **Closing.** Close the pages you opened. Never call `browser.close()` or `context.close()`.

## Navigation

- **Waiting for a load.** `goto(url, { waitUntil: "domcontentloaded" })` returns early; follow it
  with `waitForPageLoad` or a locator wait for the element you need. Never wait for the `load`
  event after the fact; it may already have fired.
- **Single-page apps.** These change the URL without a load; wait for an element of the new view,
  or use `waitForURL`.
- **Redirects and sign-in pages.** Print `state.page.url()` after every navigation.

## Common patterns

- **Forms.** Click the field, then `fill` it; `fill` replaces the value. `keyboard.type` does not
  turn `\n` into new lines, so press `Enter` between lines. Check the result with a snapshot
  search before you submit.
- **Lists and tables.** Read them with `allTextContents()` or `getCleanHTML` on their locator
  instead of a full snapshot. Page through with the site's own next button, observing each page.
- **Frames.** `state.page.frameLocator("iframe#payment").getByRole("button")` acts inside a frame;
  `snapshot({ frame })` reads one.
- **Dialogs.** Before the action that opens an alert, confirm or prompt, set
  `state.page.once("dialog", (dialog) => dialog.accept())`.
- **Uploads.** Use `setInputFiles(path)` on the file input. Clipboard paste can fail silently.
- **Downloads.** Take the download from `Promise.all([state.page.waitForEvent("download"),
  state.page.click(...)])`, then keep it with
  `await download.saveAs(artifacts + "/" + download.suggestedFilename())`. `path()`,
  `createReadStream()` and `failure()` work too, also after the page closed. The file is the one the
  browser saved, kept in the session, so a form's POST, a link that works once and a `blob:` all
  work, and the owner's download folder keeps no copy. A file that opens in a new tab is reported on
  the tab that opened it.
- **Before a destructive action,** such as delete, send or pay, confirm the target with a snapshot
  or a labelled screenshot.

## Performance

- **Web vitals.** Paints and layout shifts come from the page's own buffered entries:
  ```js
  await state.page.evaluate(() => new Promise((done) => {
    const vitals = { paints: {}, cls: 0 };
    new PerformanceObserver((list) => { for (const e of list.getEntries()) vitals.paints[e.name] = e.startTime; })
      .observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) vitals.cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
    setTimeout(() => done(vitals), 500);
  }));
  ```
- **Counters.** `const cdp = await getCDPSession({ page: state.page }); await cdp.send("Performance.enable");`
  then `(await cdp.send("Performance.getMetrics")).metrics` gives script, layout and task time, heap
  size and node counts.
- **Slow devices.** `Emulation.setCPUThrottlingRate({ rate: 4 })` and
  `Network.emulateNetworkConditions` slow only the agent tab; reset both (`rate: 1`, `offline:
  false, latency: 0, downloadThroughput: -1, uploadThroughput: -1`) before you finish.
- **Timing your own steps.** Chrome gives extensions no `Profiler` domain, so there is no CPU
  profile. Wrap the work in `performance.mark()` and `performance.measure()` in the page, and
  compare `ScriptDuration` and `TaskDuration` of `Performance.getMetrics` before and after.

## Activity

In the owner's full observation profile, everything agents do in agent tabs is kept in an activity
journal: each execution, the Playwright actions with their locators and values, navigations, the
page's requests with their bodies, console errors and warnings, page errors, dialogs and downloads.
Secrets are removed and repeats are folded. Read it instead of re-running steps to find out what
happened:

```bash
nds-browser-use -s <project> activity                 # the latest executor's timeline, thin
nds-browser-use -s <project> activity --errors        # failed requests, actions, console and page errors
nds-browser-use -s <project> activity --type network --grep /api/ --full
nds-browser-use -s <project> activity body <sha256>    # a request's stored body
```

`--all` reads the week the journal keeps, `--exec <id>` one execution's records and `--last <n>`
the newest n. The owner can switch observation to standard or off in the extension's popup; then
the journal and the recorder collect nothing.

## Network

- **Watching requests.** Use `state.page.on("response", ...)` or
  `state.page.waitForResponse((response) => response.url().includes("/api/"))`. Remove only the
  listeners you added; never call `removeAllListeners()`.
- **Interception.** Use `state.page.route("**/api/items", (route) => route.fulfill({ json: [] }))`.
  `route.fetch()` needs browser-wide cookies, which agent tabs do not reach, so fetch inside the
  handler with `fetch` and fulfill from its answer.
- **Response bodies.** Read them with `response.json()` or `response.text()`.

## Low-level input

Use these only when locators cannot express the action.

- **Mouse:** `state.page.mouse.click(x, y)`, `mouse.move`, `mouse.down` and `mouse.up`, with
  coordinates from `inspect` or a labelled screenshot.
- **Scrolling:** `locator.scrollIntoViewIfNeeded()`, or `state.page.mouse.wheel(0, 600)`.
- **Dragging:** `source.dragTo(target)`.
- **Keyboard:** `keyboard.press("Control+A")` and `keyboard.type(text)` go to the focused element;
  click the field first.

## Screenshots

- **Snapshot first.** Take a snapshot before a screenshot; use a screenshot only for visual or
  spatial questions.
- **Absolute paths.** Write to an absolute path in `artifacts`.
- **Hiding your own marks.** Pass `style: "::-webkit-scrollbar { display: none }"` to
  `page.screenshot` to hide scrollbars.
- **Reading a screenshot.** Make a smaller copy with `resizeImageForAgent` first.

## Rules

- **Focus.** Do not call `page.bringToFront()` unless a step needs a focused tab, as passkeys do;
  it visibly takes the owner's focus.
- **Waiting.** Prefer locator waits and `waitForPageLoad` to fixed timeouts. A short fixed wait of
  1 to 2 s is fine for animations.
- **Blockers.** Never use `{ force: true }` or `dispatchEvent` to get past a blocker. Take a
  snapshot to find the dialog or overlay instead.
- **Page evaluation.** Keep `page.evaluate` for page state an accessibility tree cannot show, such
  as `window.__CONFIG__`, or for small changes such as `localStorage.clear()`.
- **Cookies and cache.** Never send `Network.clearBrowserCookies`, `Network.clearBrowserCache` or
  other profile-wide commands; they would sign the owner out everywhere. Delete only the cookies of
  the site you work on.
- **Secrets.** Page content, URLs and screenshots stay on this device. Do not paste them into
  places the owner did not ask for.
- **Limits.** Outside the agent's reach: `chrome://` pages, the Chrome Web Store, other
  extensions' pages, browser and OS dialogs, browser-wide cookies, new browser contexts and
  permission prompts.
