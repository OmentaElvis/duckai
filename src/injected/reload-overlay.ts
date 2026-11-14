/**
 * Full-window progress overlay shown while the webview is replacing the
 * current document with an updated cached one.
 *
 * A plain page-level loader cannot survive navigation: the old document is torn
 * down while WebKit may keep showing its last frame, and the new document is
 * blank until it paints. The overlay is therefore paired with a short-lived
 * session marker — the page sets it before asking the host to reload, and the
 * next document re-shows the overlay immediately so the user sees continuous
 * progress instead of a frozen window.
 */

const OVERLAY_ATTR = "data-duckai-ext-reload-overlay";
const MARKER_KEY = "duckai-ext:reload-marker";
/** Ignore markers older than this (e.g. left behind by an interrupted reload). */
export const RELOAD_MARKER_MAX_AGE_MS = 60_000;

export interface ReloadMarker {
  at: number;
  upstreamVersion?: string;
  label?: string;
  /** Page that started the reload; used to avoid showing the overlay after a cross-origin navigation. */
  href?: string;
}

export interface ReloadOverlayOptions {
  label?: string;
  detail?: string;
}

export interface ReloadOverlay {
  show(opts?: ReloadOverlayOptions): void;
  hide(): void;
}

const STYLES = `
  :host {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f2f2f7;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: #161616;
  }
  .spinner {
    width: 26px;
    height: 26px;
    box-sizing: border-box;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.16);
    border-top-color: #0a84ff;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .label {
    font-size: 14px;
    font-weight: 500;
  }
  .detail {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    opacity: 0.55;
  }
  .detail:empty {
    display: none;
  }
`;

/** Record that a reload is about to start. Safe to call outside the DOM. */
export function markReloading(
  upstreamVersion?: string,
  href?: string,
  label?: string,
): ReloadMarker {
  const marker: ReloadMarker = { at: Date.now() };
  if (upstreamVersion) marker.upstreamVersion = upstreamVersion;
  if (href) marker.href = href;
  if (label) marker.label = label;
  try {
    sessionStorage.setItem(MARKER_KEY, JSON.stringify(marker));
  } catch {
    /* storage unavailable — the overlay still runs in the old document */
  }
  return marker;
}

/** Remove the reload marker once the new document is interactive again. */
export function clearReloadMarker(): void {
  try {
    sessionStorage.removeItem(MARKER_KEY);
  } catch {
    /* ignore */
  }
}

/** Read and consume the marker left by the previous document. */
export function consumeReloadMarker(
  maxAgeMs = RELOAD_MARKER_MAX_AGE_MS,
): ReloadMarker | null {
  try {
    const raw = sessionStorage.getItem(MARKER_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MARKER_KEY);
    const parsed = JSON.parse(raw) as Partial<ReloadMarker>;
    if (typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > maxAgeMs) return null;
    return {
      at: parsed.at,
      ...(typeof parsed.upstreamVersion === "string"
        ? { upstreamVersion: parsed.upstreamVersion }
        : {}),
      ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
      ...(typeof parsed.href === "string" ? { href: parsed.href } : {}),
    };
  } catch {
    return null;
  }
}

export function mountReloadOverlay(defaults: ReloadOverlayOptions = {}): ReloadOverlay {
  const container = document.createElement("div");
  container.setAttribute(OVERLAY_ATTR, "");
  const shadow = container.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");

  const spinner = document.createElement("div");
  spinner.className = "spinner";

  const label = document.createElement("div");
  label.className = "label";

  const detail = document.createElement("div");
  detail.className = "detail";

  overlay.append(spinner, label, detail);
  shadow.append(style, overlay);

  let visible = false;

  const attach = () => {
    if (!visible) return;
    // Prefer <body> once it exists; before that keep the overlay on <html> so
    // it is visible while the new document is still being parsed.
    if (document.body && container.parentElement !== document.body) {
      document.body.appendChild(container);
      return;
    }
    if (container.isConnected) return;
    const parent = document.body ?? document.documentElement;
    if (parent) parent.appendChild(container);
    else window.setTimeout(attach, 16);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }

  return {
    show(opts: ReloadOverlayOptions = {}) {
      visible = true;
      label.textContent = opts.label ?? defaults.label ?? "Reloading Duck.ai…";
      detail.textContent = opts.detail ?? defaults.detail ?? "";
      container.style.display = "block";
      attach();
    },
    hide() {
      visible = false;
      container.style.display = "none";
    },
  };
}