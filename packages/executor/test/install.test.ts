// `just install` stages the executor package whole, so every module the executor imports is
// installed with it, and its dependencies are files of the install itself. The recipe is a Unix
// one; Windows installs through the CLI.
import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
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

// Bun's isolated linker links packages into its global cache by absolute path. An install made
// that way breaks once that cache is cleaned, and on every other device it is copied to.
test.skipIf(process.platform === "win32")(
  "the installed dependencies stay inside the install",
  () => {
    const recipe = readFileSync(join(repository, "justfile"), "utf8");
    const install = /\(cd "\$stage" && bun (install [^)]*)\)/.exec(recipe)?.[1];
    expect(install).toBeDefined();
    const stage = mkdtempSync(join(tmpdir(), "nds-stage-"));
    try {
      for (const file of ["package.json", "bun.lock"]) {
        copyFileSync(join(repository, file), join(stage, file));
      }
      const installed = Bun.spawnSync(["sh", "-c", `"${process.execPath}" ${install}`], {
        cwd: stage,
      });
      expect(installed.exitCode).toBe(0);
      const root = realpathSync(stage);
      const outside: string[] = [];
      const walk = (directory: string): void => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          const entry = lstatSync(path);
          if (entry.isSymbolicLink()) {
            const target = existsSync(path) ? realpathSync(path) : "";
            if (!target.startsWith(`${root}/`)) outside.push(path.slice(stage.length));
          } else if (entry.isDirectory()) {
            walk(path);
          }
        }
      };
      walk(join(stage, "node_modules"));
      expect(outside).toEqual([]);
      expect(existsSync(join(stage, "node_modules/playwright-core/package.json"))).toBe(true);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
