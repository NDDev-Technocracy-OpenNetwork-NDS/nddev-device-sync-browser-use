// The agent guide names every helper the executor gives agent code, so a new helper is never
// left undocumented for agents.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const executor = readFileSync(join(root, "packages", "executor", "executor.ts"), "utf8");
const guide = readFileSync(join(root, "docs", "agent-guide.md"), "utf8");

// Platform globals that need no explanation, and an alias the guide names under its main name.
const PLAIN = new Set([
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "setTimeout",
  "clearTimeout",
  "structuredClone",
  "resizeImage",
]);

test("the agent guide names every sandbox global", () => {
  const start = executor.indexOf("vm.createContext({");
  const body = executor.slice(start, executor.indexOf("\n});", start));
  const names = [...body.matchAll(/^ {2}(\w+)(?=[,:])/gm)].map(([, name]) => name ?? "");
  expect(names.length).toBeGreaterThan(20);
  const missing = names.filter((name) => !PLAIN.has(name) && !guide.includes(name));
  expect(missing).toEqual([]);
});
