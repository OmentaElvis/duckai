/**
 * Webview worker: owns the window and the document-start injection.
 *
 * Runs `webview.run()` (which blocks this worker's event loop) and services the
 * page's `harnessCall` bind synchronously by blocking on a SharedArrayBuffer
 * handshake with the main thread (see ./ipc). The main thread performs the
 * actual harness work, including async tools.
 */
import { SizeHint, Webview } from "webview-bun";
import { INJECT_SCRIPT } from "./generated/inject-script";
import { applyWindowTheme, scheduleWindowNudge } from "./native";
import {
  IPC_IDLE,
  IPC_RESPONSE,
  IPC_REQUEST,
  IPC_WAIT_TIMEOUT_MS,
  createSharedBuffer,
  readPayload,
  viewsOf,
  writePayload,
  type WorkerMessage,
} from "./ipc";

const buffer = createSharedBuffer();
const { control, data } = viewsOf(buffer);

const postMessage = (message: WorkerMessage): void =>
  (self as unknown as { postMessage(message: WorkerMessage): void }).postMessage(message);

const webview = new Webview(process.env.DUCKAI_DEBUG !== "0", {
  width: 1280,
  height: 860,
  hint: SizeHint.NONE,
});
webview.title = "duck.ai";

// Dark GTK chrome, square corners, titlebar tinted to duck.ai's dark surface.
applyWindowTheme(webview, {
  dark: true,
  radius: 0,
  background: "#161616",
  titlebarBackground: "#161616",
  titlebarForeground: "#f2f2f2",
});

// Heal stale input regions / pointer focus once mapped (see native.ts).
scheduleWindowNudge(webview);

// Synchronous bridge to the main thread. webview-bun only supports synchronous
// return values, so we block here until the host writes its response.
webview.bind("harnessCall", (req: unknown): unknown => {
  if (control[0] !== IPC_IDLE) {
    return { ok: false, error: "harness host is busy" };
  }
  let requestLength: number;
  try {
    requestLength = writePayload(data, req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  Atomics.store(control, 1, requestLength);
  Atomics.store(control, 0, IPC_REQUEST);
  Atomics.notify(control, 0);

  postMessage({ type: "req" });

  Atomics.wait(control, 0, IPC_REQUEST, IPC_WAIT_TIMEOUT_MS);
  if (Atomics.load(control, 0) !== IPC_RESPONSE) {
    Atomics.store(control, 0, IPC_IDLE);
    return { ok: false, error: "harness host timed out" };
  }

  const responseLength = Atomics.load(control, 2);
  const response = readPayload(data, responseLength);
  Atomics.store(control, 0, IPC_IDLE);
  return response;
});

webview.init(INJECT_SCRIPT);

const target = process.env.DUCKAI_URL ?? "https://duck.ai";
postMessage({ type: "init", buffer });

webview.navigate(target);
webview.run();
