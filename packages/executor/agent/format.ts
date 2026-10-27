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

// Replaces Playwright objects inside plain data with their tags, so inspect never walks them.
function shield(value: unknown, depth: number, seen: Set<object>): unknown {
  const tagged = tag(value);
  if (tagged !== undefined) return { [inspect.custom]: () => tagged };
  if (typeof value !== "object" || value === null || depth > INSPECT.depth || seen.has(value))
    return value;
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => shield(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    seen.add(value);
    return new Map([...value].map(([key, item]) => [key, shield(item, depth + 1, seen)]));
  }
  if (value instanceof Set) {
    seen.add(value);
    return new Set([...value].map((item) => shield(item, depth + 1, seen)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, shield(item, depth + 1, seen)]),
  );
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
  return sections.length > 0 ? sections.join("\n\n") : "Code executed successfully (no output)";
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
  const [head = "", ...rest] = error.message.split("\n");
  const log = rest
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  if (error.name !== "TimeoutError" || log.length === 0) {
    return error.name === "Error" || error.name === "TimeoutError"
      ? error.message
      : `${error.name}: ${error.message}`;
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
