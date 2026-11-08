/**
 * Injects entries into duck.ai's *Settings & More* menu.
 *
 * The menu is rendered on demand and its DOM/classes are transient (CSS-module
 * hashes change between builds), so we key off the stable
 * `[data-testid="settings-button"]` anchor and clone that live button for native
 * styling instead of hard-coding markup. A single shared observer keeps all
 * registered entries mounted across menu re-renders.
 */
import { log } from "./log";

export interface SettingsEntry {
  destroy(): void;
}

export interface SettingsEntryOptions {
  /** Stable id; also used as the entry marker attribute. */
  id: string;
  label: string;
  /** Invoked when the user activates the entry. */
  onOpen: () => void;
  /** Append a leading icon (e.g. a status dot) to the label container. */
  renderIcon?: (label: HTMLElement) => void;
}

interface Entry extends SettingsEntryOptions {
  el: HTMLElement | null;
}

const SETTINGS_SELECTOR = '[data-testid="settings-button"]';
const entries: Entry[] = [];
let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const markerFor = (id: string): string => `data-duckai-ext-menu-${id}`;

function build(settings: HTMLElement, entry: Entry): HTMLElement {
  const el = settings.cloneNode(true) as HTMLElement;
  el.removeAttribute("data-testid");
  el.removeAttribute("aria-expanded");
  el.setAttribute(markerFor(entry.id), "");
  const label = el.querySelector("div") ?? el;
  label.textContent = "";
  entry.renderIcon?.(label);
  label.append(document.createTextNode(entry.label));
  el.addEventListener("click", (e) => {
    e.preventDefault();
    entry.onOpen();
  });
  return el;
}

function ensure(): void {
  const settings = document.querySelector<HTMLElement>(SETTINGS_SELECTOR);
  if (!settings) {
    for (const entry of entries) entry.el = null;
    return;
  }
  const container = settings.parentElement;
  if (!container) return;
  for (const entry of entries) {
    const marker = markerFor(entry.id);
    if (entry.el?.isConnected) continue;
    const existing = container.querySelector<HTMLElement>(`[${marker}]`);
    if (existing) {
      entry.el = existing;
      continue;
    }
    entry.el = build(settings, entry);
    container.append(entry.el);
    log.debug(`settings menu entry injected: ${entry.id}`);
  }
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      ensure();
    } catch (err) {
      log.warn("settings menu injection failed", String(err));
    }
  }, 40);
}

function start(): void {
  if (observer) return;
  try {
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (err) {
    log.warn("settings menu observer failed", String(err));
  }
  schedule();
}

export function mountSettingsEntry(opts: SettingsEntryOptions): SettingsEntry {
  const entry: Entry = { ...opts, el: null };
  entries.push(entry);
  start();
  ensure();
  return {
    destroy(): void {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      entry.el?.remove();
      entry.el = null;
      if (entries.length === 0) {
        observer?.disconnect();
        observer = null;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
    },
  };
}
