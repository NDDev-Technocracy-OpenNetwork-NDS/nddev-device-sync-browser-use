// The rules that restore an agent tab's debugger session after Chrome detached it.
import { expect, test } from "bun:test";
import { MAX_REATTACHES, REATTACH_WINDOW_MS, Restore, restricted } from "../src/restore.js";

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
