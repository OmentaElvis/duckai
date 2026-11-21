/** Top notification banner alerting the user when an upstream update is ready. */
import { attachToBody, mountIsland, type Island } from "./ui/mount";

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
  .btn-reload:hover:not(:disabled) { background: #0071e3; }
  .btn-reload:disabled { opacity: 0.65; cursor: default; background: #0a84ff; }
  .btn-dismiss {
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    border: none;
    font-size: 14px;
    cursor: pointer;
    padding: 2px 4px;
    line-height: 1;
  }
  .btn-dismiss:hover:not(:disabled) { color: #fff; }
  .btn-dismiss:disabled { opacity: 0.4; cursor: default; }
`;

interface BannerProps {
  visible: boolean;
  reloading: boolean;
  upstreamVersion?: string;
  onReload: () => void;
  onDismiss: () => void;
}

function Banner({ visible, reloading, upstreamVersion, onReload, onDismiss }: BannerProps) {
  if (!visible) return null;

  return (
    <div class="banner">
      <span class={`dot ${reloading ? "loading" : ""}`} />
      <span class="text">
        <span class="label">
          {reloading ? "Updating Duck.ai…" : "Duck.ai update ready"}
        </span>
        {upstreamVersion ? <span class="version">({upstreamVersion})</span> : null}
      </span>
      <button class="btn-reload" disabled={reloading} onClick={onReload}>
        {reloading ? "Reloading…" : "Reload"}
      </button>
      <button class="btn-dismiss" aria-label="Dismiss" disabled={reloading} onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

export function mountUpdateBanner(): UpdateBanner {
  let visible = false;
  let reloading = false;
  let opts: UpdateBannerOptions | null = null;
  let island: Island<BannerProps>;

  const paint = (): void => {
    island.host.style.display = visible ? "block" : "none";
    island.update({
      visible,
      reloading,
      upstreamVersion: opts?.upstreamVersion,
      onReload: reload,
      onDismiss: dismiss,
    });
  };

  function reload(): void {
    if (reloading) return;
    const run = opts?.onReload;
    if (!run) {
      location.reload();
      return;
    }
    setReloading(true);
    Promise.resolve()
      .then(run)
      .catch(() => {
        // The page-level fallback is preferable to a banner that looks stuck.
        location.reload();
      });
  }

  function dismiss(): void {
    if (reloading) return;
    opts?.onDismiss?.();
    visible = false;
    paint();
  }

  function setReloading(next: boolean): void {
    reloading = next;
    if (next) visible = true;
    paint();
  }

  island = mountIsland<BannerProps>({
    marker: "data-duckai-ext-update-banner",
    component: Banner,
    props: {
      visible,
      reloading,
      upstreamVersion: undefined,
      onReload: reload,
      onDismiss: dismiss,
    },
    styles: STYLES,
  });
  attachToBody(island.host);

  return {
    show(next) {
      opts = next;
      reloading = false;
      visible = true;
      paint();
    },
    hide() {
      visible = false;
      paint();
    },
    setReloading,
  };
}
