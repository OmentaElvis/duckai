/**
 * Native OS-window chrome via GTK4 / WebKitGTK (bun:ffi).
 *
 * All native bindings for the OS window live here so the rest of the app stays
 * free of `bun:ffi`. Linux/GTK only: on other platforms the calls are skipped
 * and the window keeps webview's defaults.
 *
 * Note: GTK calls must run on the thread that owns the GTK main loop — i.e. the
 * webview worker thread, before/while `webview.run()` is active. Styling happens
 * once before `run()`; the input-region nudge is scheduled onto the loop so it
 * fires after the window is mapped.
 */
import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";
import { log } from "./logging/host";

const cstr = (s: string): Pointer => ptr(new TextEncoder().encode(`${s}\0`));

/** GtkStyleProviderPriorities. */
const PRIORITY_APPLICATION = 600;

export interface WindowTheme {
  /** Force GTK widgets (menus, scrollbars, default titlebar) to the dark theme. */
  dark?: boolean;
  /** Corner radius of the window + titlebar, in px. 0 = square. */
  radius?: number;
  /** Backdrop color of the window (also visible during page load). */
  background?: string;
  /** Titlebar background color. */
  titlebarBackground?: string;
  /** Titlebar foreground (title) color. */
  titlebarForeground?: string;
}

/** Anything exposing webview-bun's native window handle. */
export interface NativeWindow {
  unsafeWindowHandle: unknown;
}

/**
 * Style the native window to match the app: dark widgets, square corners, and a
 * titlebar tinted to blend with the page. Best-effort — never throws.
 */
export function applyWindowTheme(webview: NativeWindow, theme: WindowTheme = {}): void {
  if (process.platform !== "linux") return;
  const win = webview.unsafeWindowHandle as unknown as number;
  if (!win) return;

  let gtk: ReturnType<typeof loadGtk>;
  let gobject: ReturnType<typeof loadGobject>;
  try {
    gtk = loadGtk();
    gobject = loadGobject();
  } catch {
    return; // GTK missing (e.g. headless) — keep webview defaults
  }

  if (theme.dark !== undefined) {
    const settings = gtk.symbols.gtk_settings_get_default() as unknown as number;
    if (settings) {
      // g_object_set is variadic; declared with the exact shape we call.
      gobject.symbols.g_object_set(
        settings as never,
        cstr("gtk-application-prefer-dark-theme"),
        theme.dark ? 1 : 0,
        0,
      );
    }
  }

  const radius = theme.radius ?? 0;
  const rules: string[] = [];
  if (theme.background) {
    rules.push(`window.csd, window.csd.background { background-color: ${theme.background}; }`);
  }
  rules.push(`window.csd, window.csd.background { border: none; border-radius: ${radius}px; }`);
  rules.push(
    `headerbar, .titlebar { border-radius: ${radius}px ${radius}px 0 0; background-image: none;`
      + (theme.titlebarBackground ? ` background-color: ${theme.titlebarBackground};` : "")
      + (theme.titlebarForeground ? ` color: ${theme.titlebarForeground};` : "")
      + ` }`,
  );

  const provider = gtk.symbols.gtk_css_provider_new();
  gtk.symbols.gtk_css_provider_load_from_string(provider as never, cstr(rules.join("\n")));
  gtk.symbols.gtk_style_context_add_provider_for_display(
    gtk.symbols.gdk_display_get_default() as never,
    provider as never,
    PRIORITY_APPLICATION,
  );
}

/**
 * GLib callbacks kept alive so they are not garbage-collected while the native
 * main loop still holds a reference to them.
 */
const nudgeCallbacks = new Set<JSCallback>();

/**
 * Heal stale pointer-focus / Wayland input-region state by presenting the window
 * and performing a ±1px no-op resize once it is mapped. Classic workaround for
 * the GTK4/WebKitGTK bug where clicks stop firing (even on the native titlebar)
 * while hover still works. Must be called before `run()`; the nudge runs on the
 * GTK main loop via g_timeout_add. Best-effort — never throws.
 */
export function scheduleWindowNudge(
  webview: NativeWindow,
  delaysMs: readonly number[] = [400, 1200],
): void {
  if (process.platform !== "linux") return;
  const win = webview.unsafeWindowHandle as unknown as number;
  if (!win) return;

  let gtk: ReturnType<typeof loadGtk>;
  let glib: ReturnType<typeof loadGlib>;
  try {
    gtk = loadGtk();
    glib = loadGlib();
  } catch {
    return; // GTK/GLib missing (e.g. headless) — skip
  }

  const nudge = (): number => {
    try {
      gtk.symbols.gtk_window_present(win as never);
      const width = gtk.symbols.gtk_widget_get_width(win as never) as unknown as number;
      const height = gtk.symbols.gtk_widget_get_height(win as never) as unknown as number;
      if (width > 1 && height > 1) {
        gtk.symbols.gtk_window_set_default_size(win as never, width + 1, height + 1);
        gtk.symbols.gtk_window_set_default_size(win as never, width, height);
        log.child("window").debug(`nudge: ${width}x${height}`);
      }
    } catch {
      // best-effort
    }
    return 0; // G_SOURCE_REMOVE: run once
  };

  for (const delay of delaysMs) {
    const callback = new JSCallback(nudge, { args: [FFIType.ptr], returns: FFIType.u32 });
    nudgeCallbacks.add(callback);
    try {
      glib.symbols.g_timeout_add(delay, callback.ptr, null);
    } catch {
      nudgeCallbacks.delete(callback);
    }
  }
}

/**
 * Load HTML directly into the WebKit view with a specific base URI,
 * retaining domain origin (IndexedDB, localStorage, relative assets).
 */
export function loadHtmlWithBase(
  webview: NativeWindow,
  html: string,
  baseUri: string = "https://duck.ai/",
): boolean {
  if (process.platform !== "linux") return false;
  const win = webview.unsafeWindowHandle as unknown as number;
  if (!win) return false;

  try {
    const gtk = loadGtk();
    const child = gtk.symbols.gtk_window_get_child(win as never) as unknown as number;
    if (!child) return false;

    const webkit = loadWebKit();
    webkit.symbols.webkit_web_view_load_html(child as never, cstr(html), cstr(baseUri));
    return true;
  } catch (err) {
    log.child("native").warn("loadHtmlWithBase failed", err instanceof Error ? err.message : err);
    return false;
  }
}

function loadGtk() {
  return dlopen("libgtk-4.so.1", {
    gtk_settings_get_default: { args: [], returns: FFIType.ptr },
    gtk_css_provider_new: { args: [], returns: FFIType.ptr },
    gtk_css_provider_load_from_string: {
      args: [FFIType.ptr, FFIType.cstring],
      returns: FFIType.void,
    },
    gdk_display_get_default: { args: [], returns: FFIType.ptr },
    gtk_style_context_add_provider_for_display: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.void,
    },
    gtk_window_present: { args: [FFIType.ptr], returns: FFIType.void },
    gtk_window_set_default_size: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.void,
    },
    gtk_widget_get_width: { args: [FFIType.ptr], returns: FFIType.i32 },
    gtk_widget_get_height: { args: [FFIType.ptr], returns: FFIType.i32 },
    gtk_window_get_child: { args: [FFIType.ptr], returns: FFIType.ptr },
  });
}

function loadWebKit() {
  const tryLibs = ["libwebkitgtk-6.0.so.4", "libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"];
  for (const name of tryLibs) {
    try {
      return dlopen(name, {
        webkit_web_view_load_html: {
          args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
          returns: FFIType.void,
        },
      });
    } catch {
      // try next
    }
  }
  throw new Error("WebKitGTK library not found");
}

function loadGlib() {
  return dlopen("libglib-2.0.so.0", {
    g_timeout_add: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  });
}

function loadGobject() {
  return dlopen("libgobject-2.0.so.0", {
    g_object_set: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.ptr],
      returns: FFIType.void,
    },
  });
}
