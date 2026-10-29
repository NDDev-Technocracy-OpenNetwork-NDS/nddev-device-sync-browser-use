// A download's file for agent code. Chrome refuses an extension's `Page.setDownloadBehavior`, so
// the browser keeps the file in its own folder and Playwright's `path()`, `saveAs()` and
// `createReadStream()` would find nothing where they look; and once the tab closes, its download
// events stop, so Playwright would wait for the end of the download forever. The extension names
// the browser's finished file and the host keeps a copy in the session (`NDS.takeDownload`): that
// copy is the agent's file, and `path()`, `saveAs()`, `createReadStream()` and `failure()` answer
// from it, also after the page closed. A download the host does not get, because no agent tab
// announced it, is loaded a second time through the tab's own network stack instead, with the
// page's cookies and no CORS rule in the way (`Network.loadNetworkResource`); a `blob:` URL is
// read in its page and a `data:` URL decoded. A form's POST cannot be sent again, so that path
// refuses its download instead of saving whatever a GET of that URL returns. Closing the page
// waits for the copies still loading from it.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CDPSession, Download, Page } from "playwright-core";

// Bytes per `IO.read`, so a large file never crosses CDP as one reply.
const CHUNK = 1 << 20;
// Navigations a page sent other than as GET, newest last; a download of one cannot be loaded again.
const POSTED_LIMIT = 32;
// How long one question to the host waits, how long after the browser finished a download the
// host may still not know it, and how long any download may take at all.
const ASK_MS = 2000;
const UNKNOWN_MS = 5000;
const LONGEST_MS = 15 * 60 * 1000;

const posted = new WeakMap<Page, string[]>();

export function attach(page: Page): void {
  if (posted.has(page)) return;
  const sent: string[] = [];
  posted.set(page, sent);
  const loading = new Set<Promise<unknown>>();
  const close = page.close.bind(page);
  page.close = async (options) => {
    await Promise.allSettled(loading);
    return close(options);
  };
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    const known = sent.indexOf(request.url());
    if (known >= 0) sent.splice(known, 1);
    if (request.method() !== "GET") sent.push(request.url());
    if (sent.length > POSTED_LIMIT) sent.shift();
  });
  page.on("download", (download) => {
    // The executor's temporary directory is the session's own area, removed with the session.
    const folder = join(tmpdir(), ".downloads", randomUUID());
    const local = join(folder, basename(download.suggestedFilename()) || "download");
    const stop = new AbortController();
    const path = download.path.bind(download);
    const file = obtain(download, path, sent.includes(download.url()), folder, local, stop.signal);
    // A failure shows when agent code asks for the file, not as an unhandled rejection.
    const settled = file.catch(() => undefined);
    loading.add(settled);
    void settled.then(() => loading.delete(settled));
    const cancel = download.cancel.bind(download);
    download.path = () => file;
    download.failure = () =>
      file.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    download.saveAs = async (to) => {
      const from = await file;
      await mkdir(dirname(resolve(to)), { recursive: true });
      await copyFile(from, to);
    };
    download.createReadStream = async () => createReadStream(await file);
    download.cancel = async () => {
      stop.abort(new Error(`The download ${download.suggestedFilename()} was canceled`));
      await cancel().catch(() => undefined);
    };
    download.delete = async () => {
      stop.abort(new Error(`The download ${download.suggestedFilename()} was deleted`));
      await file.catch(() => undefined);
      await rm(folder, { recursive: true, force: true });
    };
  });
}

// The host's copy of the download; otherwise, once the host cannot get it, the URL loaded again.
async function obtain(
  download: Download,
  path: () => Promise<string>,
  post: boolean,
  folder: string,
  local: string,
  signal: AbortSignal,
): Promise<string> {
  const kept = await fromHost(download, path, signal);
  if (kept) return kept;
  if (post) {
    throw new Error(
      `The download ${download.suggestedFilename()} answered a form's POST, which cannot be sent again; the browser kept the file in its own download folder`,
    );
  }
  await stage(download, folder, local, signal);
  return local;
}

let browserSession: Promise<CDPSession | undefined> | undefined;

type Kept = {
  file?: string;
  error?: string;
  pending?: boolean;
  copying?: boolean;
  unsupported?: boolean;
};

async function fromHost(
  download: Download,
  path: () => Promise<string>,
  signal: AbortSignal,
): Promise<string | undefined> {
  browserSession ??= Promise.resolve(download.page().context().browser()?.newBrowserCDPSession())
    .then((session) => session ?? undefined)
    .catch(() => undefined);
  const cdp = await browserSession;
  if (!cdp) return undefined;
  const ask = cdp.send.bind(cdp) as unknown as (method: string, params: object) => Promise<Kept>;
  // The browser's own end of the download: once it is long past and the host still knows nothing,
  // the host never will.
  let ended: number | undefined;
  let failure: unknown;
  void path().then(
    () => {
      ended = Date.now();
    },
    (error: unknown) => {
      ended = Date.now();
      failure = error;
    },
  );
  const started = Date.now();
  for (;;) {
    signal.throwIfAborted();
    const answer = await ask("NDS.takeDownload", { url: download.url(), waitMs: ASK_MS }).catch(
      () => ({ unsupported: true }) as Kept,
    );
    if (answer.file) return answer.file;
    if (answer.error) {
      throw new Error(
        `The download ${download.suggestedFilename()} did not finish in the browser (${answer.error})`,
      );
    }
    if (answer.unsupported) return undefined;
    if (!answer.copying && ended !== undefined && Date.now() - ended > UNKNOWN_MS) {
      if (failure) throw failure;
      return undefined;
    }
    if (Date.now() - started > LONGEST_MS) {
      throw new Error(`The download ${download.suggestedFilename()} did not finish in 15 minutes`);
    }
  }
}

async function stage(
  download: Download,
  folder: string,
  local: string,
  signal: AbortSignal,
): Promise<void> {
  const url = download.url();
  await mkdir(folder, { recursive: true });
  const target = await open(local, "wx");
  try {
    if (url.startsWith("data:")) {
      await target.write(Buffer.from(await (await fetch(url, { signal })).arrayBuffer()));
    } else if (url.startsWith("blob:")) {
      await target.write(await blob(download, url));
    } else {
      await network(download, url, signal, async (bytes) => {
        await target.write(bytes);
      });
    }
    signal.throwIfAborted();
  } catch (error) {
    await target.close();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  await target.close();
}

async function network(
  download: Download,
  url: string,
  signal: AbortSignal,
  write: (bytes: Buffer) => Promise<void>,
): Promise<void> {
  const page = download.page();
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { resource } = await cdp.send("Network.loadNetworkResource", {
      frameId: frameTree.frame.id,
      url,
      options: { disableCache: false, includeCredentials: true },
    });
    if (!resource.success || !resource.stream) {
      const answer = [
        resource.httpStatusCode ? `HTTP ${resource.httpStatusCode}` : "",
        resource.netErrorName ?? "",
      ].filter(Boolean);
      throw new Error(
        `The download ${download.suggestedFilename()} could not be loaded again (${answer.join(", ") || "no answer"}); a site may serve a file only once. The browser kept its own copy in its download folder`,
      );
    }
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await cdp.send("IO.read", { handle: resource.stream, size: CHUNK });
        await write(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
        if (chunk.eof) break;
      }
    } finally {
      await cdp.send("IO.close", { handle: resource.stream }).catch(() => undefined);
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

// A `blob:` URL belongs to its page, which may revoke it right after starting the download.
async function blob(download: Download, url: string): Promise<Buffer> {
  const base64 = await download
    .page()
    .evaluate(async (url) => {
      const data = await (await fetch(url)).blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result);
          resolve(text.slice(text.indexOf(",") + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(data);
      });
    }, url)
    .catch((error: unknown) => {
      throw new Error(
        `The download ${download.suggestedFilename()} came from a blob: URL its page no longer serves (${error instanceof Error ? error.message : String(error)}); the browser kept the file in its own download folder`,
      );
    });
  return Buffer.from(base64, "base64");
}
