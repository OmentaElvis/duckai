/** Top notification banner alerting the user when an upstream update is ready. */
import { attachToBody, mountIsland, type Island } from "./ui/mount";
import STYLES from "./update-banner.css";

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
