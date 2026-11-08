/**
 * Main thread entry.
 *
 * The webview window lives in ./worker (its GTK loop blocks that thread's event
 * loop). This side stays free to execute harness tools — including async ones —
 * and answers the worker's blocking IPC requests over a SharedArrayBuffer.
 */
import { handleHarnessCall } from "./harness";
import {
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

console.log("[duckai] starting webview worker");

const worker = new Worker(new URL("./worker.ts", import.meta.url));

let views: IpcViews | null = null;

worker.onmessage = async (event: MessageEvent) => {
  const message = event.data as WorkerMessage;

  if (message.type === "init") {
    views = viewsOf(message.buffer);
    return;
  }

  if (message.type === "req") {
    if (!views) {
      console.error("[duckai] harness request before init");
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
  console.error("[duckai] worker error:", event.message ?? event);
};
