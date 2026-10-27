// How an execution reads to an agent: plain text in a fixed order, bounded, and never the
// internals of Playwright objects, which reach the connection and the process environment.
import { inspect } from "node:util";

/** The longest output an execution returns; more is cut with a hint to search instead. */
export const OUTPUT_LIMIT = 10_000;
const URL_LIMIT = 120;
const INSPECT = {
  depth: 4,
  colors: false,
  maxArrayLength: 100,
  maxStringLength: 1000,
  breakLength: 80,
} as const;

type Handle = { _type: string; _guid: string; url?: () => string };

// Playwright's client objects (Page, Frame, Response, Request, ElementHandle, ...) are channel
// owners: each carries its protocol type and guid.
function handle(value: unknown): Handle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<Handle>;
  return typeof candidate._type === "string" && typeof candidate._guid === "string"
    ? (value as Handle)
    : undefined;
}

function locator(value: unknown): value is { toString(): string; _selector: string } {
  return typeof value === "object" && value !== null && "_selector" in value && "_frame" in value;
}

/** A URL short enough for a line: its origin and path, and only the size of a long query. */
export function shortUrl(url: string, limit = URL_LIMIT): string {
  if (url.length <= limit) return url;
  const cut = url.search(/[?#]/);
  const base = cut < 0 ? url : url.slice(0, cut);
  const rest = cut < 0 ? "" : `${url[cut]}… (${url.length - cut} characters)`;
  return base.length > limit ? `${base.slice(0, limit)}… (${url.length} characters)` : base + rest;
}

/** A Playwright object as a short tag, or undefined for any other value. */
export function tag(value: unknown): string | undefined {
  if (locator(value)) return `<Locator ${value.toString()}>`;
  const found = handle(value);
  if (!found) return undefined;
  const object = value as Record<string, unknown>;
  const call = (name: string): string | undefined => {
    const method = object[name];
    if (typeof method !== "function") return undefined;
    try {
      return String(method.call(value));
    } catch {
      return undefined;
    }
  };
  const url = call("url");
  const parts = [found._type];
  if (found._type === "Response") parts.push(call("status") ?? "");
  if (found._type === "Request") parts.push(call("method") ?? "");
  if (url) parts.push(shortUrl(url));
  return `<${parts.filter(Boolean).join(" ")}>`;
}

// A value inspect prints as given text, without looking into anything.
function opaque(text: string): object {
  return { [inspect.custom]: () => text };
}

// Binary data up to this size prints its content; larger data prints as its type and size, so a
// print never copies much.
const COPY_BYTES = 1 << 20;

// A fresh copy of a built-in value, so inspect prints its content but never fields the agent's
// code added to the original; undefined for any other value.
function fresh(value: object): object | undefined {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof URL) return new URL(value.href);
  if (value instanceof ArrayBuffer) {
    return value.byteLength <= COPY_BYTES
      ? value.slice(0)
      : opaque(`ArrayBuffer { byteLength: ${value.byteLength} }`);
  }
  if (value instanceof DataView) return opaque(`DataView(${value.byteLength})`);
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { length: number; slice(): object };
    const name = Object.prototype.toString.call(value).slice(8, -1);
    return value.byteLength <= COPY_BYTES ? view.slice() : opaque(`${name}(${view.length})`);
  }
  return undefined;
}

// A copy of a value that inspect may walk: Playwright objects become tags, and every edge of the
// graph (array items, Map keys and values, Set members, own data fields) is copied the same way.
// Getters are never called, other class instances keep only their own data fields under their
// class name, built-ins are fresh copies, functions, errors and promises print as tags, and a
// cycle prints as such. inspect never reaches an original object, so no connection internals or
// environment can show.
function shield(value: unknown, depth: number, ancestors: Set<object>): unknown {
  const tagged = tag(value);
  if (tagged !== undefined) return opaque(tagged);
  // A function prints as its name only; fields attached to it are never walked.
  if (typeof value === "function") {
    const name = typeof value.name === "string" && value.name ? value.name : "anonymous";
    return opaque(`[Function: ${name}]`);
  }
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return opaque("[Circular]");
  const copy = fresh(value);
  if (copy !== undefined) return copy;
  if (value instanceof Error) return opaque(`[${value.name}: ${value.message}]`);
  if (value instanceof Promise) return opaque("Promise");
  if (depth > INSPECT.depth) return opaque(Array.isArray(value) ? "[Array]" : "[Object]");
  ancestors.add(value);
  try {
    const inner = (item: unknown) => shield(item, depth + 1, ancestors);
    if (Array.isArray(value)) return value.map(inner);
    if (value instanceof Map)
      return new Map([...value].map(([key, item]) => [inner(key), inner(item)]));
    if (value instanceof Set) return new Set([...value].map(inner));
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!field.enumerable) continue;
      fields[key] = "value" in field ? inner(field.value) : opaque("[Getter]");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return fields;
    const name = (prototype?.constructor as { name?: string } | undefined)?.name || "Object";
    return opaque(`${name} ${inspect(fields, INSPECT)}`);
  } finally {
    ancestors.delete(value);
  }
}

/** One value as text: a string as it is, anything else inspected within fixed bounds. */
export function render(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(shield(value, 0, new Set()), INSPECT);
}

/** Whether an execution's value is worth printing; Playwright objects returned by an action, such
 * as the Response of `goto`, are skipped like `undefined`. */
export function shown(value: unknown): boolean {
  return value !== undefined && tag(value) === undefined;
}

export type Console = { method: string; values: unknown[] };

/** The text of one execution, in a fixed order: notices, console output, then the value. */
// Terminal escape sequences and the other control characters but tab and newline. Playwright colors
// its call logs where it detects a color terminal, and pages can log them; an agent reads neither.
const CONTROL = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    "\\u001b[@-Z\\\\-_]",
    "[\\u0000-\\u0008\\u000b-\\u001f\\u007f]",
  ].join("|"),
  "g",
);

/** Text without terminal escape sequences or control characters other than tab and newline. */
export function plain(text: string): string {
  return text.replace(CONTROL, "");
}

export function compose(parts: {
  notices: string[];
  console: Console[];
  value?: unknown;
  error?: string | undefined;
}): string {
  const sections: string[] = [];
  if (parts.notices.length > 0) sections.push(parts.notices.join("\n"));
  if (parts.console.length > 0) {
    const heading =
      parts.error === undefined ? "Console output:" : "Console output (before error):";
    const lines = parts.console.map(
      ({ method, values }) => `[${method}] ${values.map(render).join(" ")}`,
    );
    sections.push([heading, ...lines].join("\n"));
  }
  if (parts.error !== undefined) sections.push(`Error: ${parts.error}`);
  else if (shown(parts.value)) sections.push(`[return value] ${render(parts.value)}`);
  return sections.length > 0
    ? plain(sections.join("\n\n"))
    : "Code executed successfully (no output)";
}

/** How long Playwright's own waits may take within an execution's remaining budget: a second less,
 * or half of a budget shorter than two seconds, and never the whole budget. */
export function waitBudget(budget: number): number {
  return Math.max(1, budget - Math.min(1_000, Math.floor(budget / 2)));
}

/** Cuts text at the output limit and says so. */
export function bounded(text: string): { output: string; truncated: boolean } {
  if (text.length <= OUTPUT_LIMIT) return { output: text, truncated: false };
  return {
    output: `${text.slice(0, OUTPUT_LIMIT)}\n\n[Truncated to ${OUTPUT_LIMIT} characters. Use search options or narrower locators to read specific content]`,
    truncated: true,
  };
}

// The lines of a Playwright call log that say why an action could not proceed.
const REASONS = [
  /element is not visible/,
  /element is not enabled/,
  /element is not editable/,
  /element is not stable/,
  /element is outside of the viewport/,
  /element is not attached to the DOM/,
  /intercepts pointer events/,
  /strict mode violation/,
];

/** A Playwright error made readable: a timeout names why the action could not proceed, its call
 * log is cut to its last distinct lines, and internal stacks are dropped. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return render(error);
  const message = plain(error.message);
  const [head = "", ...rest] = message.split("\n");
  const log = rest
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  if (error.name !== "TimeoutError" || log.length === 0) {
    return error.name === "Error" || error.name === "TimeoutError"
      ? message
      : `${error.name}: ${message}`;
  }
  const reason = [...log].reverse().find((line) => REASONS.some((pattern) => pattern.test(line)));
  const waited = log.some((line) => /locator resolved to/.test(line));
  const why =
    reason ?? (waited ? undefined : "no element matched the locator; take a fresh snapshot");
  const distinct = [...new Set(log)].slice(-6);
  return [
    why ? `${head} (${why})` : head,
    "Call log:",
    ...distinct.map((line) => `  - ${line}`),
  ].join("\n");
}

const ENTRY_LIMIT = 2000;

/** A console call as the page's DevTools would print it: a format string's `%s %d %i %f %o %O`
 * take the next argument, `%c` drops its CSS argument, `%%` is a percent sign, and the remaining
 * arguments follow with spaces. Arguments are their previews. */
export function consoleText(previews: string[]): string {
  const [first, ...rest] = previews;
  if (first === undefined) return "";
  let text = first;
  let index = 0;
  if (/%[sdifoOc%]/.test(first)) {
    text = first.replace(/%([sdifoOc%])/g, (whole, kind: string) => {
      if (kind === "%") return "%";
      if (index >= rest.length) return whole;
      const value = rest[index++] ?? "";
      if (kind === "c") return "";
      if (kind === "d" || kind === "i") return String(Number.parseInt(value, 10));
      if (kind === "f") return String(Number.parseFloat(value));
      return value;
    });
  }
  const tail = rest.slice(index);
  const joined = tail.length > 0 ? `${text} ${tail.join(" ")}` : text;
  return joined.length > ENTRY_LIMIT ? `${joined.slice(0, ENTRY_LIMIT)}…` : joined;
}

/** Where a message came from, short: host, file name and line. */
export function shortSource(url: string, line: number): string {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${parsed.host}${file ? `/…/${file}` : ""}:${line}`;
  } catch {
    return `${shortUrl(url, 60)}:${line}`;
  }
}
