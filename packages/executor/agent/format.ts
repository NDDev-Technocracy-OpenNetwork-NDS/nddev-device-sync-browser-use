// How an execution reads to an agent: plain text in a fixed order, bounded, and never the
// internals of Playwright objects, which reach the connection and the process environment.
import { inspect, types } from "node:util";

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

// Reading an agent's value for its text never runs the agent's code: no getter is called and no
// proxy trap fires. A walk up a prototype chain ends before the first proxy, and Playwright's
// markers count only as own data properties. Every public entry below classifies through these.

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

// An object and its prototypes, ending before the first proxy, whose traps are the agent's code.
function* chain(value: object): Generator<object> {
  for (
    let owner: object | null = value;
    owner !== null && !types.isProxy(owner);
    owner = Object.getPrototypeOf(owner)
  ) {
    yield owner;
  }
}

// An own data property; undefined for an accessor, a missing property or a proxy.
function ownData(value: object, key: string): unknown {
  if (types.isProxy(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}

// A data property of an object or its prototypes up to the first proxy, read without calling a
// getter; undefined for an accessor or a missing property.
function dataField(value: object, key: string): unknown {
  for (const owner of chain(value)) {
    const field = Object.getOwnPropertyDescriptor(owner, key);
    if (field) return "value" in field ? field.value : undefined;
  }
  return undefined;
}

function textField(value: object, key: string): string | undefined {
  const field = dataField(value, key);
  return typeof field === "string" && field ? field : undefined;
}

// Whether `prototype` is on the value's prototype chain before any proxy.
function inherits(prototype: object, value: object): boolean {
  for (const owner of chain(value)) if (owner !== value && owner === prototype) return true;
  return false;
}

const ERROR = Error.prototype;

/** The name and message of an error, read as data; undefined for a value that is no error. */
export function errorParts(value: unknown): { name: string; message: string } | undefined {
  if (!isObject(value) || types.isProxy(value)) return undefined;
  if (!types.isNativeError(value) && !inherits(ERROR, value)) return undefined;
  const message = dataField(value, "message");
  return {
    name: textField(value, "name") ?? "Error",
    message: typeof message === "string" ? message : "",
  };
}

// Playwright's client objects (Page, Frame, Response, Request, ElementHandle, ...) are channel
// owners: each carries its protocol type and guid as own fields.
function handleType(value: object): string | undefined {
  const type = ownData(value, "_type");
  return typeof type === "string" && typeof ownData(value, "_guid") === "string" ? type : undefined;
}

function isLocator(value: object): boolean {
  return typeof ownData(value, "_selector") === "string" && ownData(value, "_frame") !== undefined;
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
  if (!isObject(value) || types.isProxy(value)) return undefined;
  // One of Playwright's describing methods (url, status, method, toString), called on its own
  // object; a result other than a string or number is ignored.
  const call = (name: string): string | undefined => {
    const method = dataField(value, name);
    if (typeof method !== "function" || types.isProxy(method)) return undefined;
    try {
      const result: unknown = method.call(value);
      return typeof result === "string" || typeof result === "number" ? String(result) : undefined;
    } catch {
      return undefined;
    }
  };
  if (isLocator(value))
    return `<Locator ${call("toString") ?? String(ownData(value, "_selector"))}>`;
  const type = handleType(value);
  if (type === undefined) return undefined;
  const url = call("url");
  const parts = [type];
  if (type === "Response") parts.push(call("status") ?? "");
  if (type === "Request") parts.push(call("method") ?? "");
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

// The built-in operations copies are made with, taken when this module loads. Each reads only a
// value's internal slots, so no method, getter or species of the agent's value takes part, and a
// value without the slot throws instead of being read.
function uncurry<T>(method: unknown): (self: unknown, ...args: unknown[]) => T {
  return Function.prototype.call.bind(method as (...args: unknown[]) => T) as never;
}
function getter<T>(owner: object, key: PropertyKey): (self: unknown) => T {
  return uncurry<T>(Object.getOwnPropertyDescriptor(owner, key)?.get);
}
const TYPED = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsic = {
  time: uncurry<number>(Date.prototype.getTime),
  source: getter<string>(RegExp.prototype, "source"),
  flags: (
    [
      ["d", "hasIndices"],
      ["g", "global"],
      ["i", "ignoreCase"],
      ["m", "multiline"],
      ["s", "dotAll"],
      ["u", "unicode"],
      ["v", "unicodeSets"],
      ["y", "sticky"],
    ] as const
  ).flatMap(([flag, key]) =>
    Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get
      ? [[flag, getter<boolean>(RegExp.prototype, key)] as const]
      : [],
  ),
  href: getter<string>(URL.prototype, "href"),
  bufferBytes: getter<number>(ArrayBuffer.prototype, "byteLength"),
  viewBytes: getter<number>(DataView.prototype, "byteLength"),
  typedName: getter<string>(TYPED, Symbol.toStringTag),
  typedLength: getter<number>(TYPED, "length"),
  typedBytes: getter<number>(TYPED, "byteLength"),
  typedSet: uncurry<void>(Reflect.get(TYPED, "set")),
  mapEntries: uncurry<Iterable<[unknown, unknown]>>(Map.prototype.entries),
  setValues: uncurry<Iterable<unknown>>(Set.prototype.values),
  buffer: Buffer.prototype,
  url: URL.prototype,
  allocBuffer: Buffer.alloc,
  typed: Object.fromEntries(
    [
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float16Array",
      "Float32Array",
      "Float64Array",
      "BigInt64Array",
      "BigUint64Array",
    ].flatMap((name) => {
      const made = Reflect.get(globalThis, name);
      return typeof made === "function" ? [[name, made]] : [];
    }),
  ) as Record<string, new (length: number) => object>,
};

// A typed array or Buffer copied into a new built-in one of the same type.
function freshView(value: object): object {
  const name = intrinsic.typedName(value);
  const length = intrinsic.typedLength(value);
  if (intrinsic.typedBytes(value) > COPY_BYTES) return opaque(`${name}(${length})`);
  const buffer = inherits(intrinsic.buffer, value);
  const made = intrinsic.typed[name];
  if (!buffer && !made) return opaque(`${name}(${length})`);
  const copy = buffer
    ? intrinsic.allocBuffer(length)
    : new (made as new (length: number) => object)(length);
  intrinsic.typedSet(copy, value);
  return copy;
}

// A new built-in copy of a built-in value, with its content but without its class, fields or
// methods, or a tag; undefined for any other value.
function fresh(value: object): object | undefined {
  try {
    if (types.isDate(value)) return new Date(intrinsic.time(value));
    if (types.isRegExp(value)) {
      const flags = intrinsic.flags.map(([flag, read]) => (read(value) ? flag : "")).join("");
      return new RegExp(intrinsic.source(value), flags);
    }
    if (types.isArrayBuffer(value)) {
      const bytes = intrinsic.bufferBytes(value);
      if (bytes > COPY_BYTES) return opaque(`ArrayBuffer { byteLength: ${bytes} }`);
      const copy = new ArrayBuffer(bytes);
      intrinsic.typedSet(new Uint8Array(copy), new Uint8Array(value));
      return copy;
    }
    if (types.isSharedArrayBuffer(value)) return opaque("SharedArrayBuffer");
    if (types.isDataView(value)) return opaque(`DataView(${intrinsic.viewBytes(value)})`);
    if (types.isTypedArray(value)) return freshView(value);
    if (inherits(intrinsic.url, value)) {
      return opaque(`URL ${inspect({ href: intrinsic.href(value) }, INSPECT)}`);
    }
  } catch {
    // A detached buffer, whose content is gone, or an object that only inherits URL's prototype.
    return opaque(
      types.isAnyArrayBuffer(value) || types.isArrayBufferView(value) ? "[detached]" : "[URL]",
    );
  }
  return undefined;
}

// A plain array of the first items inspect prints, under the original length, so inspect still
// says how many more there are. An array's length is its own data property, never a getter.
function freshArray(value: unknown[], inner: (item: unknown) => unknown): unknown[] {
  const items: unknown[] = [];
  items.length = value.length;
  for (let index = 0; index < Math.min(value.length, INSPECT.maxArrayLength); index++) {
    const field = Object.getOwnPropertyDescriptor(value, index);
    if (field) items[index] = "value" in field ? inner(field.value) : opaque("[Getter]");
  }
  return items;
}

// A copy of a value that inspect may walk: Playwright objects become tags, and every edge of the
// graph (array items, Map keys and values, Set members, own data fields) is copied the same way.
// Only new built-in objects and plain containers reach inspect: built-in values and containers
// are rebuilt from their internal slots alone, so no class, species, method or getter of the
// agent's value takes part; other class instances keep only their own data fields under their
// class name; proxies, functions, errors and promises print as tags; a cycle prints as such. So
// no connection internals or environment can show.
function shield(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (types.isProxy(value)) return opaque("[Proxy]");
  const tagged = tag(value);
  if (tagged !== undefined) return opaque(tagged);
  // A function prints as its name only; fields attached to it are never walked.
  if (typeof value === "function")
    return opaque(`[Function: ${textField(value, "name") ?? "anonymous"}]`);
  if (ancestors.has(value)) return opaque("[Circular]");
  const copy = fresh(value);
  if (copy !== undefined) return copy;
  const error = errorParts(value);
  if (error) return opaque(`[${error.name}: ${error.message}]`);
  if (types.isPromise(value)) return opaque("Promise");
  if (depth > INSPECT.depth) return opaque(Array.isArray(value) ? "[Array]" : "[Object]");
  ancestors.add(value);
  try {
    const inner = (item: unknown) => shield(item, depth + 1, ancestors);
    if (Array.isArray(value)) return freshArray(value, inner);
    if (types.isMap(value)) {
      const entries: [unknown, unknown][] = [];
      for (const [key, item] of intrinsic.mapEntries(value))
        entries.push([inner(key), inner(item)]);
      return new Map(entries);
    }
    if (types.isSet(value)) {
      const members: unknown[] = [];
      for (const member of intrinsic.setValues(value)) members.push(inner(member));
      return new Set(members);
    }
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!field.enumerable) continue;
      fields[key] = "value" in field ? inner(field.value) : opaque("[Getter]");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return fields;
    const made = dataField(prototype, "constructor");
    const name = (typeof made === "function" && textField(made, "name")) || "Object";
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
  return sections.length > 0
    ? plain(sections.join("\n\n"))
    : "Code executed successfully (no output)";
}

/** How long Playwright's own waits may take within an execution's remaining budget: a second less,
 * or half of a budget shorter than two seconds, and never the whole budget. */
export function waitBudget(budget: number): number {
  return Math.max(1, budget - Math.min(1_000, Math.floor(budget / 2)));
}

/** Cuts text at the output limit, at a line end when one is near, and says how much is left. */
export function bounded(text: string): { output: string; truncated: boolean } {
  if (text.length <= OUTPUT_LIMIT) return { output: text, truncated: false };
  const newline = text.lastIndexOf("\n", OUTPUT_LIMIT);
  const cut = newline >= OUTPUT_LIMIT * 0.8 ? newline : OUTPUT_LIMIT;
  const shown = text.slice(0, cut);
  const lines = (part: string) => part.split("\n").length;
  return {
    output: `${shown}\n\n[Truncated: ${cut} of ${text.length} characters, ${lines(shown)} of ${lines(text)} lines. Read a part instead: snapshot({ search }) or a locator such as "main", interactiveOnly: true, getPageMarkdown, or return only the values you need]`,
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
  const parts = errorParts(error);
  if (!parts) return render(error);
  const message = plain(parts.message);
  const [head = "", ...rest] = message.split("\n");
  const log = rest
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  if (parts.name !== "TimeoutError" || log.length === 0) {
    // A closed page says what to do next; the close itself printed no warning when the agent
    // closed it.
    const shown = /Target page, context or browser has been closed/.test(head)
      ? message.replace(
          head,
          `${head} (the page is closed: assign an open one, such as state.page = await context.newPage())`,
        )
      : message;
    return parts.name === "Error" || parts.name === "TimeoutError"
      ? shown
      : `${parts.name}: ${shown}`;
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
