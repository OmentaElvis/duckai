/**
 * Full-window progress overlay shown while the webview replaces the current
 * document with an updated cached one.
 *
 * A plain page-level loader cannot survive navigation, so the overlay is paired
 * with a short-lived session marker: the page sets it before asking the host to
 * reload, and the next document re-shows the overlay immediately.
 */
import { mountIsland, type Island } from "./ui/mount";

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
  .detail:empty { display: none; }
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

interface OverlayProps {
  visible: boolean;
  label: string;
  detail: string;
}

function Overlay({ visible, label, detail }: OverlayProps) {
  if (!visible) return null;
  return (
    <div class="overlay" role="status" aria-live="polite">
      <div class="spinner" />
      <div class="label">{label}</div>
      <div class="detail">{detail}</div>
    </div>
  );
}

export function mountReloadOverlay(defaults: ReloadOverlayOptions = {}): ReloadOverlay {
  let visible = false;
  let label = defaults.label ?? "Reloading Duck.ai…";
  let detail = defaults.detail ?? "";
  let island: Island<OverlayProps>;

  const paint = (): void => {
    island.host.style.display = visible ? "block" : "none";
    island.update({ visible, label, detail });
  };

  const attach = (): void => {
    if (!visible) return;
    // Prefer <body> once it exists; before that keep the overlay on <html> so
    // it is visible while the new document is still being parsed.
    if (document.body && island.host.parentElement !== document.body) {
      document.body.appendChild(island.host);
      return;
    }
    if (island.host.isConnected) return;
    const parent = document.body ?? document.documentElement;
    if (parent) parent.appendChild(island.host);
    else window.setTimeout(attach, 16);
  };

  island = mountIsland<OverlayProps>({
    marker: OVERLAY_ATTR,
    component: Overlay,
    props: { visible, label, detail },
    styles: STYLES,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }

  return {
    show(opts: ReloadOverlayOptions = {}) {
      visible = true;
      label = opts.label ?? defaults.label ?? "Reloading Duck.ai…";
      detail = opts.detail ?? defaults.detail ?? "";
      paint();
      attach();
    },
    hide() {
      visible = false;
      paint();
    },
  };
}
