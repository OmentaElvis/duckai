/**
 * Main thread entry.
 *
 * The webview window lives in ./worker (its GTK loop blocks that thread's event
 * loop). This side stays free to execute harness tools — including async ones —
 * and answers the worker's blocking IPC requests over a SharedArrayBuffer.
 */
import { fetchUpstream, readCachedHtml, writeCachedHtml } from "./cache";
import { handleHarnessCall, setAvailableUpdate, setReloadHandler } from "./harness";
import { log } from "./logging/host";
import {
  IPC_CMD_INDEX,
  IPC_CMD_RELOAD,
  IPC_REQUEST,
  IPC_RESPONSE,
  readPayload,
  viewsOf,
  writePayload,
  type IpcViews,
  type WorkerMessage,
} from "./ipc";

// Work around known GTK4 / WebKitGTK defects on Linux:
//  - Default GSK renderer (ngl/cairo) corrupts GTK's implicit pointer grab when
//    both mouse buttons are pressed at once, leaving the window unresponsive to
//    clicks (hover still works, even the CSD titlebar/close button goes dead).
//    Forcing the legacy GL renderer avoids it.
//  - WebKitGTK 2.40+ compositing defects / stale Wayland input regions.
// Set before the worker initializes GTK; explicit user values are respected.
if (process.platform === "linux") {
  const defaults = {
    GSK_RENDERER: "gl",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  } as const;
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

log.info("starting webview worker");

const worker = new Worker(new URL("./worker.ts", import.meta.url));

// Asynchronous background cache populator & update checker
void (async () => {
  if (process.env.DUCKAI_NO_CACHE === "1") return;
  try {
    const cached = readCachedHtml();
    const upstream = await fetchUpstream();
    if (!upstream) {
      log.child("cache").debug("upstream offline or unreachable");
      return;
    }

    if (!cached) {
      writeCachedHtml(upstream.html);
      log.child("cache").info(`initial cache populated: ${upstream.versionTag ?? "dev"}`);
      return;
    }

    const cachedTag = cached.versionTag;
    const upstreamTag = upstream.versionTag;
    if (upstreamTag && cachedTag && upstreamTag !== cachedTag) {
      log.child("cache").info(`upstream update detected: ${cachedTag} → ${upstreamTag}`);
      writeCachedHtml(upstream.html);
      // Only advertise an update if the new document really landed on disk —
      // otherwise "Reload" would keep re-loading the old cache forever.
      const saved = readCachedHtml();
      if (!saved || saved.versionTag !== upstreamTag) {
        log.child("cache").warn("cache write did not persist; not advertising update");
        return;
      }
      setAvailableUpdate({
        hasUpdate: true,
        cachedVersion: cachedTag,
        cachedSha: cached.versionSha,
        upstreamVersion: upstreamTag,
        upstreamSha: upstream.versionSha,
        updatedAt: Date.now(),
      });
    } else {
      log.child("cache").debug(`cache is up to date: ${cachedTag}`);
    }
  } catch (err) {
    log.child("cache").debug("background update check error", err);
  }
})();

let views: IpcViews | null = null;

// The worker cannot receive postMessage while blocked in webview.run(); signal
// a reload through the shared control slot and let its GTK poll pick it up.
setReloadHandler(() => {
  if (!views) return false;
  Atomics.store(views.control, IPC_CMD_INDEX, IPC_CMD_RELOAD);
  Atomics.notify(views.control, IPC_CMD_INDEX);
  return true;
});

worker.onmessage = async (event: MessageEvent) => {
  const message = event.data as WorkerMessage;

  if (message.type === "init") {
    views = viewsOf(message.buffer);
    return;
  }

  if (message.type === "req") {
    if (!views) {
      log.error("harness request before init");
      return;
    }
    const { control, data } = views;
    if (Atomics.load(control, 0) !== IPC_REQUEST) return;

    const request = readPayload(data, Atomics.load(control, 1));

    let response: unknown;
    try {
      response = await handleHarnessCall(request);
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let length: number;
    try {
      length = writePayload(data, response);
    } catch (err) {
      length = writePayload(data, {
        ok: false,
        error: `harness response too large: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    Atomics.store(control, 2, length);
    Atomics.store(control, 0, IPC_RESPONSE);
    Atomics.notify(control, 0);
  }
};

worker.onerror = (event: ErrorEvent) => {
  log.error("worker error", event.message ?? event);
};
