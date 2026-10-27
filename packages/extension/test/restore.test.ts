// The rules that restore an agent tab's debugger session after Chrome detached it.
import { expect, test } from "bun:test";
import {
  MAX_REATTACHES,
  MAX_SETUP_BYTES,
  MAX_SETUP_COMMANDS,
  REATTACH_WINDOW_MS,
  Restore,
  restricted,
} from "../src/restore.js";

function replayed(restore: Restore, tab: number) {
  const sent: string[] = [];
  return restore
    .replay(tab, async (method) => {
      sent.push(method);
      return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "chrome-2" } : {};
    })
    .then((failed) => ({ sent, failed }));
}

test("setup replays in the order agents gave it, without what they undid", async () => {
  const restore = new Restore();
  restore.startSession(1);
  for (const method of [
    "Page.enable",
    "Network.enable",
    "Runtime.enable",
    "Network.disable",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.clearDeviceMetricsOverride",
    "Emulation.setEmulatedMedia",
    "Runtime.evaluate",
    "Page.enable",
  ])
    restore.record(1, method, {}, {});
  restore.record(1, "Runtime.addBinding", { name: "kept" }, {});
  restore.record(1, "Runtime.addBinding", { name: "gone" }, {});
  restore.record(1, "Runtime.removeBinding", { name: "gone" }, {});
  expect((await replayed(restore, 1)).sent).toEqual([
    "Runtime.enable",
    "Emulation.setEmulatedMedia",
    "Page.enable",
    "Runtime.addBinding",
  ]);
});

test("init scripts keep a stable identifier across reattaches", async () => {
  const restore = new Restore();
  restore.startSession(1);
  const given = restore.record(
    1,
    "Page.addScriptToEvaluateOnNewDocument",
    { source: "1" },
    { identifier: "chrome-1" },
  ) as { identifier: string };
  expect(given.identifier).toMatch(/^nds-/);
  expect(
    restore.chromeParams(1, "Page.removeScriptToEvaluateOnNewDocument", {
      identifier: given.identifier,
    }),
  ).toEqual({ identifier: "chrome-1" });
  // After a replay, the stable identifier names the script's new Chrome identifier.
  await replayed(restore, 1);
  expect(
    restore.chromeParams(1, "Page.removeScriptToEvaluateOnNewDocument", {
      identifier: given.identifier,
    }),
  ).toEqual({ identifier: "chrome-2" });
  restore.record(
    1,
    "Page.removeScriptToEvaluateOnNewDocument",
    { identifier: given.identifier },
    {},
  );
  expect((await replayed(restore, 1)).sent).toEqual([]);
});

test("a rejected replay command is reported and the rest still runs", async () => {
  const restore = new Restore();
  restore.startSession(1);
  restore.record(1, "Page.enable", {}, {});
  restore.record(1, "Network.setCacheDisabled", { cacheDisabled: true }, {});
  const sent: string[] = [];
  const failed = await restore.replay(1, async (method) => {
    sent.push(method);
    if (method === "Page.enable") throw new Error("refused");
    return {};
  });
  expect(failed).toEqual(["Page.enable"]);
  expect(sent).toEqual(["Page.enable", "Network.setCacheDisabled"]);
});

test("frames and child sessions gone with the old session are returned once", () => {
  const restore = new Restore();
  restore.startSession(1);
  for (const frameId of ["main", "a", "b"])
    restore.track(1, true, "Page.frameAttached", { frameId });
  // A child session reports its own frames; they are not the root's.
  restore.track(1, false, "Page.frameAttached", { frameId: "c" });
  restore.track(1, true, "Target.attachedToTarget", { sessionId: "s1" });
  restore.track(1, false, "Target.attachedToTarget", { sessionId: "s2" });
  restore.track(1, true, "Target.detachedFromTarget", { sessionId: "s1" });
  const tree = { frame: { id: "main" }, childFrames: [{ frame: { id: "a" } }] };
  expect(restore.takeRemovedFrames(1, tree)).toEqual(["b"]);
  expect(restore.takeRemovedFrames(1, tree)).toEqual([]);
  expect(restore.takeChildren(1)).toEqual(["s2"]);
  expect(restore.takeChildren(1)).toEqual([]);
});

test("reattaches are limited per window, and an ended tab never reattaches", () => {
  const restore = new Restore();
  restore.startSession(1);
  for (let attempt = 0; attempt < MAX_REATTACHES; attempt++)
    expect(restore.mayReattach(1, 1_000 + attempt)).toBe(true);
  expect(restore.mayReattach(1, 1_100)).toBe(false);
  expect(restore.mayReattach(1, 1_000 + REATTACH_WINDOW_MS + 10)).toBe(true);
  restore.endSession(1);
  expect(restore.mayReattach(1, 99_999)).toBe(false);
  // Commands of a tab without a session are never recorded.
  restore.record(1, "Page.enable", {}, {});
  restore.startSession(1);
  expect(restore.takeChildren(1)).toEqual([]);
});

test("other extensions' and browser pages are restricted, ours and the web are not", () => {
  const own = ["ours"];
  expect(restricted("chrome-extension://other/frame.html", own)).toBe(true);
  expect(restricted("chrome-extension://ours/frame.html", own)).toBe(false);
  for (const url of [
    "chrome://settings",
    "devtools://devtools/x",
    "chrome-untrusted://a",
    "edge://x",
  ])
    expect(restricted(url, own)).toBe(true);
  for (const url of ["https://example.test/", "about:blank", "", undefined])
    expect(restricted(url, own)).toBe(false);
});

test("recorded setup stays within its count and size, and removals free room", () => {
  const restore = new Restore();
  restore.startSession(1);
  const script = "Page.addScriptToEvaluateOnNewDocument";
  const fits = (tab: number, method: string, params: object) => {
    const release = restore.reserve(tab, method, params);
    if (release) release();
    return release !== false;
  };
  const ids: string[] = [];
  for (let index = 0; index < MAX_SETUP_COMMANDS; index++) {
    const release = restore.reserve(1, script, { source: `${index}` });
    expect(release).not.toBe(false);
    const given = restore.record(1, script, { source: `${index}` }, { identifier: `c${index}` });
    if (release) release();
    ids.push((given as { identifier: string }).identifier);
  }
  // Every further unique script or binding is refused; a removal always fits and frees room.
  expect(fits(1, script, { source: "one more" })).toBe(false);
  expect(fits(1, "Runtime.addBinding", { name: "more" })).toBe(false);
  expect(fits(1, "Network.disable", {})).toBe(true);
  restore.record(1, "Page.removeScriptToEvaluateOnNewDocument", { identifier: ids[0] }, {});
  expect(fits(1, "Runtime.addBinding", { name: "more" })).toBe(true);
  // One script larger than the whole budget never fits.
  restore.startSession(2);
  expect(fits(2, script, { source: "x".repeat(MAX_SETUP_BYTES) })).toBe(false);
  expect(fits(2, script, { source: "x".repeat(1000) })).toBe(true);
});

test("setup commands in flight hold their room, so only one of two fits the last slot", () => {
  const restore = new Restore();
  restore.startSession(1);
  const script = "Page.addScriptToEvaluateOnNewDocument";
  for (let index = 0; index < MAX_SETUP_COMMANDS - 1; index++) {
    const release = restore.reserve(1, script, { source: `${index}` });
    restore.record(1, script, { source: `${index}` }, { identifier: `c${index}` });
    if (release) release();
  }
  // Two commands are sent before either answers: the second finds the last slot held.
  const first = restore.reserve(1, script, { source: "a" });
  const second = restore.reserve(1, script, { source: "b" });
  expect(first).not.toBe(false);
  expect(second).toBe(false);
  restore.record(1, script, { source: "a" }, { identifier: "ca" });
  if (first) first();
  const sent: string[] = [];
  restore.replay(1, async (method) => {
    sent.push(method);
    return { identifier: "x" };
  });
  expect(sent.length).toBeLessThanOrEqual(MAX_SETUP_COMMANDS);
  // A command that failed gives its room back.
  restore.startSession(3);
  const failed = restore.reserve(3, script, { source: "lost" });
  if (failed) failed();
  expect(restore.reserve(3, script, { source: "next" })).not.toBe(false);
});

test("a replacement that waits while its key is removed never lets the setup outgrow the bound", async () => {
  const restore = new Restore();
  restore.startSession(1);
  const script = "Page.addScriptToEvaluateOnNewDocument";
  const add = (method: string, params: object, result: object = {}) => {
    const release = restore.reserve(1, method, params);
    if (!release) return false;
    restore.record(1, method, params, result);
    release();
    return true;
  };
  const recorded = async () => {
    let count = 0;
    await restore.replay(1, async () => {
      count++;
      return { identifier: "x" };
    });
    return count;
  };
  expect(add("Runtime.addBinding", { name: "B" })).toBe(true);
  for (let index = 1; index < MAX_SETUP_COMMANDS; index++)
    expect(add(script, { source: `${index}` }, { identifier: `c${index}` })).toBe(true);
  // At the bound even a replacement of the recorded binding B finds no room.
  expect(restore.reserve(1, "Runtime.addBinding", { name: "B" })).toBe(false);
  restore.record(1, "Page.removeScriptToEvaluateOnNewDocument", { identifier: "nds-2" }, {});
  // The replacement of B waits for Chrome, holding a whole entry; B is removed meanwhile, and a
  // new script takes the room that is left.
  const waiting = restore.reserve(1, "Runtime.addBinding", { name: "B" });
  expect(waiting).not.toBe(false);
  restore.record(1, "Runtime.removeBinding", { name: "B" }, {});
  expect(add(script, { source: "third" }, { identifier: "c-third" })).toBe(true);
  expect(restore.reserve(1, script, { source: "fourth" })).toBe(false);
  // The late answer records B again: the setup is exactly at its bound, never past it.
  restore.record(1, "Runtime.addBinding", { name: "B" }, {});
  if (waiting) waiting();
  expect(await recorded()).toBe(MAX_SETUP_COMMANDS);
});
