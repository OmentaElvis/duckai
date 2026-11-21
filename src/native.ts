/**
 * Native OS-window chrome via GTK4 / WebKitGTK and Win32 (bun:ffi).
 *
 * All native bindings for the OS window live here so the rest of the app stays
 * free of `bun:ffi`. GTK styling is Linux-only; the Windows path only assigns
 * the window icon (`--windows-icon` brands the .exe file, not the window).
 * Other platforms keep webview's defaults.
 *
 * Note: GTK calls must run on the thread that owns the GTK main loop — i.e. the
 * webview worker thread, before/while `webview.run()` is active. Styling happens
 * once before `run()`; the input-region nudge is scheduled onto the loop so it
 * fires after the window is mapped.
 */
import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logging/host";

const cstr = (s: string): Pointer => ptr(new TextEncoder().encode(`${s}\0`));

/** UTF-16LE null-terminated string for Win32 `...W` APIs. */
const wstr = (s: string): Pointer => {
  const bytes = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return ptr(bytes);
};

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
 * Initialize Linux / GTK application identity early before any window is created.
 *
 * GNOME Shell (Wayland & X11) matches running windows to their desktop entry via
 * `app_id` (Wayland) and `WM_CLASS` (X11). GTK derives both from GLib's `prgname`.
 * Setting this to "duckai" ensures GNOME Shell matches the window to `duckai.desktop`
 * so Alt-Tab and the App Switcher display the application icon instead of a generic fallback.
 */
export function initLinuxApp(): void {
  if (process.platform !== "linux") return;
  try {
    const glib = loadGlib();
    glib.symbols.g_set_prgname(cstr("duckai"));
    glib.symbols.g_set_application_name(cstr("Duck.ai"));
  } catch {
    // GLib missing or failed
  }
}

/**
 * Assign the executable's icon to the OS window.
 *
 * On Linux: sets the GTK window icon name to "duckai" and registers the assets
 * folder as a search path so portable/dev runs find the icon even if the package
 * is not installed under /usr/share/icons.
 *
 * On Windows: `webview` creates its window with no icon, so Windows draws its default
 * placeholder in the titlebar and falls back to the process icon in the
 * taskbar. `bun build --windows-icon` only brands the `.exe` file itself, so
 * the running window must be told explicitly.
 *
 * We query per-monitor DPI to extract exact crisp dimensions matching the
 * display scaling (via `PrivateExtractIconsW`) rather than legacy fixed 32/16
 * metrics from `ExtractIconExW`. Both window instance and class icons are set,
 * and the process AppUserModelID is registered so taskbar grouping matches.
 * Best-effort; never throws.
 */
export function applyWindowIcon(webview: NativeWindow): void {
  if (process.platform === "linux") {
    const win = webview.unsafeWindowHandle as unknown as number;
    if (!win) return;
    try {
      const gtk = loadGtk();
      gtk.symbols.gtk_window_set_default_icon_name(cstr("duckai"));
      gtk.symbols.gtk_window_set_icon_name(win as never, cstr("duckai"));

      const display = gtk.symbols.gdk_display_get_default() as unknown as number;
      if (display) {
        const theme = gtk.symbols.gtk_icon_theme_get_for_display(display as never) as unknown as number;
        if (theme) {
          const candidates = [
            join(dirname(process.execPath), "assets"),
            join(process.cwd(), "assets"),
          ];
          for (const cand of candidates) {
            if (existsSync(cand)) {
              gtk.symbols.gtk_icon_theme_add_search_path(theme as never, cstr(cand));
            }
          }
        }
      }
      log.child("window").info("linux window icon applied (duckai)");
    } catch (err) {
      log.child("window").warn("linux window icon failed", err instanceof Error ? err.message : err);
    }
    return;
  }

  if (process.platform !== "win32") return;
  const hwnd = webview.unsafeWindowHandle as unknown as number;
  if (!hwnd) return;

  try {
    const shell32 = loadShell32();
    const user32 = loadUser32();
    const dpiLib = loadUser32Dpi();

    let dpi = 96;
    try {
      dpi = dpiLib?.symbols.GetDpiForWindow(hwnd as never) || 96;
    } catch {}

    let cxSmall = 16;
    let cySmall = 16;
    let cxLarge = 32;
    let cyLarge = 32;

    if (dpiLib && dpi > 96) {
      try {
        cxSmall = dpiLib.symbols.GetSystemMetricsForDpi(49, dpi);
        cySmall = dpiLib.symbols.GetSystemMetricsForDpi(50, dpi);
        cxLarge = dpiLib.symbols.GetSystemMetricsForDpi(11, dpi);
        cyLarge = dpiLib.symbols.GetSystemMetricsForDpi(12, dpi);
      } catch {}
    } else {
      try {
        cxSmall = user32.symbols.GetSystemMetrics(49);
        cySmall = user32.symbols.GetSystemMetrics(50);
        cxLarge = user32.symbols.GetSystemMetrics(11);
        cyLarge = user32.symbols.GetSystemMetrics(12);
      } catch {}
    }

    const hiconLarge = new BigUint64Array(1);
    const hiconSmall = new BigUint64Array(1);
    const iconId = new Uint32Array(1);

    const tryExtract = (targetPath: string) => {
      const p = wstr(targetPath);
      // For large icons (taskbar & Alt-Tab), request at least 48px so Windows
      // downsamples from a crisp frame rather than upscaling 32px.
      const l = user32.symbols.PrivateExtractIconsW(
        p,
        0,
        Math.max(cxLarge, 48),
        Math.max(cyLarge, 48),
        ptr(hiconLarge),
        ptr(iconId),
        1,
        0,
      ) as unknown as number;
      const s = user32.symbols.PrivateExtractIconsW(
        p,
        0,
        cxSmall,
        cySmall,
        ptr(hiconSmall),
        ptr(iconId),
        1,
        0,
      ) as unknown as number;
      return l > 0 || s > 0;
    };

    let extracted = tryExtract(process.execPath);
    if (!extracted) {
      const candidates = [
        join(dirname(process.execPath), "duckai.ico"),
        join(dirname(process.execPath), "assets", "duckai.ico"),
        join(process.cwd(), "assets", "duckai.ico"),
      ];
      for (const cand of candidates) {
        if (existsSync(cand) && tryExtract(cand)) {
          extracted = true;
          break;
        }
      }
    }

    if (!extracted) {
      log.child("window").warn("window icon: executable or assets contain no icon");
      return;
    }

    const WM_SETICON = 0x0080;
    const ICON_BIG = 1;
    const ICON_SMALL = 0;
    const GCLP_HICON = -14;
    const GCLP_HICONSM = -34;

    const big = hiconLarge[0];
    const small = hiconSmall[0];

    if (big) {
      user32.symbols.SendMessageW(hwnd as never, WM_SETICON, ICON_BIG as never, big as never);
      try {
        user32.symbols.SetClassLongPtrW(hwnd as never, GCLP_HICON, big as never);
      } catch {}
    }
    if (small) {
      user32.symbols.SendMessageW(hwnd as never, WM_SETICON, ICON_SMALL as never, small as never);
      try {
        user32.symbols.SetClassLongPtrW(hwnd as never, GCLP_HICONSM, small as never);
      } catch {}
    }

    try {
      shell32.symbols.SetCurrentProcessExplicitAppUserModelID(wstr("DuckAI"));
    } catch {}

    log.child("window").info("window icon applied (DPI=" + dpi + ")");
  } catch (err) {
    log.child("window").warn("window icon failed", err instanceof Error ? err.message : err);
  }
}

/**
 * Open a URL in the user's default web browser. Best-effort; never throws.
 */
export function openExternalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
      log.child("native").warn("openExternalUrl: rejected protocol", parsed.protocol);
      return false;
    }
    const cleanUrl = parsed.toString();

    if (process.platform === "win32") {
      try {
        const shell32 = loadShell32();
        const res = shell32.symbols.ShellExecuteW(
          null as never,
          wstr("open"),
          wstr(cleanUrl),
          null as never,
          null as never,
          1,
        ) as unknown as number;
        if (Number(res) > 32) {
          log.child("native").info("opened external url (ShellExecuteW):", cleanUrl);
          return true;
        }
      } catch (err) {
        log.child("native").debug("ShellExecuteW failed, falling back to cmd", String(err));
      }
      Bun.spawn(["cmd.exe", "/c", "start", "", cleanUrl], {
        windowsHide: true,
        stdout: "ignore",
        stderr: "ignore",
      });
      log.child("native").info("opened external url (cmd):", cleanUrl);
      return true;
    }

    if (process.platform === "darwin") {
      Bun.spawn(["open", cleanUrl], { stdout: "ignore", stderr: "ignore" });
      log.child("native").info("opened external url (macOS):", cleanUrl);
      return true;
    }

    // Linux / default
    Bun.spawn(["xdg-open", cleanUrl], { stdout: "ignore", stderr: "ignore" });
    log.child("native").info("opened external url (Linux):", cleanUrl);
    return true;
  } catch (err) {
    log.child("native").warn("openExternalUrl failed", err instanceof Error ? err.message : err);
    return false;
  }
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
    gtk_window_set_default_icon_name: { args: [FFIType.ptr], returns: FFIType.void },
    gtk_window_set_icon_name: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    gtk_icon_theme_get_for_display: { args: [FFIType.ptr], returns: FFIType.ptr },
    gtk_icon_theme_add_search_path: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
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
    g_set_prgname: { args: [FFIType.ptr], returns: FFIType.void },
    g_set_application_name: { args: [FFIType.ptr], returns: FFIType.void },
  });
}

function loadShell32() {
  return dlopen("shell32.dll", {
    ExtractIconExW: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    SetCurrentProcessExplicitAppUserModelID: {
      args: [FFIType.ptr],
      returns: FFIType.u32,
    },
    ShellExecuteW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.ptr,
    },
  });
}

function loadUser32() {
  return dlopen("user32.dll", {
    SendMessageW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u64],
      returns: FFIType.ptr,
    },
    PrivateExtractIconsW: {
      args: [
        FFIType.ptr,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
      ],
      returns: FFIType.u32,
    },
    GetSystemMetrics: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    SetClassLongPtrW: {
      args: [FFIType.ptr, FFIType.i32, FFIType.u64],
      returns: FFIType.u64,
    },
  });
}

function loadUser32Dpi() {
  try {
    return dlopen("user32.dll", {
      GetDpiForWindow: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetSystemMetricsForDpi: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    });
  } catch {
    return null;
  }
}

function loadGobject() {
  return dlopen("libgobject-2.0.so.0", {
    g_object_set: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.ptr],
      returns: FFIType.void,
    },
  });
}
