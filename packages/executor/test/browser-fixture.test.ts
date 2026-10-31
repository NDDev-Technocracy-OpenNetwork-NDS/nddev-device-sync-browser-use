// Exercise Playwright's real argument construction with Bun as an immediately failing stand-in.
// No Chrome, browser profile data, desktop or app is started by these source-only checks.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFixture } from "../../../e2e/launch.js";

test("the fixture launch omits Playwright's implicit sandbox disable from actual arguments", async () => {
  const profile = mkdtempSync(join(tmpdir(), "nds-launch-arguments-"));
  try {
    let failure = "";
    try {
      await launchFixture(profile, {
        executablePath: process.execPath,
        headless: true,
        timeout: 5000,
        args: ["--nds-browser-fixture-argument-probe"],
      });
    } catch (error) {
      failure = String(error);
    }
    const launched = failure.split("\n").find((line) => line.includes("<launching>"));
    expect(launched).toContain("--nds-browser-fixture-argument-probe");
    expect(launched).not.toContain("--no-sandbox");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}, 15_000);

test("a fixture cannot opt out of the sandbox through its options or arguments", async () => {
  const profile = mkdtempSync(join(tmpdir(), "nds-launch-refusal-"));
  try {
    for (const options of [
      { chromiumSandbox: false },
      { args: ["--no-sandbox"] },
      { args: ["--disable-setuid-sandbox"] },
      { args: ["--disable-namespace-sandbox=true"] },
      { args: ["--disable-seccomp-filter-sandbox"] },
      { args: ["--disable-gpu-sandbox"] },
    ]) {
      await expect(
        launchFixture(profile, { executablePath: process.execPath, timeout: 5000, ...options }),
      ).rejects.toThrow("fixtures require Chromium sandbox");
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}, 15_000);
