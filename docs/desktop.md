# Desktop browsers

On a computer, agents work in the owner's own Chrome, Chrome Beta, Chrome for Testing or Chromium,
inside the tab groups that the owner grants them. Phones are described in [mobile.md](mobile.md).

## Layout

| Path | What it is |
|---|---|
| `packages/desktop/extension` | The MV3 extension, in strict TypeScript, built to the checked-in `*.js` files |
| `src/host` | The Rust native host that Chrome starts for the extension (native messaging on stdin and stdout) |
| `packages/executor` | The Bun executor that runs agent code, shared with phones |
| `src/mobile` | The phone link, which takes the extension's place on phones |

## How it works

- **The extension** attaches `chrome.debugger` only to tabs in NDS tab groups. It relays their CDP
  traffic to the host through native messaging, and answers the host's `claim`, `open`, `close`,
  `release`, `cdp`, `tabs` and `forget` requests.
- **The host** serves agents on its private control socket and runs each session's code in an
  executor, connected to a session-scoped CDP endpoint.
- **The owner's controls** are in the extension's popup:
  - the switch, which turns agent control on or off;
  - the observation profile, Full, Standard or Off ([observability.md](observability.md)).
- **Owner actions.** The owner hands a tab to an agent by moving it into the agent's group, and
  pins an element with the context menu.

## Install

- `just install` puts the host's `bin/` and the unpacked `extension/` under one prefix, and
  registers the host for one browser.
- Loading the unpacked extension is the owner's action. After that, an install reloads it through
  the host.
- The Chrome Web Store build is the same extension without the pinned `key`.
