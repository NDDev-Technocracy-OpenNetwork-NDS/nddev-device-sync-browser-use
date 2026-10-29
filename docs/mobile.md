# Phones

Agents can work in a Chromium browser on the owner's Android phone, such as Chrome, with the same
CLI, sessions, executor and helpers as on the desktop. The desktop path is described in
[desktop.md](desktop.md).

## Why phones have no extension

The desktop extension cannot run on a phone.

- **Chrome for Android** runs no extensions.
- **Edge for Android** installs extensions only from Microsoft's curated list. Its extension
  platform leaves out `debugger`, `tabGroups` and `contextMenus`, and has no native messaging
  ([supported APIs](https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/api-support)).
- **Vivaldi for Android** installs Chrome Web Store extensions, but without these APIs either.

Every Chromium browser on Android does have one way in. Once the owner turns on USB debugging, the
browser serves DevTools on an abstract unix socket for a computer the owner authorized
([Chrome remote debugging](https://developer.chrome.com/docs/devtools/remote-debugging)).

## How it works

```
agent CLI -- control.sock --+
                            host (the desktop host's code) -- framed protocol -- phone link
executor --- cdp.sock ------+                                                       |
                                    ADB server: host:transport:<serial>, localabstract:<socket>
                                                                                    |
                                                    the browser's DevTools socket on the phone
```

The phone link (`src/mobile`, Rust) stands in for the desktop extension. It speaks the
extension's framed protocol, contract 2, to an unchanged host, and answers it over the browser's
own DevTools connection.

The link reaches the socket through the ADB server's own protocol, inside the server's connection.
Nothing listens on this computer, no `adb forward` is left behind and no port is opened.

| Desktop extension | Phone link |
|---|---|
| `chrome.debugger.attach` to a tab | `Target.attachToTarget` with `flatten` |
| The tab's debugger events | Events of the tab's session |
| Frame and worker sessions | The child sessions that the tab's session reports |
| `chrome.tabs.create` | `Target.createTarget` |
| `chrome.tabs.remove` | `Target.closeTarget` |
| Popups of agent tabs join the agent group | `Target.targetCreated` with an agent tab as opener |
| The popup's switch | Running `phone serve`; Ctrl-C ends it |
| The popup's observation profile | `--observation full\|standard\|off` (full by default) |
| Chrome notification for a bot check | Android notification, cleared by a ten-year snooze |

## Owner setup

1. On the phone, turn on Developer options and, in them, USB debugging.
2. Connect the phone to this computer by USB, or pair it with wireless debugging
   (`adb pair`, then `adb connect`).
3. Accept the phone's prompt to allow USB debugging from this computer.
4. Open the browser on the phone. A browser serves DevTools only while it runs.
5. Run `nds-browser-use phones`. It lists every phone with the browsers that serve DevTools, read
   from `/proc/net/unix` and each socket's `/json/version`:

   ```json
   {"phones":[{"serial":"R58M12345AB","state":"device","model":"SM_S918B",
     "browsers":[{"socket":"chrome_devtools_remote","product":"Chrome/141.0.7390.122","package":"com.android.chrome"}]}]}
   ```

   A phone in the `unauthorized` state still waits for step 3.
6. Run `nds-browser-use phone serve <serial>` and leave it running. It runs the host for that
   phone, in its own runtime directory beside the desktop host's. It stops when the owner presses
   Ctrl-C, the browser quits or the phone goes away. Sessions close with it, as they do when
   Chrome ends on the desktop.

Without `--socket`, the link uses Chrome's socket `chrome_devtools_remote`. Otherwise it uses the
only browser the phone offers, and an app's WebView only when nothing else is there.
`--socket <name>` names another socket:
- Chromium browsers use `<name>_devtools_remote`;
- Chrome appends its process id when another browser already holds its name;
- WebView apps use `webview_devtools_remote_<pid>`.

The ADB server is the one at `ADB_SERVER_SOCKET=tcp:<host>:<port>`. Without it, the link uses
`ANDROID_ADB_SERVER_PORT` on the loopback, then port 5037. Start it with `adb start-server`.

## Agents

`--phone <serial>` before any session command, or `NDS_BROWSER_PHONE=<serial>`, talks to that
phone's host. Everything else reads as on the desktop:

```sh
nds-browser-use --phone R58M12345AB session new shop
nds-browser-use --phone R58M12345AB -s shop -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'
```

- **Tabs.** An agent sees only the tabs it opened and the pages those tabs opened. The owner's
  other tabs are never attached.
  - Closing the session closes its tabs. With `--keep-tabs` they stay open on the phone and the
    session's next life attaches them again.
- **Viewport.** Tabs have the phone's own viewport, user agent and touch input.
- **Downloads** are saved on the phone. The executor loads the file again through the tab, so
  `download.path()` and `saveAs()` work as on the desktop.
- **Bot checks.** `notifyOwner(page, reason)` posts an Android notification that names the agent
  and the site, and brings the tab to the front of the browser. `clearOwner(page)` clears the
  notification.
- **WebView apps** cannot open tabs: `context.newPage()` fails with
  `Target.createTarget: Not supported`. The link attaches only tabs that it opened.

## Security

USB debugging lets an authorized computer control the whole phone. The link uses only the
browser's DevTools socket, and only for the agent's own tabs.

Owner notifications go through the phone's shell (`cmd notification`). Their text is passed as a
single-quoted argument with control characters removed.

`phone serve` is the owner's switch. Agents never start it, never turn on USB debugging and
never authorize a computer.

Telemetry follows the desktop host's. The link adds:
- `browser.phone.connecting`;
- `browser.phone.stopped`, whose `error.type` is `owner_stopped`, `browser_closed` or
  `host_stopped`;
- `browser.phone.failed`.

## Tests

`e2e/phone.test.ts` checks the phone path in CI with a real browser:
- it starts a Chrome for Testing with a DevTools port of its own;
- a fake ADB server lists one phone, answers its shell and carries its DevTools socket to that
  browser;
- `phones`, `phone serve` and an agent session then run as they would against a phone.

The ADB client and the link also have unit tests against a fake ADB server and a fake browser
(`src/mobile`).

On the Android emulator, the link was checked against the WebView shell:
- the listing;
- the ADB transport;
- the DevTools handshake;
- a session with its executor;
- the WebView's refusal to open a tab.

It has not yet been checked against Chrome on a phone.
