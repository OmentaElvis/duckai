/**
 * Chat composer harness toggle button.
 *
 * Injects a toggle button into Duck.ai's chat composer toolbar (next to the
 * native tools/attach buttons) allowing the user to turn off the DuckAI harness
 * for the current chat session.
 *
 * When disabled:
 *   - No tool instructions or schemas are injected into the user prompt or messages.
 *   - The context window is completely spared from prompt overhead.
 *   - Tool supervision and synthetic event splicing are bypassed.
 */
import { log as rootLog } from "./log";
import { assistantElements, conversationIdOf } from "./ui";

const log = rootLog.child("toggle");

const STORAGE_KEY = "duckai-ext:disabled-harness-chats";
const WRAPPER_ATTR = "data-duckai-ext-harness-wrapper";
const BUTTON_ATTR = "data-duckai-ext-harness-toggle";

/**
 * Plugs connected (with sparks) icon for the enabled harness state.
 */
const SVG_PLUG_ON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="20" height="20" fill="currentColor" color="currentColor" aria-hidden="true" style="pointer-events:none;display:block">
  <rect width="256" height="256" fill="none"/>
  <path d="M88.57,35A8,8,0,0,1,103.43,29l8,20A8,8,0,0,1,96.57,55ZM29,103.43l20,8A8,8,0,1,0,55,96.57l-20-8A8,8,0,0,0,29,103.43ZM227,152.57l-20-8A8,8,0,1,0,201,159.43l20,8A8,8,0,0,0,227,152.57ZM159.43,201A8,8,0,0,0,144.57,207l8,20A8,8,0,1,0,167.43,221ZM237.91,18.52a8,8,0,0,0-11.5-.18L174,70.75l-5.38-5.38a32,32,0,0,0-45.28,0L106.14,82.54a4,4,0,0,0,0,5.66l61.7,61.66a4,4,0,0,0,5.66,0l16.74-16.74a32.76,32.76,0,0,0,9.81-22.52,31.82,31.82,0,0,0-9.37-23.17l-5.38-5.37,52.2-52.17A8.22,8.22,0,0,0,237.91,18.52ZM85.64,90.34a8,8,0,0,0-11.49.18,8.22,8.22,0,0,0,.41,11.37L80.67,108,65.34,123.31A31.82,31.82,0,0,0,56,146.47,32.75,32.75,0,0,0,65.77,169l5,4.94L18.49,226.13a8.21,8.21,0,0,0-.61,11.1,8,8,0,0,0,11.72.43L82,185.25l5.37,5.38a32.1,32.1,0,0,0,45.29,0L148,175.31l6.34,6.35a8,8,0,0,0,11.32-11.32Z"/>
</svg>
`.trim();

/**
 * Plugs disconnected icon for the disabled harness state.
 */
const SVG_PLUG_OFF = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="20" height="20" color="currentColor" aria-hidden="true" style="pointer-events:none;display:block">
  <rect width="256" height="256" fill="none"/>
  <line x1="144" y1="144" x2="120" y2="168" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <line x1="144" y1="144" x2="120" y2="168" fill="#231f20"/>
  <line x1="112" y1="112" x2="88" y2="136" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <line x1="112" y1="112" x2="88" y2="136" fill="#231f20"/>
  <line x1="64" y1="112" x2="144" y2="192" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <line x1="58.06" y1="197.94" x2="24" y2="232" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <path d="M132,180l-29,29a24,24,0,0,1-33.94,0L47,186.91A24,24,0,0,1,47,153l29-29" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <line x1="112" y1="64" x2="192" y2="144" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <line x1="197.94" y1="58.06" x2="232" y2="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
  <path d="M180,132l29-29a24,24,0,0,0,0-33.94L186.91,47A24,24,0,0,0,153,47L124,76" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
</svg>
`.trim();

/** Conversation IDs explicitly disabled in this browser session. */
let memoryDisabledChats = new Set<string>();

/** Whether a fresh chat (before conversationId is established) has the harness disabled. */
let newChatHarnessDisabled = false;

/** Tracks rendered state to prevent destroying DOM nodes on every mutation. */
let lastRenderedState: boolean | null = null;

let activeBtn: HTMLButtonElement | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function loadDisabledChats(): Set<string> {
  const store = storage();
  if (!store) return memoryDisabledChats;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    /* ignore corrupt storage */
  }
  return new Set();
}

export function saveDisabledChats(chats: Set<string>): void {
  memoryDisabledChats = chats;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify([...chats]));
  } catch {
    /* ignore */
  }
}

/** Resolve the active conversation ID from the DOM if available. */
export function getCurrentConversationId(): string | null {
  if (typeof document === "undefined") return null;
  const els = assistantElements();
  if (els.length > 0) {
    const last = els[els.length - 1];
    return last ? conversationIdOf(last.id) : null;
  }
  return null;
}

/** Check whether the DuckAI harness is active for the current chat. */
export function isHarnessEnabled(): boolean {
  const convId = getCurrentConversationId();
  if (convId) {
    const disabled = loadDisabledChats();
    return !disabled.has(convId);
  }
  return !newChatHarnessDisabled;
}

/** Toggle the harness state for the current chat and refresh the UI. */
export function toggleHarness(): boolean {
  lastRenderedState = null;
  const convId = getCurrentConversationId();
  if (convId) {
    const disabled = loadDisabledChats();
    if (disabled.has(convId)) {
      disabled.delete(convId);
    } else {
      disabled.add(convId);
    }
    saveDisabledChats(disabled);
    updateToggleUi();
    return !disabled.has(convId);
  } else {
    newChatHarnessDisabled = !newChatHarnessDisabled;
    updateToggleUi();
    return !newChatHarnessDisabled;
  }
}

/** Explicitly set the harness enabled state (useful for tests or programmatic toggling). */
export function setHarnessEnabled(enabled: boolean): void {
  lastRenderedState = null;
  const convId = getCurrentConversationId();
  if (convId) {
    const disabled = loadDisabledChats();
    if (enabled) disabled.delete(convId);
    else disabled.add(convId);
    saveDisabledChats(disabled);
  } else {
    newChatHarnessDisabled = !enabled;
  }
  updateToggleUi();
}

/** Reset internal state (for testing). */
export function resetHarnessState(): void {
  memoryDisabledChats.clear();
  newChatHarnessDisabled = false;
  lastRenderedState = null;
  const store = storage();
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {}
  }
}

export function updateToggleUi(): void {
  // If we had disabled a fresh chat and now a conversation ID has appeared, bind it.
  const convId = getCurrentConversationId();
  if (convId && newChatHarnessDisabled) {
    const disabled = loadDisabledChats();
    disabled.add(convId);
    saveDisabledChats(disabled);
    newChatHarnessDisabled = false;
  }

  if (!activeBtn || !activeBtn.isConnected) return;

  const enabled = isHarnessEnabled();
  // Avoid re-rendering innerHTML when state has not changed (prevents dropped click events)
  if (lastRenderedState === enabled) return;
  lastRenderedState = enabled;

  if (enabled) {
    activeBtn.innerHTML = SVG_PLUG_ON;
    activeBtn.style.opacity = "1";
    activeBtn.setAttribute("aria-label", "DuckAI Harness: ON");
    activeBtn.setAttribute(
      "title",
      "DuckAI Harness: ON (Tools active: click to disable for this chat)",
    );
  } else {
    activeBtn.innerHTML = SVG_PLUG_OFF;
    activeBtn.style.color = "currentColor";
    activeBtn.style.opacity = "0.38";
    activeBtn.setAttribute("aria-label", "DuckAI Harness: OFF");
    activeBtn.setAttribute(
      "title",
      "DuckAI Harness: OFF (No prompt overhead: click to enable for this chat)",
    );
  }
}

function buildButton(): HTMLElement {
  const container = document.createElement("div");
  container.className = "kA2MKp5M8ljmhGE_061Q";
  container.setAttribute(WRAPPER_ATTR, "");
  container.style.display = "inline-flex";
  container.style.alignItems = "center";
  container.style.justifyContent = "center";

  const btn = document.createElement("button");
  btn.type = "button";
  // Native icon button styling
  btn.className = "mDfTLfECeDUwedENpz0Z rpUl9U1eM_BmhYCtUbPZ TKIZtIRPfmARlavLmuvJ";
  btn.setAttribute(BUTTON_ATTR, "");
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.style.width = "32px";
  btn.style.height = "32px";
  btn.style.padding = "0";
  btn.style.margin = "0";
  btn.style.border = "none";
  btn.style.background = "transparent";
  btn.style.cursor = "pointer";
  btn.style.borderRadius = "8px";
  btn.style.boxSizing = "border-box";
  btn.style.flexShrink = "0";
  btn.style.transition = "color 0.15s ease, opacity 0.15s ease";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const nowEnabled = toggleHarness();
    log.info(`toggled harness: ${nowEnabled ? "ON" : "OFF"}`);
  });

  container.appendChild(btn);
  activeBtn = btn;
  lastRenderedState = null;
  updateToggleUi();
  return container;
}

function ensureButton(): void {
  const composer = document.querySelector('[data-testid="duckai-chat-input"]');
  if (!composer) {
    activeBtn = null;
    lastRenderedState = null;
    return;
  }

  const existingWrapper = composer.querySelector(`[${WRAPPER_ATTR}]`);
  if (existingWrapper) {
    const btn = existingWrapper.querySelector<HTMLButtonElement>(`[${BUTTON_ATTR}]`);
    if (btn) {
      if (activeBtn !== btn) {
        activeBtn = btn;
        lastRenderedState = null;
      }
      updateToggleUi();
    }
    return;
  }

  // Anchor next to Duck.ai's native tools button or attach button.
  const toolsBtn = composer.querySelector('[data-testid="duckai-tools-button"]');
  const attachBtn = composer.querySelector('[data-testid="duckai-attach-button"]');
  const anchor =
    toolsBtn?.closest(".kA2MKp5M8ljmhGE_061Q") ??
    attachBtn?.closest(".kA2MKp5M8ljmhGE_061Q");

  const newElement = buildButton();
  if (anchor && anchor.parentElement) {
    anchor.parentElement.insertBefore(newElement, anchor.nextSibling);
    log.debug("composer toggle mounted beside tools button");
  } else {
    const toolbar = composer.querySelector('[class*="G0uGqFxHNxeLERdcIVSP"]') ?? composer;
    toolbar.appendChild(newElement);
    log.debug("composer toggle mounted via fallback toolbar");
  }
}

let observer: MutationObserver | null = null;
let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (scheduleTimer !== null) return;
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    try {
      ensureButton();
    } catch (err) {
      log.warn("composer toggle mount failed", String(err));
    }
  }, 40);
}

export function mountComposerToggle(): { destroy(): void; update(): void } {
  if (typeof document === "undefined") {
    return { destroy: () => {}, update: () => {} };
  }

  if (!observer) {
    try {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) {
      log.warn("composer toggle observer failed", String(err));
    }
  }

  schedule();
  return {
    destroy() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      activeBtn?.closest(`[${WRAPPER_ATTR}]`)?.remove();
      activeBtn = null;
      lastRenderedState = null;
    },
    update: updateToggleUi,
  };
}
