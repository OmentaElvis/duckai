/**
 * External link interceptor: routes outside and target="_blank" links to the
 * user's default browser instead of dropping them or navigating inside the webview.
 */
import { callHarnessSafe } from "./bridge";

/**
 * Determine if a URL should open in the system default browser.
 */
export function isExternalUrl(
  urlStr: string,
  target?: string | null,
  currentOrigin?: string,
): boolean {
  if (!urlStr || urlStr.startsWith("javascript:") || urlStr.startsWith("#")) {
    return false;
  }
  try {
    const loc = typeof window !== "undefined" && window.location ? window.location : null;
    const base = loc?.href || "https://duck.ai/";
    const origin = currentOrigin ?? (loc?.origin || "https://duck.ai");
    const parsed = new URL(urlStr, base);
    if (parsed.protocol === "mailto:") {
      return true;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    // Any target="_blank" link cannot open in a new tab in a single-window app
    if (target === "_blank") {
      return true;
    }
    // External origin (different host/domain)
    if (parsed.origin !== origin) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Install DOM click capture and window.open hooks to forward external links
 * to the Bun host bridge via `openUrl`.
 */
export function installExternalLinkInterceptor(): void {
  const handleLinkClick = (e: MouseEvent): void => {
    // Only handle primary (left) click or middle click (auxclick)
    if (e.defaultPrevented) return;
    if (e.button !== 0 && e.button !== 1) return;

    // Check if clicked element or any ancestor in the event path is an anchor
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    let anchor: HTMLAnchorElement | null = null;
    for (const node of path) {
      if (node instanceof HTMLElement && node.tagName.toLowerCase() === "a") {
        anchor = node as HTMLAnchorElement;
        break;
      }
    }
    if (!anchor) {
      const target = e.target as HTMLElement | null;
      anchor = target?.closest?.("a") ?? null;
    }

    if (!anchor) return;
    const href = anchor.href || anchor.getAttribute("href");
    if (!href) return;

    // Ctrl+click or Cmd+click also signifies wanting an external/new tab
    const forceNew = e.ctrlKey || e.metaKey || anchor.target === "_blank";
    if (isExternalUrl(href, forceNew ? "_blank" : anchor.target)) {
      e.preventDefault();
      e.stopPropagation();
      callHarnessSafe("openUrl", { url: href });
    }
  };

  document.addEventListener("click", handleLinkClick, true);
  document.addEventListener("auxclick", handleLinkClick, true);

  if (typeof window !== "undefined") {
    const origOpen = window.open;
    window.open = function (
      url?: string | URL,
      target?: string,
      features?: string,
    ): Window | null {
      const urlStr = typeof url === "string" ? url : url ? url.toString() : "";
      if (urlStr && isExternalUrl(urlStr, target ?? "_blank")) {
        callHarnessSafe("openUrl", { url: urlStr });
        return null;
      }
      return origOpen ? origOpen.call(window, url, target, features) : null;
    };
  }
}
