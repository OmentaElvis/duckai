/**
 * Top notification banner alerting the user when an upstream Duck.ai update is available.
 */

export interface UpdateBannerOptions {
  cachedVersion?: string;
  upstreamVersion?: string;
  /** Start the reload. When omitted the banner falls back to `location.reload()`. */
  onReload?: () => void | Promise<void>;
  onDismiss?: () => void;
}

export interface UpdateBanner {
  show(opts: UpdateBannerOptions): void;
  hide(): void;
  /** Reflect an in-progress reload in the banner (spinner + disabled buttons). */
  setReloading(reloading: boolean): void;
}

const STYLES = `
  :host {
    display: none;
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999999;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    animation: slideDown 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes slideDown {
    from { opacity: 0; transform: translate(-50%, -10px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-radius: 9999px;
    background: #1c1c1e;
    color: #f2f2f7;
    border: 1px solid rgba(255, 255, 255, 0.15);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #0a84ff;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  .dot.loading {
    width: 12px;
    height: 12px;
    background: transparent;
    border: 2px solid rgba(255, 255, 255, 0.22);
    border-top-color: #0a84ff;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .text {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .version {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    opacity: 0.8;
  }
  .btn-reload {
    background: #0a84ff;
    color: #fff;
    border: none;
    border-radius: 9999px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-reload:hover:not(:disabled) {
    background: #0071e3;
  }
  .btn-reload:disabled {
    opacity: 0.65;
    cursor: default;
    background: #0a84ff;
  }
  .btn-dismiss {
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    border: none;
    font-size: 14px;
    cursor: pointer;
    padding: 2px 4px;
    line-height: 1;
  }
  .btn-dismiss:hover:not(:disabled) {
    color: #fff;
  }
  .btn-dismiss:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

export function mountUpdateBanner(): UpdateBanner {
  const container = document.createElement("div");
  container.setAttribute("data-duckai-ext-update-banner", "");
  const shadow = container.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const wrapper = document.createElement("div");
  wrapper.className = "banner";

  const dot = document.createElement("span");
  dot.className = "dot";

  const text = document.createElement("span");
  text.className = "text";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Duck.ai update ready";

  const version = document.createElement("span");
  version.className = "version";
  version.hidden = true;

  text.append(label, version);

  const reloadBtn = document.createElement("button");
  reloadBtn.className = "btn-reload";
  reloadBtn.textContent = "Reload";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "btn-dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.innerHTML = "&times;";

  wrapper.append(dot, text, reloadBtn, dismissBtn);
  shadow.append(style, wrapper);

  let activeOpts: UpdateBannerOptions | null = null;
  let busy = false;

  reloadBtn.addEventListener("click", () => {
    if (busy) return;
    const reload = activeOpts?.onReload;
    if (!reload) {
      location.reload();
      return;
    }
    setReloading(true);
    Promise.resolve()
      .then(reload)
      .catch(() => {
        // The page-level fallback is preferable to a banner that looks stuck.
        location.reload();
      });
  });

  dismissBtn.addEventListener("click", () => {
    if (busy) return;
    activeOpts?.onDismiss?.();
    container.style.display = "none";
  });

  let mounted = false;
  const mount = () => {
    mounted = true;
    if (!container.parentElement && document.body) {
      document.body.appendChild(container);
    }
  };

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  function setReloading(reloading: boolean) {
    busy = reloading;
    dot.classList.toggle("loading", reloading);
    reloadBtn.disabled = reloading;
    dismissBtn.disabled = reloading;
    reloadBtn.textContent = reloading ? "Reloading…" : "Reload";
    label.textContent = reloading ? "Updating Duck.ai…" : "Duck.ai update ready";
    if (reloading) {
      if (!mounted) mount();
      container.style.display = "block";
    }
  }

  return {
    show(opts: UpdateBannerOptions) {
      activeOpts = opts;
      setReloading(false);
      mount();
      label.textContent = "Duck.ai update ready";
      if (opts.upstreamVersion) {
        version.textContent = `(${opts.upstreamVersion})`;
        version.hidden = false;
      } else {
        version.textContent = "";
        version.hidden = true;
      }
      container.style.display = "block";
    },
    hide() {
      container.style.display = "none";
    },
    setReloading,
  };
}
