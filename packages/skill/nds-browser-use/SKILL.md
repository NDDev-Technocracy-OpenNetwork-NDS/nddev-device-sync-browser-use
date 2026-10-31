---
name: nds-browser-use
description: Work in the owner's own browser with Playwright code through the NDS browser-use CLI. The browser is Chrome on this computer, another of the owner's devices, or Chrome on the owner's Android phone, and agent tabs stay in the agent's own tab group. Use it for any web task a plain fetch cannot do, such as JS-heavy or signed-in sites, forms, downloads, screenshots and recordings. Load it before the first nds-browser-use command.
---

# nds-browser-use

Before the first command in a session, run `nds-browser-use skill` and read all of its output. It
is the full guide: sessions, the observe-act-observe loop, helpers, time limits, devices, phones,
bot checks and rules. Do not truncate it.

```bash
nds-browser-use skill
nds-browser-use session new <project>
nds-browser-use -s <project> -e 'state.page = await context.newPage(); await state.page.goto("https://example.com"); return await snapshot({ page: state.page })'
nds-browser-use session close <project>
```

- Pick a short project name for the task; it names the agent's tab group in the owner's browser.
- Put code in single quotes, or in a file with `-f file.js`.
- `--device <name>` runs on another of the owner's computers, and `--phone <serial>` on the
  owner's phone, when the owner serves it.
- Close the session when the task is done.
- A CAPTCHA or sign-in check is the owner's. Never solve or bypass one: call `notifyOwner` and
  continue with other work.
- If `nds-browser-use status` does not answer `enabled: true`, ask the owner to open the browser
  and check the extension. Never change the owner's browser or phone settings yourself.
