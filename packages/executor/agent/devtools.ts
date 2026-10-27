// DevTools for agents over raw CDP: a debugger, an editor that searches a page's scripts and
// style sheets, edits style sheets live and overrides scripts on their next load, the CSS rules
// that style an element, and React component details.
import type { CDPSession, Locator, Page } from "playwright-core";

export function getCDPSession({ page }: { page: Page }): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

type Script = { scriptId: string; url: string };
type Frame = {
  callFrameId: string;
  functionName: string;
  url: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
  scopeChain: { type: string; object: { objectId?: string } }[];
};
type Property = { name: string; value?: { type: string; value?: unknown; description?: string } };

// Chrome reports a page's scripts and style sheets when a domain is enabled, so enabling one that
// another helper enabled on the same session first turns it off; breakpoints set on that
// session's debugger go with it, so a debugger is best given its own session.
async function reenable(cdp: CDPSession, domain: "Debugger" | "CSS"): Promise<void> {
  await cdp.send(`${domain}.disable`).catch(() => {});
  await cdp.send(`${domain}.enable`);
}

function scriptsOf(cdp: CDPSession): Map<string, Script> {
  const scripts = new Map<string, Script>();
  cdp.on("Debugger.scriptParsed", ({ scriptId, url }) => {
    if (url) scripts.set(scriptId, { scriptId, url });
  });
  return scripts;
}

/** Breakpoints, stepping and variables of a page's scripts. */
export function createDebugger({ cdp }: { cdp: CDPSession }) {
  const scripts = scriptsOf(cdp);
  let paused: { reason: string; frames: Frame[] } | undefined;
  cdp.on("Debugger.paused", ({ reason, callFrames }) => {
    paused = { reason, frames: callFrames as Frame[] };
  });
  cdp.on("Debugger.resumed", () => {
    paused = undefined;
  });
  const top = () => {
    const frame = paused?.frames[0];
    if (!frame) throw new Error("the debugger is not paused");
    return frame;
  };
  return {
    async enable() {
      await reenable(cdp, "Debugger");
      await cdp.send("Runtime.enable");
    },
    listScripts({ search }: { search?: string | RegExp } = {}) {
      return [...scripts.values()].filter(({ url }) =>
        search === undefined
          ? true
          : typeof search === "string"
            ? url.includes(search)
            : search.test(url),
      );
    },
    async setBreakpoint({
      file,
      line,
      condition,
    }: {
      file: string;
      line: number;
      condition?: string;
    }) {
      const { breakpointId } = await cdp.send("Debugger.setBreakpointByUrl", {
        url: file,
        lineNumber: line - 1,
        ...(condition ? { condition } : {}),
      });
      return breakpointId;
    },
    removeBreakpoint: (breakpointId: string) =>
      cdp.send("Debugger.removeBreakpoint", { breakpointId }),
    pauseOnExceptions: (state: "none" | "uncaught" | "all") =>
      cdp.send("Debugger.setPauseOnExceptions", { state }),
    blackbox: (patterns: string[]) => cdp.send("Debugger.setBlackboxPatterns", { patterns }),
    isPaused: () => paused !== undefined,
    pause: () => cdp.send("Debugger.pause"),
    resume: () => cdp.send("Debugger.resume"),
    stepOver: () => cdp.send("Debugger.stepOver"),
    stepInto: () => cdp.send("Debugger.stepInto"),
    stepOut: () => cdp.send("Debugger.stepOut"),
    getLocation() {
      const frame = top();
      return {
        reason: paused?.reason,
        functionName: frame.functionName,
        url: scripts.get(frame.location.scriptId)?.url ?? frame.url,
        line: frame.location.lineNumber + 1,
        column: frame.location.columnNumber + 1,
        stack: paused?.frames.map(
          (each) =>
            `${each.functionName || "(anonymous)"} ${each.url}:${each.location.lineNumber + 1}`,
        ),
      };
    },
    async inspectLocalVariables() {
      const variables: Record<string, string> = {};
      for (const scope of top().scopeChain.filter(
        ({ type }) => type === "local" || type === "block",
      )) {
        if (!scope.object.objectId) continue;
        const { result } = (await cdp.send("Runtime.getProperties", {
          objectId: scope.object.objectId,
          ownProperties: true,
        })) as { result: Property[] };
        for (const { name, value } of result) {
          variables[name] =
            value?.description ?? JSON.stringify(value?.value) ?? String(value?.type);
        }
      }
      return variables;
    },
    async evaluate({ expression }: { expression: string }) {
      const { result, exceptionDetails } = (await cdp.send("Debugger.evaluateOnCallFrame", {
        callFrameId: top().callFrameId,
        expression,
        returnByValue: true,
      })) as {
        result: { value?: unknown; description?: string };
        exceptionDetails?: { text: string };
      };
      if (exceptionDetails) throw new Error(exceptionDetails.text);
      return result.value ?? result.description;
    },
  };
}

/**
 * Search of a page's scripts and style sheets, live edits of its style sheets, and overrides of a
 * script or document on its next load. Chrome no longer edits a running script over CDP.
 */
export function createEditor({ cdp, page }: { cdp: CDPSession; page?: Page }) {
  const scripts = scriptsOf(cdp);
  const sheets = new Map<string, string>();
  cdp.on("CSS.styleSheetAdded", ({ header }) => {
    const inline = header.isInline || !header.sourceURL;
    sheets.set(
      header.styleSheetId,
      inline ? `inline-style:${header.styleSheetId}` : header.sourceURL,
    );
  });
  const source = async (url: string) => {
    const script = [...scripts.values()].find((each) => each.url === url);
    if (script) {
      const { scriptSource } = await cdp.send("Debugger.getScriptSource", {
        scriptId: script.scriptId,
      });
      return { kind: "script" as const, id: script.scriptId, text: scriptSource };
    }
    const sheet = [...sheets].find(([, sheetUrl]) => sheetUrl === url);
    if (sheet) {
      const { text } = await cdp.send("CSS.getStyleSheetText", { styleSheetId: sheet[0] });
      return { kind: "sheet" as const, id: sheet[0], text };
    }
    throw new Error(`no script or style sheet with url ${url}`);
  };
  return {
    async enable() {
      await reenable(cdp, "Debugger");
      await cdp.send("DOM.enable");
      await reenable(cdp, "CSS");
    },
    list: () => [...[...scripts.values()].map(({ url }) => url), ...sheets.values()],
    read: async ({ url }: { url: string }) => (await source(url)).text,
    async grep({ regex, limit = 20 }: { regex: RegExp; limit?: number }) {
      const pattern = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ""));
      const found: { url: string; line: number; text: string }[] = [];
      for (const url of [...[...scripts.values()].map((each) => each.url), ...sheets.values()]) {
        const { text } = await source(url).catch(() => ({ text: "" }));
        text.split("\n").forEach((line, index) => {
          if (found.length < limit && pattern.test(line)) {
            found.push({ url, line: index + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
      return found;
    },
    async edit({
      url,
      oldString,
      newString,
    }: {
      url: string;
      oldString: string;
      newString: string;
    }) {
      const current = await source(url);
      if (current.kind === "script") {
        throw new Error(
          "Chrome no longer edits a running script; use override() and reload the page",
        );
      }
      if (current.text.split(oldString).length !== 2) {
        throw new Error("oldString must occur exactly once");
      }
      await cdp.send("CSS.setStyleSheetText", {
        styleSheetId: current.id,
        text: current.text.replace(oldString, newString),
      });
    },
    /** Replaces text in a script or document each time the page loads it, until the page closes. */
    async override({
      url,
      oldString,
      newString,
    }: {
      url: string;
      oldString: string;
      newString: string;
    }) {
      if (!page) throw new Error("override needs createEditor({ cdp, page })");
      // The original comes through the executor with the request's own headers and cookies;
      // route.fetch() would need browser-wide cookies, which agent sessions cannot read.
      await page.route(url, async (route) => {
        const request = route.request();
        const response = await fetch(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postData(),
        });
        const headers = Object.fromEntries(response.headers);
        delete headers["content-encoding"];
        delete headers["content-length"];
        const body = (await response.text()).replace(oldString, newString);
        await route.fulfill({ status: response.status, headers, body });
      });
    },
  };
}

type Rule = {
  selector: string;
  source: string;
  declarations: string[];
};

/** The CSS rules that apply to an element, like the Styles panel, each with its source. */
export async function getStylesForLocator({ locator, cdp }: { locator: Locator; cdp: CDPSession }) {
  const marker = `nds-styles-${Date.now()}`;
  await locator
    .first()
    .evaluate((element, marker) => element.setAttribute("data-nds-styles", marker), marker);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-nds-styles="${marker}"]`,
    });
    const matched = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
    const rules: Rule[] = (matched.matchedCSSRules ?? []).map(({ rule }) => ({
      selector: rule.selectorList.text,
      source:
        rule.origin === "user-agent"
          ? "user agent"
          : `${rule.styleSheetId ?? "inline"}:${(rule.style.range?.startLine ?? 0) + 1}`,
      declarations: rule.style.cssProperties
        .filter(({ value, disabled }) => value !== undefined && !disabled)
        .map(({ name, value, important }) => `${name}: ${value}${important ? " !important" : ""}`),
    }));
    const inline = matched.inlineStyle?.cssProperties
      .filter(({ value }) => value !== undefined)
      .map(({ name, value }) => `${name}: ${value}`);
    return { inline: inline ?? [], rules: rules.reverse() };
  } finally {
    await locator
      .first()
      .evaluate((element) => element.removeAttribute("data-nds-styles"))
      .catch(() => {});
  }
}

export function formatStylesAsText(styles: { inline: string[]; rules: Rule[] }): string {
  const blocks = styles.inline.length
    ? [`element.style {\n  ${styles.inline.join(";\n  ")};\n}`]
    : [];
  for (const rule of styles.rules) {
    blocks.push(
      `${rule.selector} /* ${rule.source} */ {\n  ${rule.declarations.join(";\n  ")};\n}`,
    );
  }
  return blocks.join("\n\n");
}

/**
 * Best-effort React details of an element: component name, source location (development builds
 * only), parent components and sanitized props; null for an element React did not render.
 */
export function getReactComponentInfo({ locator }: { locator: Locator }) {
  return locator.first().evaluate((element) => {
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
    type Fiber = {
      type?: unknown;
      return?: Fiber;
      memoizedProps?: Record<string, unknown>;
      _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number };
    };
    let fiber = key ? ((element as unknown as Record<string, Fiber>)[key] ?? null) : null;
    const name = (each: Fiber) =>
      typeof each.type === "function"
        ? (each.type as { displayName?: string; name?: string }).displayName ||
          (each.type as { name?: string }).name ||
          "Anonymous"
        : undefined;
    while (fiber && !name(fiber)) fiber = fiber.return ?? null;
    if (!fiber) return null;
    const hierarchy: string[] = [];
    for (let each: Fiber | undefined = fiber; each && hierarchy.length < 8; each = each.return) {
      const component = name(each);
      if (component) hierarchy.push(component);
    }
    const props: Record<string, string> = {};
    for (const [prop, value] of Object.entries(fiber.memoizedProps ?? {}).slice(0, 20)) {
      if (prop === "children") continue;
      props[prop] =
        typeof value === "function"
          ? "[function]"
          : value instanceof Node
            ? "[node]"
            : (() => {
                try {
                  return JSON.stringify(value)?.slice(0, 200) ?? String(value);
                } catch {
                  return "[unserializable]";
                }
              })();
    }
    const source = fiber._debugSource
      ? {
          fileName: fiber._debugSource.fileName,
          lineNumber: fiber._debugSource.lineNumber,
          columnNumber: fiber._debugSource.columnNumber,
        }
      : null;
    return { componentName: name(fiber) ?? "", source, hierarchy, props };
  });
}

export async function getReactSource({ locator }: { locator: Locator }) {
  const info = await getReactComponentInfo({ locator });
  return info?.source ? { ...info.source, componentName: info.componentName } : null;
}
