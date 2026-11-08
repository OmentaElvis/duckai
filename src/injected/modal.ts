/**
 * Shared modal chassis for our Shadow-DOM panels (health, tools, …).
 *
 * Owns the host element, a backdrop, an empty card the caller fills, the theme
 * CSS variables (derived from the page background so it matches duck.ai light
 * and dark modes), and the open/close plumbing (backdrop click + Escape).
 */
const BASE_STYLES = `
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483646; display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,.35); backdrop-filter: blur(2px);
  }
  .backdrop.open { display: flex; }
  .card {
    width: 440px; max-width: calc(100vw - 32px); max-height: 72vh; overflow: auto;
    border-radius: 12px; padding: 12px 14px;
    border: 1px solid var(--h-border);
    background: var(--h-bg); color: var(--h-fg);
    box-shadow: 0 20px 60px rgba(0,0,0,.4);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; line-height: 1.45;
  }
  .head { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
  .head .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .head .title { font-weight: 600; flex: 1 1 auto; }
  .head .status { opacity: .6; text-transform: uppercase; font-size: 11px; letter-spacing: .05em; }
  .btn {
    font: inherit; cursor: pointer; border-radius: 7px; padding: 3px 10px;
    border: 1px solid var(--h-border); background: transparent; color: inherit;
  }
  .btn:hover { background: var(--h-hover); }
  .list { display: flex; flex-direction: column; }
  .row { display: flex; gap: 8px; padding: 4px 6px; border-radius: 7px; align-items: baseline; }
  .row:hover { background: var(--h-hover); }
  .sym { flex: none; width: 13px; text-align: center; }
  .sym.ok { color: #63c853; }
  .sym.warn { color: #f0b429; }
  .sym.fail { color: #de5833; }
  .sym.skip { color: #9aa0a6; }
  .lbl { flex: none; }
  .det { opacity: .55; font-size: 12px; word-break: break-word; }
  .footer { margin-top: 10px; opacity: .45; font-size: 11px; }
  .tool { display: flex; gap: 10px; align-items: flex-start; padding: 8px 6px; border-radius: 8px; }
  .tool:hover { background: var(--h-hover); }
  .tool .info { flex: 1 1 auto; min-width: 0; }
  .tool .name { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tool .desc { opacity: .6; font-size: 12px; margin-top: 2px; }
  .tool.off .name, .tool.off .desc { opacity: .45; }
  input[type=checkbox] {
    width: 16px; height: 16px; margin: 3px 0 0; flex: none;
    accent-color: #3969ef; cursor: pointer;
  }
  input[type=checkbox]:disabled { cursor: default; opacity: .5; }
`;

export interface Modal {
  /** Container the caller fills with the header + body. */
  card: HTMLElement;
  /** Append extra styles to this modal's shadow root. */
  addStyles(css: string): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface ModalOptions {
  /** Called whenever the modal is closed (backdrop, Escape, or close()). */
  onClose?: () => void;
}

function luminanceIsDark(): boolean {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (!m) return false;
    const [r = 255, g = 255, b = 255, a = 1] = m[1]!.split(",").map((s) => parseFloat(s));
    if (a === 0) return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  } catch {
    return false;
  }
}

export function createModal(marker: string, options: ModalOptions = {}): Modal {
  const host = document.createElement("div");
  host.setAttribute(`data-duckai-ext-modal-${marker}`, "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = BASE_STYLES;

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  const card = document.createElement("div");
  card.className = "card";
  backdrop.append(card);
  shadow.append(style, backdrop);

  const applyTheme = (): void => {
    const dark = luminanceIsDark();
    host.style.setProperty("--h-bg", dark ? "#1f1f1f" : "#ffffff");
    host.style.setProperty("--h-fg", dark ? "#f2f2f2" : "#1a1a1a");
    host.style.setProperty("--h-border", dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.14)");
    host.style.setProperty("--h-hover", dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)");
  };

  const mount = (): void => {
    if (host.isConnected) return;
    const append = (): void => {
      if (!host.isConnected) document.body?.append(host);
    };
    if (document.body) append();
    else document.addEventListener("DOMContentLoaded", append, { once: true });
  };

  const isOpen = (): boolean => backdrop.classList.contains("open");
  const open = (): void => {
    mount();
    applyTheme();
    backdrop.classList.add("open");
  };
  const close = (): void => {
    const wasOpen = isOpen();
    backdrop.classList.remove("open");
    if (wasOpen) options.onClose?.();
  };

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  return {
    card,
    addStyles(css: string): void {
      const extra = document.createElement("style");
      extra.textContent = css;
      shadow.append(extra);
    },
    open,
    close,
    toggle(): void {
      if (isOpen()) close();
      else open();
    },
    isOpen,
    destroy(): void {
      host.remove();
    },
  };
}
