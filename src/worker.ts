/**
 * Webview worker: owns the window and the document-start injection.
 *
 * Runs `webview.run()` (which blocks this worker's event loop) and services the
 * page's `__harnessNativeCall` bind asynchronously through a native timer poll
 * registered in that event loop (GLib on Linux, Win32 `SetTimer` on Windows).
 * The bindRaw callback returns void immediately (the loop stays unblocked); the
 * poll delivers completed responses via webview.return(seq, ...) from inside the
 * loop. See ./ipc for the SharedArrayBuffer handshake protocol.
 */
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import { SizeHint, Webview } from "webview-bun";
import { readCachedHtml } from "./cache";
import { INJECT_SCRIPT } from "./generated/inject-script";
import {
  applyWindowIcon,
  applyWindowTheme,
  initLinuxApp,
  loadHtmlWithBase,
  scheduleWindowNudge,
} from "./native";
import { log } from "./logging/host";
import {
  IPC_CMD_INDEX,
  IPC_CMD_NONE,
  IPC_CMD_RELOAD,
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

// Set Linux program/application identity before the GTK window is created
// so Wayland (app_id) and X11 (WM_CLASS) match duckai.desktop in Alt-Tab.
initLinuxApp();

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

// Windows: webview does not assign a window icon, and --windows-icon only
// brands the .exe file. Apply the same icon to the titlebar/taskbar.
applyWindowIcon(webview);

// Heal stale input regions / pointer focus once mapped (see native.ts).
scheduleWindowNudge(webview);

// --- Async harness bridge ---------------------------------------------------
//
// webview-bun's bind() callbacks can only return synchronously, which blocks
// the platform event loop (GTK main loop / Win32 message loop) for the entire
// tool call duration. We use bindRaw() instead: the callback returns void
// immediately (loop unblocked), and the response is delivered later via
// webview.return(seq, ...) from a timer poll (see registerAsyncPoll below) that
// runs inside webview.run()'s event loop.
//
// Queue invariants:
//   - pendingQueue  : requests waiting to enter the single SAB slot.
//   - inFlight      : the one request currently occupying the SAB slot (null = slot free).
//   - SAB transitions: IPC_IDLE → IPC_REQUEST (poll) → IPC_RESPONSE (main thread) → IPC_IDLE (poll).
//   - The poll is the sole writer of IPC_IDLE; main thread is the sole writer of IPC_RESPONSE.
//   - The poll is the sole consumer of IPC_RESPONSE; main thread is the sole consumer of IPC_REQUEST.

interface Pending {
  seq: string;     // webview-bun native Promise handle — kept until webview.return() is called
  payload: unknown; // the request object to forward to the main thread via SAB
}

const pendingQueue: Pending[] = [];
let inFlight: (Pending & { startedAt: number }) | null = null;

const target = process.env.DUCKAI_URL ?? "https://duck.ai";
const noCache = process.env.DUCKAI_NO_CACHE === "1";
let loadedFromCache = false;

/**
 * Load Duck.ai from the cache if one is available (and caching is enabled),
 * otherwise navigate to the live site. Used both for the initial load and when
 * the page asks to apply an update: by then the host has already refreshed the
 * cache, so re-reading it picks up the new build instead of reloading the old
 * document in place.
 */
function loadFromCacheOrNetwork(reason: "startup" | "reload"): void {
  loadedFromCache = false;
  if (!noCache && target === "https://duck.ai") {
    const cached = readCachedHtml();
    if (cached) {
      loadedFromCache = loadHtmlWithBase(webview, cached.html, "https://duck.ai/");
      if (loadedFromCache) {
        const verb = reason === "reload" ? "reloaded" : "loaded";
        log.info(
          `${verb} from offline cache: ${cached.versionTag} (${cached.versionSha.slice(0, 8)})`,
        );
      }
    }
  }
  if (!loadedFromCache) webview.navigate(target);
}

// bindRaw: seq keeps the page-side Promise open until webview.return(seq, ...) is called.
// Returns void immediately — the event loop is never blocked.
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
  // The async poll (registered below) will service this entry.
});

// Async poll: runs entirely on the UI thread inside webview.run()'s event loop,
// so it is safe to call webview.return() from here. The numeric return value is
// GLib's G_SOURCE_CONTINUE (1) and is ignored by the Windows TIMERPROC wrapper.
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

  // ── Step 3: apply a pending reload requested by the page ──────────────────
  // Wait until the harness response for the reload request has been delivered
  // (and no other call is mid-flight) before replacing the document.
  if (inFlight === null && Atomics.load(control, IPC_CMD_INDEX) === IPC_CMD_RELOAD) {
    Atomics.store(control, IPC_CMD_INDEX, IPC_CMD_NONE);
    // Calls queued by the outgoing document will never be answered on the new
    // document (their webview-bun `seq` handles are invalid), so drop them.
    pendingQueue.length = 0;
    log.info("reloading webview from updated cache");
    loadFromCacheOrNetwork("reload");
    return 1; // G_SOURCE_CONTINUE
  }

  // ── Step 4: start the next queued request ─────────────────────────────────
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

// Keep JSCallbacks alive: the native timer holds a raw function pointer; GC
// would crash. Same pattern as nudgeCallbacks in native.ts.
const keepAliveCallbacks = new Set<JSCallback>();

/**
 * Register the poll ticker with the platform's native event loop.
 *
 * - Linux:   GLib `g_timeout_add` — fires inside the GTK main loop.
 * - Windows: Win32 `SetTimer` — fires inside the GetMessage/DispatchMessage
 *            loop that `webview.run()` pumps.
 *
 * Returns true when an async timer was registered. On false the caller falls
 * back to the synchronous bridge (functional, but blocks the loop per call).
 * macOS and unknown platforms also return false until a native timer exists.
 */
function registerAsyncPoll(): boolean {
  // ── Linux: GLib `g_timeout_add` ────────────────────────────────────────────
  if (process.platform === "linux") {
    try {
      const glib = dlopen("libglib-2.0.so.0", {
        g_timeout_add: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
      });
      const cb = new JSCallback(pollTick, { args: [FFIType.ptr], returns: FFIType.u32 });
      keepAliveCallbacks.add(cb);
      glib.symbols.g_timeout_add(8, cb.ptr, null); // 8 ms ≈ 120 Hz — imperceptible latency
      log.info("async poll: GLib g_timeout_add registered");
      return true;
    } catch (err) {
      log.warn("GLib g_timeout_add unavailable", err);
      return false;
    }
  }

  // ── Windows: Win32 `SetTimer` ─────────────────────────────────────────────
  if (process.platform === "win32") {
    try {
      // TIMERPROC: (HWND, UINT, UINT_PTR, DWORD) -> void. The arguments are
      // ignored: the poll only needs to run on the UI thread, which SetTimer
      // guarantees (the callback is invoked from DispatchMessage).
      const timerProc = (_hwnd: unknown, _msg: unknown, _id: unknown, _time: unknown): void => {
        pollTick(null);
      };
      const user32 = dlopen("user32.dll", {
        // HWND, UINT_PTR (0 = new timer id), UINT (elapse ms), TIMERPROC
        SetTimer: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
          returns: FFIType.ptr,
        },
      });
      const cb = new JSCallback(timerProc, {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.void,
      });
      keepAliveCallbacks.add(cb);
      const timerId = user32.symbols.SetTimer(null, null, 8, cb.ptr);
      if (!timerId) {
        log.warn("Win32 SetTimer returned 0 — falling back to synchronous bridge");
        return false;
      }
      log.info("async poll: Win32 SetTimer registered");
      return true;
    } catch (err) {
      log.warn("Win32 SetTimer unavailable", err);
      return false;
    }
  }

  return false;
}

if (!registerAsyncPoll()) {
  // Fall back to the original synchronous bridge so the app remains functional
  // at the cost of a UI stall (ANR) during long calls.
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

postMessage({ type: "init", buffer });

loadFromCacheOrNetwork("startup");

webview.run();
