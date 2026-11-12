/**
 * Top notification banner alerting the user when an upstream Duck.ai update is available.
 */

export interface UpdateBannerOptions {
  cachedVersion?: string;
  upstreamVersion?: string;
  onReload?: () => void;
  onDismiss?: () => void;
}

export interface UpdateBanner {
  show(opts: UpdateBannerOptions): void;
  hide(): void;
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
  .btn-reload:hover {
    background: #0071e3;
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
  .btn-dismiss:hover {
    color: #fff;
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

  reloadBtn.addEventListener("click", () => {
    activeOpts?.onReload?.();
    location.reload();
  });

  dismissBtn.addEventListener("click", () => {
    activeOpts?.onDismiss?.();
    container.style.display = "none";
  });

  const mount = () => {
    if (!container.parentElement && document.body) {
      document.body.appendChild(container);
    }
  };

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  return {
    show(opts: UpdateBannerOptions) {
      activeOpts = opts;
      mount();
      const versionStr = opts.upstreamVersion
        ? `<span class="version">(${opts.upstreamVersion})</span>`
        : "";
      text.innerHTML = `<span>Duck.ai update ready</span>${versionStr}`;
      container.style.display = "block";
    },
    hide() {
      container.style.display = "none";
    },
  };
}
