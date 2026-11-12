/**
 * Webview worker: owns the window and the document-start injection.
 *
 * Runs `webview.run()` (which blocks this worker's event loop) and services the
 * page's `__harnessNativeCall` bind asynchronously via a GTK g_timeout_add poll.
 * The bindRaw callback returns void immediately (GTK unblocked); the poll delivers
 * completed responses via webview.return(seq, ...) from within the GTK main loop.
 * See ./ipc for the SharedArrayBuffer handshake protocol.
 */
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import { SizeHint, Webview } from "webview-bun";
import { readCachedHtml } from "./cache";
import { INJECT_SCRIPT } from "./generated/inject-script";
import { applyWindowTheme, loadHtmlWithBase, scheduleWindowNudge } from "./native";
import { log } from "./logging/host";
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

// Devtools are opt-in: webview-bun also enables WebKit's
// `enable-write-console-messages-to-stdout` in debug mode, which mirrors every
// page console call to the terminal as `user-script:… CONSOLE INFO …`. Page
// logs already reach the host through the bridge, so debug stays off unless
// explicitly requested with DUCKAI_DEBUG=1.
const webview = new Webview(process.env.DUCKAI_DEBUG === "1", {
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

// --- Async harness bridge ---------------------------------------------------
//
// webview-bun's bind() callbacks can only return synchronously, which blocks
// the GTK main loop for the entire tool call duration. We use bindRaw() instead:
// the callback returns void immediately (GTK unblocked), and the response is
// delivered later via webview.return(seq, ...) from a g_timeout_add poll that
// runs inside webview.run()'s GTK main loop.
//
// Queue invariants:
//   - pendingQueue  : requests waiting to enter the single SAB slot.
//   - inFlight      : the one request currently occupying the SAB slot (null = slot free).
//   - SAB transitions: IPC_IDLE → IPC_REQUEST (GTK poll) → IPC_RESPONSE (main thread) → IPC_IDLE (GTK poll).
//   - GTK poll is the sole writer of IPC_IDLE; main thread is the sole writer of IPC_RESPONSE.
//   - GTK poll is the sole consumer of IPC_RESPONSE; main thread is the sole consumer of IPC_REQUEST.

interface Pending {
  seq: string;     // webview-bun native Promise handle — kept until webview.return() is called
  payload: unknown; // the request object to forward to the main thread via SAB
}

const pendingQueue: Pending[] = [];
let inFlight: (Pending & { startedAt: number }) | null = null;

// bindRaw: seq keeps the page-side Promise open until webview.return(seq, ...) is called.
// Returns void immediately — the GTK main loop is never blocked.
webview.bindRaw("__harnessNativeCall", (seq: string, rawReq: string) => {
  let payload: unknown;
  try {
    // webview-bun passes call arguments as a JSON array; we take the first element.
    [payload] = JSON.parse(rawReq) as [unknown];
  } catch {
    webview.return(seq, 1, JSON.stringify({ ok: false, error: "bad request" }));
    return;
  }
  pendingQueue.push({ seq, payload });
  // The GTK poll (registered below) will service this entry.
});

// GTK poll: runs entirely on the GTK thread inside webview.run()'s g_main_loop.
// It is safe to call webview.return() from here.
// Returns 1 (G_SOURCE_CONTINUE) so GTK keeps the timer alive indefinitely.
function pollTick(_userData: unknown): number {
  // ── Step 1: deliver a completed response ──────────────────────────────────
  if (inFlight !== null && Atomics.load(control, 0) === IPC_RESPONSE) {
    const len = Atomics.load(control, 2);
    const response = readPayload(data, len);
    Atomics.store(control, 0, IPC_IDLE);
    webview.return(inFlight.seq, 0, JSON.stringify(response));
    inFlight = null;
  }

  // ── Step 2: timeout guard ─────────────────────────────────────────────────
  // If the main thread hasn't responded within the deadline, free the slot
  // and return an error so the page call doesn't hang forever.
  if (inFlight !== null && Date.now() - inFlight.startedAt > IPC_WAIT_TIMEOUT_MS) {
    Atomics.store(control, 0, IPC_IDLE);
    webview.return(inFlight.seq, 1, JSON.stringify({ ok: false, error: "harness host timed out" }));
    inFlight = null;
  }

  // ── Step 2b: stale-response guard ─────────────────────────────────────────
  // If the main thread responded after the timeout fired (edge case), the SAB
  // is left in IPC_RESPONSE with no consumer. Detect and discard it so the
  // slot doesn't stay stuck for subsequent calls.
  if (inFlight === null && Atomics.load(control, 0) === IPC_RESPONSE) {
    Atomics.store(control, 0, IPC_IDLE);
  }

  // ── Step 3: start the next queued request ─────────────────────────────────
  if (inFlight === null && pendingQueue.length > 0 && Atomics.load(control, 0) === IPC_IDLE) {
    const next = pendingQueue.shift()!;
    let len: number;
    try {
      len = writePayload(data, next.payload);
    } catch (err) {
      // Payload too large for the SAB — immediately fail this request and move on.
      webview.return(next.seq, 1, JSON.stringify({ ok: false, error: String(err) }));
      return 1; // G_SOURCE_CONTINUE
    }
    inFlight = { ...next, startedAt: Date.now() };
    Atomics.store(control, 1, len);
    Atomics.store(control, 0, IPC_REQUEST);
    Atomics.notify(control, 0);    // memory barrier; keeps future Atomics.wait users unblocked
    postMessage({ type: "req" }); // wake main thread's onmessage handler
  }

  return 1; // G_SOURCE_CONTINUE
}

// Keep JSCallbacks alive: GTK holds a raw function pointer; GC would crash.
// Same pattern as nudgeCallbacks in native.ts.
const keepAliveCallbacks = new Set<JSCallback>();

try {
  const glib = dlopen("libglib-2.0.so.0", {
    g_timeout_add: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  });
  const cb = new JSCallback(pollTick, { args: [FFIType.ptr], returns: FFIType.u32 });
  keepAliveCallbacks.add(cb);
  glib.symbols.g_timeout_add(8, cb.ptr, null); // 8 ms ≈ 120 Hz — imperceptible response latency
} catch (err) {
  // GLib unavailable (should not happen on Linux/GTK). Fall back to the original
  // synchronous bridge so the app remains functional at the cost of ANR during long calls.
  log.warn("g_timeout_add unavailable — falling back to synchronous bridge", err);
  webview.bind("__harnessNativeCall", (req: unknown): unknown => {
    if (Atomics.load(control, 0) !== IPC_IDLE) {
      return { ok: false, error: "harness host is busy" };
    }
    let len: number;
    try {
      len = writePayload(data, req);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    Atomics.store(control, 1, len);
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
}

webview.init(INJECT_SCRIPT);

const target = process.env.DUCKAI_URL ?? "https://duck.ai";
const noCache = process.env.DUCKAI_NO_CACHE === "1";
postMessage({ type: "init", buffer });

let loadedFromCache = false;
if (!noCache && target === "https://duck.ai") {
  const cached = readCachedHtml();
  if (cached) {
    loadedFromCache = loadHtmlWithBase(webview, cached.html, "https://duck.ai/");
    if (loadedFromCache) {
      log.info(`loaded from offline cache: ${cached.versionTag} (${cached.versionSha.slice(0, 8)})`);
    }
  }
}

if (!loadedFromCache) {
  webview.navigate(target);
}

webview.run();
