import type { CSSProperties } from "preact";
import { useEffect, useState } from "preact/hooks";

/** duck.ai's effective background is dark. Safe outside the DOM. */
export function luminanceIsDark(): boolean {
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

/**
 * Track duck.ai's light/dark mode. The page flips a class on <html> (and may
 * change the body background), so watch both the media query and the theme
 * attributes rather than sampling once at mount.
 */
export function usePageTheme(): boolean {
  const [dark, setDark] = useState<boolean>(luminanceIsDark);

  useEffect(() => {
    const update = (): void => setDark(luminanceIsDark());
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", update);

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      observer = new MutationObserver(update);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }

    return () => {
      mq?.removeEventListener("change", update);
      observer?.disconnect();
    };
  }, []);

  return dark;
}

/** CSS custom properties consumed by the kit and the panels. */
export function themeVars(dark: boolean): CSSProperties {
  return {
    "--h-bg": dark ? "#1f1f1f" : "#ffffff",
    "--h-fg": dark ? "#f2f2f2" : "#1a1a1a",
    "--h-border": dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.14)",
    "--h-hover": dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)",
    "--h-accent": "#3969ef",
  } as CSSProperties;
}
