import { h, render, type ComponentType } from "preact";
import BASE_STYLES from "./base.css";

export interface Island<P extends object> {
  /** Append this one node wherever the panel belongs. */
  host: HTMLElement;
  /** Re-render the component with new props. */
  update(props: P): void;
  /** Unmount Preact and remove the host. */
  destroy(): void;
}

export interface IslandOptions<P extends object> {
  /** Attribute that marks the host (also handy in devtools). */
  marker: string;
  component: ComponentType<P>;
  props: P;
  /** Panel-specific CSS appended after the shared kit styles. */
  styles?: string;
}

/**
 * Mount a Preact component into a fresh shadow root.
 *
 * The host is the only node duck.ai ever sees. Everything inside is owned by
 * Preact, so updating a panel is just `island.update(nextProps)`.
 */
export function mountIsland<P extends object>(options: IslandOptions<P>): Island<P> {
  const host = document.createElement("div");
  host.setAttribute(options.marker, "");

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BASE_STYLES + (options.styles ?? "");
  const root = document.createElement("div");
  shadow.append(style, root);

  let props = options.props;
  const paint = (): void => {
    const Component = options.component;
    render(h(Component, props), root);
  };

  paint();

  return {
    host,
    update(next) {
      props = next;
      paint();
    },
    destroy() {
      render(null, root);
      host.remove();
    },
  };
}

/** Attach a host to <body>, waiting for it if the document is still parsing. */
export function attachToBody(host: HTMLElement): void {
  if (host.isConnected) return;
  if (document.body) {
    document.body.append(host);
    return;
  }
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      if (!host.isConnected) document.body?.append(host);
    },
    { once: true },
  );
}
