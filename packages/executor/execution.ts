// Which execution a piece of agent code belongs to (ADR 0015). Timers and promises carry their
// execution along by themselves. Callbacks a script hands to Playwright (event listeners, routes,
// bindings, locator handlers, event predicates) are bound to it here, because Playwright calls
// them later from its own connection. So once an execution is aborted:
// - its Playwright calls throw, wherever they run (the executor's instrumentation checks the
//   execution's signal);
// - its listeners, routes and locator handlers are withdrawn, so pages behave as without them;
//   until a route is withdrawn it falls back, and a WebSocket route connects to the server.
// The execution's own state is kept, and so are callbacks of executions that ended normally.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Console } from "./agent/format";

export type Execution = {
  signal: AbortSignal;
  logs: Console[];
  /** What undoes the execution's registrations, run once it is aborted. */
  withdraw: Array<() => unknown>;
};

export const scope = new AsyncLocalStorage<Execution>();

type Callback = (this: unknown, ...args: unknown[]) => unknown;
type Method = (this: object, ...args: unknown[]) => unknown;

// Every wrapper made here, and the wrappers of each callback, so a removal by the original callback
// finds what Playwright holds; a callback registered several times has a wrapper for each.
const wrappers = new WeakSet<object>();
const wrappersOf = new WeakMap<object, Callback[]>();
const patched = new WeakSet<object>();

// The callback, run in `execution` from wherever it is called; `aborted` answers instead once the
// execution is aborted. A callback already bound, or Playwright's once-wrapper around one, stays.
function bind(
  callback: unknown,
  execution: Execution,
  aborted?: (...args: unknown[]) => unknown,
): unknown {
  if (typeof callback !== "function" || wrappers.has(callback)) return callback;
  const inner = Object.getOwnPropertyDescriptor(callback, "listener")?.value;
  if (typeof inner === "function" && wrappers.has(inner)) return callback;
  const wrapper: Callback = function (this: unknown, ...args: unknown[]) {
    if (aborted && execution.signal.aborted) return aborted(...args);
    return scope.run(execution, () => (callback as Callback).apply(this, args));
  };
  wrappers.add(wrapper);
  wrappersOf.set(callback, [...(wrappersOf.get(callback) ?? []), wrapper]);
  return wrapper;
}

function wrappersFor(callback: unknown): Callback[] {
  return typeof callback === "function" ? (wrappersOf.get(callback) ?? []) : [];
}

// What a removal of `callback` from `event` removes: like the emitter's own removal, the last entry
// in the emitter's current order that is the callback or one of its wrappers, so prepended and
// repeated registrations go as they would without wrappers. Playwright's emitter lists a
// once-listener by the listener it wraps.
function held(self: object, event: unknown, callback: unknown): unknown {
  const wrapped: unknown[] = wrappersFor(callback);
  if (wrapped.length === 0) return callback;
  const listeners = Reflect.get(self, "listeners");
  const current: unknown[] = typeof listeners === "function" ? listeners.call(self, event) : [];
  for (let index = current.length - 1; index >= 0; index--) {
    const entry = current[index];
    if (entry === callback || wrapped.includes(entry)) return entry;
  }
  return callback;
}

// Replaces a method of `prototype` with one that lets `change` rewrite its arguments: inside an
// execution only, unless `always`.
function around(
  prototype: object,
  name: string,
  change: (self: object, args: unknown[], execution: Execution | undefined) => void,
  always = false,
): void {
  const method = Reflect.get(prototype, name);
  if (typeof method !== "function" || patched.has(method)) return;
  const replacement: Method = function (this: object, ...args: unknown[]) {
    const execution = scope.getStore();
    if (execution || always) change(this, args, execution);
    return (method as Method).apply(this, args);
  };
  patched.add(replacement);
  Object.defineProperty(prototype, name, {
    value: replacement,
    writable: true,
    configurable: true,
  });
}

function later(undo: () => unknown): () => unknown {
  return () => {
    try {
      const result = undo();
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // The target is already gone.
    }
  };
}

/** Binds the listeners of Playwright's event emitter, the base of every client object. */
export function bindEmitter(prototype: object): void {
  for (const name of ["on", "addListener", "prependListener", "once", "prependOnceListener"]) {
    around(prototype, name, (self, args, execution) => {
      if (!execution) return;
      const [event, listener] = args;
      const bound = bind(listener, execution);
      if (bound === listener) return;
      args[1] = bound;
      execution.withdraw.push(
        later(() => (self as { removeListener: Method }).removeListener(event, bound)),
      );
    });
  }
  for (const name of ["off", "removeListener"]) {
    around(prototype, name, (self, args) => (args[1] = held(self, args[0], args[1])), true);
  }
}

/** Binds the callbacks a Page or BrowserContext takes. */
export function bindPage(prototype: object): void {
  around(prototype, "route", (self, args, execution) => {
    if (!execution) return;
    const [url, handler] = args;
    const bound = bind(handler, execution, (route) =>
      (route as { fallback(): Promise<void> }).fallback(),
    );
    if (bound === handler) return;
    args[1] = bound;
    execution.withdraw.push(later(() => (self as { unroute: Method }).unroute(url, bound)));
  });
  // Playwright's unroute removes every route of the URL with that handler, so it removes each of the
  // handler's wrappers as well.
  const unroute = Reflect.get(prototype, "unroute");
  if (typeof unroute === "function" && !patched.has(unroute)) {
    const replacement: Method = async function (this: object, url: unknown, handler?: unknown) {
      for (const wrapper of wrappersFor(handler))
        await (unroute as Method).call(this, url, wrapper);
      return (unroute as Method).call(this, url, handler);
    };
    patched.add(replacement);
    Object.defineProperty(prototype, "unroute", {
      value: replacement,
      writable: true,
      configurable: true,
    });
  }
  around(prototype, "routeWebSocket", (_self, args, execution) => {
    if (!execution || typeof args[1] !== "function") return;
    const handler = args[1] as Callback;
    const aware: Callback = function (this: unknown, socket: unknown) {
      if (typeof socket === "object" && socket !== null) {
        bindWebSocketRoute(Object.getPrototypeOf(socket));
      }
      return handler.call(this, socket);
    };
    args[1] = bind(aware, execution, (socket) =>
      (socket as { connectToServer(): unknown }).connectToServer(),
    );
  });
  for (const name of ["exposeBinding", "exposeFunction"]) {
    around(prototype, name, (_self, args, execution) => {
      if (execution) args[1] = bind(args[1], execution);
    });
  }
  around(prototype, "addLocatorHandler", (self, args, execution) => {
    if (!execution) return;
    const [locator, handler] = args;
    const bound = bind(handler, execution);
    if (bound === handler) return;
    args[1] = bound;
    execution.withdraw.push(
      later(() => (self as { removeLocatorHandler: Method }).removeLocatorHandler(locator)),
    );
  });
  bindPredicate(prototype);
}

// Binds the predicate of `waitForEvent`, given alone or as `{ predicate }`.
function bindPredicate(prototype: object): void {
  around(prototype, "waitForEvent", (_self, args, execution) => {
    if (!execution) return;
    const options = args[1];
    if (typeof options === "function") args[1] = bind(options, execution);
    else if (typeof options === "object" && options !== null) {
      const predicate = Reflect.get(options, "predicate");
      if (typeof predicate === "function") {
        args[1] = { ...options, predicate: bind(predicate, execution) };
      }
    }
  });
}

/** Binds the handlers of a routed WebSocket. */
export function bindWebSocketRoute(prototype: object): void {
  for (const name of ["onMessage", "onClose"]) {
    around(prototype, name, (_self, args, execution) => {
      if (execution) args[0] = bind(args[0], execution);
    });
  }
}

/** The prototype on the value's chain that defines `name` itself. */
export function definer(value: object, name: string): object | undefined {
  for (
    let owner = Object.getPrototypeOf(value);
    owner !== null;
    owner = Object.getPrototypeOf(owner)
  ) {
    if (Object.hasOwn(owner, name)) return owner;
  }
  return undefined;
}

/** Ends an execution's registrations once it is aborted. */
export function withdraw(execution: Execution): void {
  for (const undo of execution.withdraw.splice(0)) undo();
}
