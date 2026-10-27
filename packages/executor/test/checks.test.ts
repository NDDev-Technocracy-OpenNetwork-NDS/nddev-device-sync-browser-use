// Checks only a person passes, found on a page without acting in it.
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { checks } from "../agent/checks.js";

// A page with no frames, at the given address.
function at(url: string): Page {
  return { url: () => url, frames: () => [] } as unknown as Page;
}

test("a sign-in confirmation page is an unsolved check while the tab shows it", async () => {
  expect(await checks(at("https://accounts.google.com/v3/signin/challenge/dp?TL=x&cid=3"))).toEqual(
    [{ vendor: "google-signin", solved: false }],
  );
  expect(await checks(at("https://accounts.google.com/signin/v2/challenge/totp"))).toEqual([
    { vendor: "google-signin", solved: false },
  ]);
  // Choosing an account, or any other page, is no check.
  expect(await checks(at("https://accounts.google.com/v3/signin/accountchooser?x=1"))).toEqual([]);
  expect(await checks(at("https://example.test/signin/challenge/"))).toEqual([]);
});
