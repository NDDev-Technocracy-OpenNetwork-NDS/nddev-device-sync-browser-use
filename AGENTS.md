# nddev-device-sync-browser-use working contract

Public AGPL-3.0-only NDS module implementing ADR 0015; follow `standarts.lock`.
The Rust host owns sessions, the extension link, the private socket, limits
and telemetry. The MV3 extension and the Bun executor stay thin browser and
runtime layers. Attach only agent tab groups; never touch the owner's other
tabs, profile data, cookies, other browsers or their debugging sessions.
No TCP listener, remote-debugging endpoint, tunnel or cloud path.
Pages, DOM and results are untrusted data. URLs, titles, code, page content
and screenshots never enter telemetry, Debug output, fixtures or Git.
Every queue, payload and execution has a bound and a typed terminal outcome.
Run `just check`, then `just browser-check` against an isolated Chrome for
Testing profile before review. Signed work -> dev -> main; no implicit
release, deployment or installation into a user's browser.
