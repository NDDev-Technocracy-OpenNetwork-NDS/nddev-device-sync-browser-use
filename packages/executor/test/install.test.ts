// `just install` stages the executor package whole, so every module the executor imports is
// installed with it. The recipe is a Unix one; Windows installs through the CLI.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "../../..");

test.skipIf(process.platform === "win32")(
  "the installed executor carries every module it imports",
  () => {
    const recipe = readFileSync(join(repository, "justfile"), "utf8");
    // The install recipe's executor staging, run as written into a fresh stage.
    const staging = recipe
      .split("\n")
      .find((line) => line.includes('"$stage/executor/"'))
      ?.trim()
      .split("; cp package.json")[0];
    expect(staging).toBeDefined();
    const stage = mkdtempSync(join(tmpdir(), "nds-stage-"));
    try {
      const copied = Bun.spawnSync(["sh", "-c", `mkdir -p "$stage/executor" && ${staging}`], {
        cwd: repository,
        env: { ...process.env, stage },
      });
      expect(copied.exitCode).toBe(0);
      // Bundling resolves every relative import; packages come from the installed dependencies.
      const built = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(stage, "executor/executor.ts"),
          "--target",
          "bun",
          "--packages",
          "external",
          "--outdir",
          join(stage, "out"),
        ],
        { cwd: stage },
      );
      expect(built.stderr.toString()).not.toContain("Could not resolve");
      expect(built.exitCode).toBe(0);
      expect(existsSync(join(stage, "executor/test"))).toBe(false);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
