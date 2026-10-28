// Callbacks handed to Playwright stay in the execution that registered them, against stand-ins
// for Playwright's event emitter and page.
import { expect, test } from "bun:test";
import { bindEmitter, bindPage, type Execution, scope, withdraw } from "../execution.js";

type Listener = (...args: unknown[]) => unknown;

// Playwright's emitter keeps `once` listeners in a wrapper that names the listener, prepends at the
// front, and removes the last matching entry, as Node's does.
class Emitter {
  registered = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    this.registered.set(event, [...(this.registered.get(event) ?? []), listener]);
    return this;
  }
  addListener(event: string, listener: Listener): this {
    return this.on(event, listener);
  }
  prependListener(event: string, listener: Listener): this {
    this.registered.set(event, [listener, ...(this.registered.get(event) ?? [])]);
    return this;
  }
  once(event: string, listener: Listener): this {
    const wrapper = Object.assign(
      (...args: unknown[]) => {
        this.removeListener(event, wrapper);
        return listener(...args);
      },
      { listener },
    );
    return this.on(event, wrapper);
  }
  prependOnceListener(event: string, listener: Listener): this {
    return this.once(event, listener);
  }
  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }
  removeListener(event: string, listener: Listener): this {
    const entries = [...(this.registered.get(event) ?? [])];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as Listener & { listener?: unknown };
      if (entry === listener || entry.listener === listener) {
        entries.splice(index, 1);
        break;
      }
    }
    this.registered.set(event, entries);
    return this;
  }
  listeners(event: string): Listener[] {
    return (this.registered.get(event) ?? []).map(
      (listener) => ((listener as { listener?: Listener }).listener ?? listener) as Listener,
    );
  }
  emit(event: string, ...args: unknown[]): unknown[] {
    return [...(this.registered.get(event) ?? [])].map((listener) => listener(...args));
  }
}

class Page extends Emitter {
  routes: Array<{ url: string; handler: Listener }> = [];
  async route(url: string, handler: Listener): Promise<void> {
    this.routes.push({ url, handler });
  }
  async unroute(url: string, handler: Listener): Promise<void> {
    this.routes = this.routes.filter((entry) => entry.url !== url || entry.handler !== handler);
  }
  async routeWebSocket(): Promise<void> {}
  async exposeBinding(): Promise<void> {}
  async exposeFunction(): Promise<void> {}
  async addLocatorHandler(): Promise<void> {}
  async removeLocatorHandler(): Promise<void> {}
  async waitForEvent(): Promise<void> {}
}

bindEmitter(Emitter.prototype);
bindPage(Page.prototype);

function execution(): Execution & { abort(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    logs: [],
    withdraw: [],
    abort: () => controller.abort(),
  };
}

test("a listener runs in the execution that registered it, wherever it is called from", () => {
  const page = new Page();
  const first = execution();
  scope.run(first, () => page.on("console", () => scope.getStore()));
  // Outside any execution, as Playwright's connection calls it.
  expect(page.emit("console")).toEqual([first]);
  // A registration outside any execution is left as it is.
  page.on("load", () => scope.getStore());
  expect(page.emit("load")).toEqual([undefined]);
});

test("a listener is removed by the callback it was registered with, once listeners too", async () => {
  const page = new Page();
  const owner = execution();
  const listener = () => "called";
  scope.run(owner, () => {
    page.on("a", listener);
    page.once("b", listener);
  });
  page.off("a", listener);
  page.removeListener("b", listener);
  expect(page.emit("a")).toEqual([]);
  expect(page.emit("b")).toEqual([]);
  // A route registered twice is removed whole, as Playwright removes it.
  scope.run(owner, () => {
    void page.route("**/api", listener);
    void page.route("**/api", listener);
  });
  expect(page.routes).toHaveLength(2);
  await page.unroute("**/api", listener);
  expect(page.routes).toEqual([]);
});

test("a removal takes the latest registration in the emitter's order, as without wrappers", () => {
  const page = new Page();
  const ended = execution();
  const aborted = execution();
  const listener = () => scope.getStore();
  scope.run(ended, () => page.on("a", listener));
  scope.run(aborted, () => page.on("a", listener));
  // The latest registration goes first, so the ended execution's stays, also after the abort.
  page.off("a", listener);
  expect(page.emit("a")).toEqual([ended]);
  scope.run(aborted, () => page.on("a", listener));
  aborted.abort();
  withdraw(aborted);
  expect(page.emit("a")).toEqual([ended]);
  page.off("a", listener);
  expect(page.emit("a")).toEqual([]);
  // A prepended registration is first in order, so a removal takes the one behind it.
  const front = execution();
  scope.run(ended, () => page.on("b", listener));
  scope.run(front, () => page.prependListener("b", listener));
  page.removeListener("b", listener);
  expect(page.emit("b")).toEqual([front]);
  // A registration outside any execution counts in the same order.
  page.on("b", listener);
  page.off("b", listener);
  expect(page.emit("b")).toEqual([front]);
});

test("an aborted execution's listeners and routes are withdrawn; an ended one's stay", async () => {
  const page = new Page();
  const ended = execution();
  const aborted = execution();
  scope.run(ended, () => {
    page.on("console", () => "ended");
    void page.route("**/kept", () => "kept");
  });
  scope.run(aborted, () => {
    page.on("console", () => "aborted");
    page.once("dialog", () => "aborted");
    void page.route("**/api", () => "aborted");
  });
  aborted.abort();
  withdraw(aborted);
  await Bun.sleep(0);
  expect(page.emit("console")).toEqual(["ended"]);
  expect(page.emit("dialog")).toEqual([]);
  expect(page.routes.map((entry) => entry.url)).toEqual(["**/kept"]);
  expect(aborted.withdraw).toEqual([]);
});

test("an aborted execution's route falls back until it is withdrawn", async () => {
  const page = new Page();
  const owner = execution();
  await scope.run(owner, () => page.route("**/api", () => "answered"));
  const handler = page.routes[0]?.handler;
  let fellBack = 0;
  const route = {
    fallback: async () => {
      fellBack += 1;
    },
  };
  expect(handler?.(route)).toBe("answered");
  owner.abort();
  await handler?.(route);
  expect(fellBack).toBe(1);
});
