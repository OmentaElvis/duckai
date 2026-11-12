/**
 * Custom widget layer: renders our (client-executed) tool calls inside the
 * duck.ai assistant message, mirroring how native tool cards appear.
 *
 * Why DOM injection instead of synthetic SSE events: the duck.ai reducer has a
 * hard render gate (`Ap = Set(WebSearch, SearchResults, …)`) and drops any
 * `tool-invocation` for an unknown tool name, so our synthetic events never
 * make it to the screen. We therefore own the presentation ourselves.
 *
 * Reliability notes (learned from live DOM reconnaissance):
 *   - Each assistant turn is `div[id="{conv}-assistant-message-{turn}-{part}"]`.
 *     The newest turn is the last such node in DOM order; we latch the first
 *     unclaimed one so concurrent/subsequent turns never fight over an element.
 *   - The message element is React-owned. We only ever append a single host
 *     node and re-assert it from a MutationObserver if React prunes it.
 *   - Styles live in a Shadow DOM so neither side can leak into the other, but
 *     duck.ai's design tokens (CSS custom properties) inherit across the
 *     shadow boundary — so our cards theme themselves for light/dark for free.
 */
import { log as rootLog } from "./log";
import {
  loadHistory,
  recordEnd,
  recordStart,
  type StoredCall,
} from "./tool-history";
import {
  callBody,
  callSummary,
  type RenderBlock,
  type ToolCallView,
} from "./tool-render";
import { SLOT_SENTINEL_RE_SOURCE } from "../protocol";

const log = rootLog.child("ui");

export type { RenderBlock, ToolCallView, ToolStatus, ToolView } from "./tool-render";

/** Marks a response element as claimed by a specific UI controller. */
export const UI_CLAIM_ATTR = "data-duckai-ext-ui";
/** Marks our host node (useful for debugging and for the observer). */
export const UI_HOST_ATTR = "data-duckai-ext-host";

/** Tools normally take well under this; cards never render unbounded text. */
const MAX_TEXT = 4000;

export interface ToolUiCallbacks {
  /** Called when a tool call begins. */
  onToolStart?: (call: { id: string; name: string; arguments: unknown }) => void;
  /** Called when a tool call finishes (result on success, message on error). */
  onToolEnd?: (call: { id: string; name: string; result: string; error?: string }) => void;
}

export interface ToolUi {
  start(id: string, name: string, args: unknown, slotId?: string): void;
  finish(id: string, name: string, result: string, error?: string): void;
  /** Render previously-persisted calls (used when rehydrating after a reload). */
  restore(calls: StoredCall[]): void;
  dispose(): void;
}

export interface ToolUiOptions {
  /** Where to search for the assistant message (defaults to `document`). */
  root?: ParentNode;
  /** Pin the controller to a specific message instead of auto-latching the newest. */
  target?: HTMLElement;
  /** Persist calls to the sidecar history store (defaults to `true`). */
  persist?: boolean;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `duckai-ui-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `b24e…-assistant-message-3-1` → `{ turn: 3, part: 1 }` (null when absent). */
export function parseAssistantId(id: string): { turn: number; part: number } | null {
  const m = /-assistant-message-(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { turn: Number(m[1]), part: Number(m[2]) };
}

/**
 * The conversation id encoded in a message wrapper id:
 * `b24e…-assistant-message-3-1` → `b24e…` (null when the id doesn't match).
 * Stable across reloads, so it is our persistence key.
 */
export function conversationIdOf(id: string): string | null {
  const m = /^(.*)-assistant-message-\d+-\d+$/.exec(id);
  return m && m[1] ? m[1] : null;
}

/**
 * The assistant message wrapper nodes present in the DOM, in document order.
 *
 * Note: the model header contains a nested `div#heading-{conv}-assistant-message-…`
 * whose id also contains `assistant-message-`, so we exclude `heading-`-prefixed
 * ids to match only the true wrapper (`div#{conv}-assistant-message-{turn}-{part}`).
 */
export function assistantElements(root: ParentNode = document): HTMLElement[] {
  const byId = Array.from(
    root.querySelectorAll<HTMLElement>('[id*="assistant-message-"]'),
  ).filter((el) => !(el.id ?? "").startsWith("heading-"));
  if (byId.length > 0) return byId;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-activeresponse]"));
}

/**
 * The wrapper child that our cards should mount *after*: the model-name block,
 * which is the direct child of the message containing the response-heading
 * marker (`[id^="heading-"]`). This places cards below the model name and above
 * the answer. Returns null when no such block is present (caller appends).
 */
export function placementAnchor(target: HTMLElement): Element | null {
  const marker = target.querySelector('[id^="heading-"]');
  if (!marker) return null;
  let el: Element | null = marker;
  while (el && el.parentElement !== target) el = el.parentElement;
  return el;
}

/** Pretty-print arbitrary tool arguments for display. Never throws. */
export function formatArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
    return clamp(text);
  } catch {
    return clamp(String(args));
  }
}

/** Pretty-print a tool result for display. If it is JSON, indent it. */
export function formatResult(result: string): string {
  const text = result ?? "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return clamp(JSON.stringify(parsed, null, 2));
  } catch {
    /* not JSON — show verbatim */
  }
  return clamp(text);
}

/** One-line argument preview for the collapsed row. Empty for no-arg calls. */
function formatArgsInline(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    if (typeof args === "object") {
      const json = JSON.stringify(args);
      return json === "{}" ? "" : json.slice(0, 300);
    }
    return String(args).slice(0, 300);
  } catch {
    return String(args).slice(0, 300);
  }
}

function clamp(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text;
}

/**
 * The neutral fallback view (what you get when a tool registers nothing): the
 * pretty-printed arguments, then the result/error once the call has finished.
 */
function defaultBlocks(call: ToolCallView): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const argText = formatArgs(call.args);
  if (argText) blocks.push({ kind: "code", label: "Arguments", text: argText });
  if (call.status !== "running") {
    blocks.push({
      kind: "code",
      label: call.error ? "Error" : "Result",
      text: call.error ? call.error : formatResult(call.result ?? ""),
    });
  }
  return blocks;
}

/** Body blocks for a call: the registered tool view, or the neutral default. */
export function blocksFor(call: ToolCallView): RenderBlock[] {
  return callBody(call) ?? defaultBlocks(call);
}

/** Collapsed-row summary: the registered tool view, or the inline args. */
export function summaryFor(call: ToolCallView): string {
  const summary = callSummary(call);
  return typeof summary === "string" ? summary : formatArgsInline(call.args);
}

/**
 * Translate a single render descriptor into DOM. This is the *only* place that
 * knows about our shadow markup/classes, so tool views never have to.
 */
function renderBlock(block: RenderBlock): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "block";
  if (block.label) {
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = block.label;
    wrap.append(label);
  }
  switch (block.kind) {
    case "code": {
      const pre = document.createElement("pre");
      pre.textContent = block.text;
      if (block.language) pre.dataset.language = block.language;
      wrap.append(pre);
      break;
    }
    case "text": {
      const p = document.createElement("p");
      p.className = "text";
      p.textContent = block.text;
      wrap.append(p);
      break;
    }
    case "fields": {
      const fields = document.createElement("div");
      fields.className = "fields";
      for (const f of block.fields) {
        const k = document.createElement("div");
        k.className = "k";
        k.textContent = f.label;
        const v = document.createElement("div");
        v.className = "v";
        v.textContent = f.value;
        fields.append(k, v);
      }
      wrap.append(fields);
      break;
    }
    case "list": {
      const ul = document.createElement("ul");
      ul.className = "list";
      for (const item of block.items) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.append(li);
      }
      wrap.append(ul);
      break;
    }
    case "link": {
      const a = document.createElement("a");
      a.href = block.href;
      a.textContent = block.text;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      wrap.append(a);
      break;
    }
  }
  return wrap;
}

const STYLES = `
  :host { display: block; }
  .duckai-tools {
    display: flex; flex-direction: column; gap: 1px;
    margin: 6px 0; font-size: 13px; line-height: 1.35;
  }
  .call { border-radius: 8px; }
  .row {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px 3px 3px; border-radius: 8px;
    cursor: pointer; user-select: none; list-style: none;
  }
  .row::-webkit-details-marker { display: none; }
  .row:hover { background: rgba(127,127,127,.14); background: color-mix(in srgb, currentColor 9%, transparent); }
  .chev {
    width: 12px; flex: none; text-align: center; font-size: 11px; opacity: .45;
    transition: transform .15s ease;
  }
  .call[open] .chev { transform: rotate(90deg); }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .dot.running { background: var(--col-blue-50, #3969ef); animation: pulse 1.1s ease-in-out infinite; }
  .dot.ok { background: var(--col-green-40, #63c853); }
  .dot.error { background: var(--col-red-50, #de5833); }
  .name {
    flex: none; font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .args {
    flex: 1 1 auto; min-width: 0; font-size: 12px; opacity: .55;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .status {
    flex: none; font-size: 11px; opacity: .5;
    font-variant-numeric: tabular-nums;
  }
  .detail { padding: 2px 8px 6px 33px; }
  .label {
    font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    opacity: .45; margin: 6px 0 3px;
  }
  .block + .block { margin-top: 4px; }
  .text { margin: 0; }
  .text a, .block a { color: var(--theme-col-link, #3969ef); text-decoration: none; }
  .text a:hover, .block a:hover { text-decoration: underline; }
  .fields {
    display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px;
    align-items: baseline; font-size: 12px;
  }
  .fields .k { opacity: .5; }
  .fields .v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
  .list { margin: 0; padding-left: 18px; font-size: 12px; }
  .list li { margin: 1px 0; }
  pre {
    margin: 0; padding: 6px 8px; border-radius: 6px; overflow: auto; max-height: 220px;
    background: rgba(127,127,127,.10); background: color-mix(in srgb, currentColor 7%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    white-space: pre-wrap; word-break: break-word;
  }
  .call.error .detail pre { color: var(--col-red-60, #bc4726); }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
`;

interface Card {
  root: HTMLDetailsElement;
  /** The tool-call id this row renders; also its `data-call` attribute. */
  key: string;
  /** True when the row came from a live call (false = restored from history). */
  live: boolean;
  dot: HTMLElement;
  status: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  body: HTMLElement;
  args: unknown;
}

/**
 * Create a per-turn UI controller. By default it lazily mounts into the newest
 * assistant message element the first time a tool starts; pass `target` to pin
 * it to a specific message (used when rehydrating history). Keep itself alive
 * across React re-renders via a MutationObserver.
 */

/** Parse every `duckai-slot:<id>` sentinel in `text` (PUA delimiters optional). */
export function parseSentinels(text: string): Array<{ slotId: string; start: number; end: number }> {
  const re = new RegExp(SLOT_SENTINEL_RE_SOURCE, "g");
  const out: Array<{ slotId: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push({ slotId: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Scan `root` for sentinel text nodes left by the SSE display pipe and replace
 * each one (including multiple sentinels in a single text node) with an inline
 * block-level host element. Returns slotId -> host in document order.
 */
export function claimSentinels(root: Node): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") return result;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toProcess: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.nodeValue ?? "";
    if (text.includes("duckai-slot:")) toProcess.push(node);
  }
  for (const textNode of toProcess) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    // Re-parse against the current value: React may have mutated it since walk.
    const text = textNode.nodeValue ?? "";
    const matches = parseSentinels(text);
    if (matches.length === 0) continue;
    let cursor = 0;
    for (const { slotId, start, end } of matches) {
      const before = text.slice(cursor, start);
      if (before) parent.insertBefore(document.createTextNode(before), textNode);
      const host = document.createElement("span");
      host.setAttribute("data-duckai-slot", slotId);
      host.style.display = "block";
      parent.insertBefore(host, textNode);
      result.set(slotId, host);
      cursor = end;
    }
    const after = text.slice(cursor);
    if (after) parent.insertBefore(document.createTextNode(after), textNode);
    try {
      parent.removeChild(textNode);
    } catch {
      /* already removed by React */
    }
  }
  return result;
}

/** Hosts sorted in document order (TreeWalker insertion order is not guaranteed after merges). */
function orderedHosts(map: Map<string, HTMLElement>): Array<[string, HTMLElement]> {
  return [...map.entries()].sort((a, b) => {
    const pos = a[1].compareDocumentPosition(b[1]);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

export function createToolUi(options: ToolUiOptions = {}): ToolUi {
  const root = options.root ?? document;
  const persist = options.persist ?? true;
  const pinnedTarget = options.target ?? null;
  const myId = nextId();
  let targetEl: HTMLElement | null = pinnedTarget;
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let list: HTMLElement | null = null;
  const cards = new Map<string, Card>();
  /** Card keys the user expanded/collapsed by hand (we stop managing those). */
  const userToggled = new Set<string>();
  /** slotId -> inline host span already swapped into the DOM. */
  const slotHosts = new Map<string, HTMLElement>();
  /** toolCallId -> slotId (exact placement, persisted across reload). */
  const callToSlot = new Map<string, string>();
  /** toolCallId -> ordinal in the turn (fallback when slotId unknown). */
  const callToOrdinal = new Map<string, number>();
  let disposed = false;
  /**
   * The conversation this controller belongs to: taken from the pin when given,
   * otherwise learned from the first message it claims. Every later re-target
   * must stay inside that chat, so a controller can never hoard cards from one
   * conversation and drop them into another (which is what made tool calls
   * appear under chats that never had any).
   */
  let conversation: string | null = pinnedTarget ? conversationIdOf(pinnedTarget.id) : null;

  if (pinnedTarget) pinnedTarget.setAttribute(UI_CLAIM_ATTR, myId);

  /** Where this controller should write history: derived from the message id. */
  function historyTarget(): { conversationId: string; turn: number } | null {
    const el = targetEl;
    if (!el) return null;
    const conversationId = conversationIdOf(el.id);
    const parsed = parseAssistantId(el.id);
    if (!conversationId || !parsed) return null;
    return { conversationId, turn: parsed.turn };
  }

  function claimTarget(): HTMLElement | null {
    if (targetEl && targetEl.isConnected) return targetEl;
    if (targetEl && pinnedTarget) {
      // Pinned target was replaced by React; re-find it by its stable id.
      const again = (root as ParentNode).querySelector?.(
        `[id="${CSS.escape(targetEl.id)}"]`,
      ) as HTMLElement | null;
      targetEl = again;
      if (again) again.setAttribute(UI_CLAIM_ATTR, myId);
      return again;
    }
    const els = assistantElements(root);
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (!el) continue;
      // Stay inside our own conversation: other chats' messages can be mounted
      // at the same time (mid-switch), and grabbing one would misfile cards.
      const elConversation = conversationIdOf(el.id);
      if (conversation && elConversation !== conversation) continue;
      const claim = el.getAttribute(UI_CLAIM_ATTR);
      if (!claim || claim === myId) {
        targetEl = el;
        if (!conversation) conversation = elConversation;
        el.setAttribute(UI_CLAIM_ATTR, myId);
        return el;
      }
    }
    return null;
  }

  function ensureHost(): boolean {
    if (disposed) return false;
    const target = claimTarget();
    if (!target) return false;

    if (!host) {
      host = document.createElement("div");
      host.setAttribute(UI_HOST_ATTR, myId);
      shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLES;
      list = document.createElement("div");
      list.className = "duckai-tools";
      shadow.append(style, list);
    }

    const anchor = placementAnchor(target);
    const alreadyPlaced =
      host.parentElement === target &&
      (anchor ? host.previousElementSibling === anchor : host.nextElementSibling === null);
    if (!alreadyPlaced) {
      if (anchor) anchor.after(host);
      else target.append(host);
    }

    // Match duck.ai's own left inset so cards line up with the model name and
    // answer text (the model-name block carries the message indent as padding).
    const indent = anchor ? getComputedStyle(anchor).paddingLeft : "0px";
    if (host.style.marginLeft !== indent) host.style.marginLeft = indent;

    return true;
  }

  function inlineListFor(hostEl: HTMLElement): HTMLElement {
    let sr = hostEl.shadowRoot;
    if (!sr) sr = hostEl.attachShadow({ mode: "open" });
    let l = sr.querySelector(".duckai-tools") as HTMLElement | null;
    if (!l) {
      const style = document.createElement("style");
      style.textContent = STYLES;
      l = document.createElement("div");
      l.className = "duckai-tools";
      sr.append(style, l);
    }
    return l;
  }

  function cardInHost(card: Card, hostEl: HTMLElement): boolean {
    const sr = hostEl.shadowRoot;
    if (!sr) return false;
    const l = sr.querySelector(".duckai-tools") as HTMLElement | null;
    return Boolean(l?.contains(card.root));
  }

  function moveCardToHost(card: Card, hostEl: HTMLElement): void {
    const l = inlineListFor(hostEl);
    if (card.root.parentElement !== l) l.append(card.root);
  }

  function resolveHost(callId: string): HTMLElement | null {
    const sid = callToSlot.get(callId);
    if (sid) {
      const h = slotHosts.get(sid);
      if (h) return h;
    }
    const ord = callToOrdinal.get(callId);
    if (ord !== undefined) {
      const ordered = orderedHosts(slotHosts);
      return ordered[ord]?.[1] ?? null;
    }
    return null;
  }

  function refreshSlotHosts(): void {
    if (!targetEl) return;
    const found = claimSentinels(targetEl);
    for (const [sid, el] of found) slotHosts.set(sid, el);
  }

  function buildCard(key: string, name: string, args: unknown, live: boolean, inlineHost?: HTMLElement): Card {
    const cardEl = document.createElement("details");
    cardEl.className = "call";
    cardEl.dataset.call = key;
    // Start collapsed; `renderCard` opens live running rows. A manual toggle is
    // remembered so our re-renders never fight the user.
    cardEl.open = false;

    const head = document.createElement("summary");
    head.className = "row";
    head.addEventListener("click", () => userToggled.add(key));
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "›";
    const dot = document.createElement("span");
    dot.className = "dot running";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    const summaryEl = document.createElement("span");
    summaryEl.className = "args";
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "running";
    head.append(chev, dot, nameEl, summaryEl, status);

    const body = document.createElement("div");
    body.className = "detail";

    cardEl.append(head, body);
    const card: Card = { root: cardEl, key, live, dot, status, nameEl, summaryEl, body, args };
    if (inlineHost) {
      moveCardToHost(card, inlineHost);
    } else {
      list?.append(cardEl);
    }
    return card;
  }

  /**
   * Apply a call's state to its row: status dot/label, collapsed summary, and
   * the expanded body — all derived from the generic render interface.
   */
  function renderCard(card: Card, call: ToolCallView): void {
    card.dot.className = `dot ${
      call.status === "running" ? "running" : call.status === "error" ? "error" : "ok"
    }`;
    card.status.textContent =
      call.status === "running" ? "running" : call.status === "error" ? "error" : "done";
    card.root.classList.toggle("error", call.status === "error");
    card.summaryEl.textContent = summaryFor(call);
    card.body.replaceChildren(...blocksFor(call).map(renderBlock));
    // Open rows only for *live, still-running* calls; finished and rehydrated
    // rows stay collapsed. Once the user toggles a row, we leave it alone.
    if (!userToggled.has(card.key)) card.root.open = call.status === "running" && card.live;
  }

  function start(id: string, name: string, args: unknown, slotId?: string): void {
    if (cards.has(id)) return;
    claimTarget();
    if (slotId) callToSlot.set(id, slotId);
    refreshSlotHosts();
    let inlineHost: HTMLElement | undefined;
    if (slotId) inlineHost = slotHosts.get(slotId) ?? undefined;
    let card: Card | null = null;
    if (inlineHost) {
      card = buildCard(id, name, args, true, inlineHost);
    } else if (ensureHost() && list) {
      card = buildCard(id, name, args, true);
    }
    if (!card) return;
    cards.set(id, card);
    renderCard(card, { name, args, status: "running" });
    if (persist) {
      const ht = historyTarget();
      if (ht) recordStart(ht.conversationId, ht.turn, { id, name, args, slotId });
    }
  }

  function finish(id: string, name: string, result: string, error?: string): void {
    let card = cards.get(id);
    if (!card) {
      claimTarget();
      refreshSlotHosts();
      const inlineHost = resolveHost(id);
      if (inlineHost) {
        card = buildCard(id, name, undefined, true, inlineHost);
      } else if (ensureHost() && list) {
        card = buildCard(id, name, undefined, true);
      }
      if (!card) return;
      cards.set(id, card);
    } else {
      // Existing card: inline cards need no fallback host; the sentinel
      // observer keeps them re-attached if React rebuilds the markdown.
    }
    const status = error ? "error" : "ok";
    renderCard(card, { name, args: card.args, status, result, error });
    if (persist) {
      const ht = historyTarget();
      if (ht) recordEnd(ht.conversationId, ht.turn, { id, name, result, error });
    }
  }

  function restore(calls: StoredCall[]): void {
    claimTarget();
    if (!targetEl) return;
    refreshSlotHosts();
    const hasAnySlotId = calls.some((c) => c.slotId);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (cards.has(call.id)) continue;
      // Ordinal mapping is only safe as the pre-slotId recovery path where
      // every call in the turn was envelope-sourced (so the nth call is the
      // nth sentinel). In mixed history, native calls have no sentinel and
      // would be misplaced by a global ordinal, so they stay fallback.
      if (!hasAnySlotId) callToOrdinal.set(call.id, i);
      if (call.slotId) callToSlot.set(call.id, call.slotId);
      const inlineHost = resolveHost(call.id);
      let card: Card | null = null;
      if (inlineHost) {
        card = buildCard(call.id, call.name, call.args, false, inlineHost);
      } else if (ensureHost() && list) {
        card = buildCard(call.id, call.name, call.args, false);
      }
      if (!card) continue;
      cards.set(call.id, card);
      const interrupted = call.status === "running";
      renderCard(card, {
        name: call.name,
        args: call.args,
        status: interrupted ? "error" : call.status,
        result: call.result,
        error: interrupted ? "interrupted" : call.error,
      });
    }
  }

  const sentinelObserver = new MutationObserver(() => {
    if (disposed) return;
    if (!targetEl && pinnedTarget) {
      // Pinned target may have been replaced by React; re-latch via claimTarget.
      claimTarget();
    }
    if (!targetEl) return;
    refreshSlotHosts();
    // Migrate / re-attach every known call to its inline host when that host
    // appears (live sentinel painted late, or React re-rendered the markdown
    // and destroyed the previous host element).
    const ids = new Set<string>([...callToSlot.keys(), ...callToOrdinal.keys()]);
    for (const callId of ids) {
      const card = cards.get(callId);
      if (!card) continue;
      const iHost = resolveHost(callId);
      if (!iHost) continue;
      if (!cardInHost(card, iHost)) moveCardToHost(card, iHost);
    }
  });

  const observer = new MutationObserver(() => {
    if (disposed) return;
    if (host && !host.isConnected) {
      if (ensureHost()) log.debug(`ui: re-mounted tool cards into ${targetEl?.id ?? "?"}`);
    }
  });
  try {
    const obsRoot = root === document ? document.body : (root as Node);
    observer.observe(obsRoot, { childList: true, subtree: true });
    sentinelObserver.observe(obsRoot, { childList: true, subtree: true, characterData: true });
  } catch (err) {
    log.warn("ui: observer failed", String(err));
  }

  function dispose(): void {
    disposed = true;
    observer.disconnect();
    sentinelObserver.disconnect();
    try {
      host?.remove();
    } catch {
      /* ignore */
    }
    host = null;
    shadow = null;
    list = null;
    cards.clear();
    userToggled.clear();
    slotHosts.clear();
    callToSlot.clear();
    callToOrdinal.clear();
  }

  return { start, finish, restore, dispose };
}

/**
 * Rehydrate widget rows for an already-rendered conversation, using the
 * persisted sidecar history. Safe to call repeatedly: it skips messages that
 * are already claimed by a live or previously-restored controller.
 *
 * @returns the number of message elements that were rehydrated.
 */
export function resumeToolHistory(root: ParentNode = document): number {
  const els = assistantElements(root);
  if (els.length === 0) return 0;
  const conversationId = conversationIdOf(els[0]?.id ?? "");
  if (!conversationId) return 0;
  const history = loadHistory(conversationId);
  let restored = 0;
  for (const el of els) {
    const parsed = parseAssistantId(el.id);
    if (!parsed || el.getAttribute(UI_CLAIM_ATTR)) continue;
    const calls = history[String(parsed.turn)];
    if (!calls || calls.length === 0) continue;
    createToolUi({ root, target: el, persist: false }).restore(calls);
    restored++;
  }
  if (restored > 0) log.debug(`ui: rehydrated ${restored} message(s) from history`);
  return restored;
}
