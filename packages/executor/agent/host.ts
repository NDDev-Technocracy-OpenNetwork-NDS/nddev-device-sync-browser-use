// The executor's own browser-level CDP session to the host. The host answers its NDS commands
// there (a download's kept file, the owner's observation profile) and reports profile changes on
// it, so collection follows the owner's switch between executions too (docs/observability.md).
import type { Browser, CDPSession } from "playwright-core";

export type Observation = "full" | "standard" | "off";

let session: Promise<CDPSession | undefined> | undefined;
let current: Observation = "standard";
const listeners = new Set<(profile: Observation) => void>();

function parse(value: unknown): Observation {
  return value === "full" || value === "off" ? value : "standard";
}

function set(profile: Observation): void {
  if (profile === current) return;
  current = profile;
  for (const listener of listeners) listener(profile);
}

/** Opens the session once; an older host without it leaves the standard profile. */
export function connect(browser: Browser): Promise<CDPSession | undefined> {
  session ??= browser
    .newBrowserCDPSession()
    .then(async (cdp) => {
      (
        cdp as unknown as {
          on(event: string, listener: (params: { profile?: unknown }) => void): void;
        }
      ).on("NDS.observation", (params) => set(parse(params?.profile)));
      const answer = await ask<{ profile?: unknown }>(cdp, "NDS.observation", {});
      set(parse(answer?.profile));
      return cdp;
    })
    .catch(() => undefined);
  return session;
}

/** The host's answer to one NDS command, or undefined when the host has no such session. */
export async function hostCommand<T>(method: string, params: object): Promise<T | undefined> {
  const cdp = await session;
  return cdp ? ask<T>(cdp, method, params) : undefined;
}

function ask<T>(cdp: CDPSession, method: string, params: object): Promise<T | undefined> {
  const send = cdp.send.bind(cdp) as unknown as (method: string, params: object) => Promise<T>;
  return send(method, params).catch(() => undefined);
}

export function observation(): Observation {
  return current;
}

/** Calls `listener` with every later profile. */
export function onObservation(listener: (profile: Observation) => void): void {
  listeners.add(listener);
}
