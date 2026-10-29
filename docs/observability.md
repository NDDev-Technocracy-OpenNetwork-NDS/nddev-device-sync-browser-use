# Observability

Owner direction (2026-10-29): agents see everything that happens in agent tabs through NDS
observability, the collected data is complete but free of duplicates and noise, and one button in
the extension turns collection off completely. This document applies the
[observability standard](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync/blob/main/standarts/15-observability-and-telemetry-standard.md)
and the standard, debug and off profiles of
[ADR 0018](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync/blob/main/standarts/decisions/0018-control-and-diagnostic-profiles.md)
to browser-use.

## Profiles

The extension's popup has one switch with three positions. The host keeps the choice and every
executor follows it.

| Profile | Collected |
| --- | --- |
| **Full** (the owner's default) | Standard, plus the activity journal with content: each execution's code and result, Playwright actions with their locators and values, navigations, network requests with their redacted URLs, headers and textual bodies, console errors, warnings and failed assertions, page errors, dialogs and downloads; the recorder's network capture. |
| **Standard** | The host's lifecycle, security and outcome events, such as one per execution with its duration, outcome and error class. No URL, title, locator, value or body. |
| **Off** | Nothing new is collected or exported: no journal, no recorder, no telemetry. Records not yet written or sent are discarded. Sessions, permissions and the errors agents and the owner see keep working. |

The popup shows the profile and what it collects; `nds-browser-use status` reports the profile the
host applies. A selected profile is not proof that collection works: the journal itself is.

## Where the data goes

```text
executor (Playwright events, raw) -> NDS.activity -> host (Rust policy) -> activity journal
host (the browser's own events: dialogs) ---------------------------^          |
                                                     nds-browser-use activity <-+  (agents)
host -> NDS telemetry SDK (metadata, Standard and Full) -> local output, NDS export
```

- **Activity journal.** The executor only collects what Playwright shows it and hands raw records
  to the host over its private browser session. The host's Rust policy (`src/activity/`) removes
  secrets, leaves noise out, folds repeats, stores bodies once by hash and writes JSON lines per
  session under the host's state directory. Dialogs come from the browser's own events, because a
  Playwright listener would keep a dialog open. Retention is one week; each session and the whole
  journal have a size bound. It outlives the session's own area, so an agent can read what an
  earlier session did.
- **Telemetry.** The host's events follow the SDK's closed event schema, which has no fields for
  URLs or content. Export follows the SDK's NDS transport once a device has one.
- **Agents** read the journal with `nds-browser-use activity`. It filters by session, execution,
  type, errors only and text, and prints a thin timeline by default and full records by id.

Content in NDS central observability needs a content channel that the observability module does
not have yet, and an NDS pipeline that is deployed for the owner's devices. Both are outside this
module. Until they exist, the journal is the agents' complete view and telemetry carries only
metadata.

## What is collected, and what is not

Secrets never reach the journal:
- authorization, cookie and set-cookie headers;
- credentials and fragments in URLs;
- query, form and JSON fields whose names mark a secret (token, password, code, secret,
  signature, session, key and the like);
- values typed into password, one-time-code and payment fields;
- multipart and unstructured request bodies.

Noise is left out:
- requests to analytics and advertising hosts;
- successful static assets (images, fonts, styles, scripts, media);
- `data:`, `blob:` and extension URLs;
- successful third-party reads;
- console messages below a warning (`log`, `info`, `debug`), which agents already read in their
  execution's reply.

Failed requests are always kept.

Duplicates are folded:
- consecutive identical requests (method, URL, status) become one record with a count;
- repeated identical console messages are counted, not repeated;
- an identical body is stored once.

Every record, body and journal has a size bound. Bodies are kept for textual types only (JSON,
text, XML, form, GraphQL).
