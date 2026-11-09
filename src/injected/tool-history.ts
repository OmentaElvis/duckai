/**
 * Persistent log of client-executed tool calls, so our widget rows survive a
 * page reload / app restart.
 *
 * Why a separate store: the duck.ai frontend keeps the conversation itself in
 * IndexedDB (`savedAIChatData`), but it drops unknown `tool-invocation` parts at
 * render time (the `Ap` render gate), so there is nothing in the DOM to read
 * back. We therefore keep our own sidecar, keyed by the stable identifiers the
 * frontend does expose:
 *
 *   - conversationId — the prefix of `div#{conv}-assistant-message-{turn}-{part}`
 *   - turn           — the numeric turn in that id (stable across reloads,
 *                      confirmed by reload+reopen DOM reconnaissance)
 *
 * Storage is `localStorage` (per duck.ai origin, survives reloads and app
 * restarts). All access is guarded — a missing/blocked store degrades to a
 * no-op rather than throwing into the page.
 */

const PREFIX = "duckai-ext:history:";

/** Cap stored text so a chatty tool can't blow the (small) localStorage quota. */
const MAX_STORED_TEXT = 8000;
/** Cap calls retained per turn and turns retained per conversation. */
const MAX_CALLS_PER_TURN = 200;
const MAX_TURNS = 500;

export type StoredStatus = "running" | "ok" | "error";

export interface StoredCall {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  error?: string;
  status: StoredStatus;
  ts: number;
  /** Inline placement id: matches the `duckai-slot:<id>` sentinel in the
   * assistant message text so reload can re-place this card exactly.
   * Absent for history written before inline persistence. */
  slotId?: string;
}

/** Turn number (as a string key) → calls made during that assistant turn. */
export type StoredTurns = Record<string, StoredCall[]>;

function storageKey(conversationId: string): string {
  return `${PREFIX}${conversationId}`;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cap(text: string | undefined): string | undefined {
  if (typeof text !== "string") return text;
  return text.length > MAX_STORED_TEXT ? `${text.slice(0, MAX_STORED_TEXT)}…` : text;
}

function isCall(v: unknown): v is StoredCall {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<StoredCall>;
  return typeof c.id === "string" && typeof c.name === "string";
}

export function loadHistory(conversationId: string): StoredTurns {
  const store = storage();
  if (!store || !conversationId) return {};
  try {
    const raw = store.getItem(storageKey(conversationId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: StoredTurns = {};
    for (const [turn, calls] of Object.entries(parsed)) {
      if (!Array.isArray(calls)) continue;
      const valid = calls.filter(isCall);
      if (valid.length > 0) out[turn] = valid;
    }
    return out;
  } catch {
    return {};
  }
}

function saveHistory(conversationId: string, data: StoredTurns): void {
  const store = storage();
  if (!store || !conversationId) return;
  try {
    // Trim the oldest turns if we exceed the cap (string keys sort lexically,
    // but turn numbers are small; sort numerically to be safe).
    const turns = Object.keys(data);
    if (turns.length > MAX_TURNS) {
      turns
        .sort((a, b) => Number(a) - Number(b))
        .slice(0, turns.length - MAX_TURNS)
        .forEach((t) => delete data[t]);
    }
    store.setItem(storageKey(conversationId), JSON.stringify(data));
  } catch {
    /* quota/blocked — persistence is best-effort */
  }
}

export function recordStart(
  conversationId: string,
  turn: number,
  call: { id: string; name: string; args: unknown; slotId?: string },
): void {
  if (!conversationId) return;
  const data = loadHistory(conversationId);
  const key = String(turn);
  const calls = data[key] ?? (data[key] = []);
  const existing = calls.some((c) => c.id === call.id);
  if (existing) {
    // Backfill slotId if it arrives after the first record (defensive).
    if (call.slotId) {
      const ex = calls.find((c) => c.id === call.id)!;
      if (!ex.slotId) {
        ex.slotId = call.slotId;
        saveHistory(conversationId, data);
      }
    }
    return;
  }
  calls.push({
    id: call.id,
    name: call.name,
    args: call.args,
    status: "running",
    ts: Date.now(),
    ...(call.slotId ? { slotId: call.slotId } : {}),
  });
  if (calls.length > MAX_CALLS_PER_TURN) calls.splice(0, calls.length - MAX_CALLS_PER_TURN);
  saveHistory(conversationId, data);
}

export function recordEnd(
  conversationId: string,
  turn: number,
  call: { id: string; name: string; result?: string; error?: string },
): void {
  if (!conversationId) return;
  const data = loadHistory(conversationId);
  const key = String(turn);
  const calls = data[key] ?? (data[key] = []);
  const existing = calls.find((c) => c.id === call.id);
  const status: StoredStatus = call.error ? "error" : "ok";
  if (existing) {
    existing.status = status;
    existing.result = cap(call.result);
    if (call.error) existing.error = cap(call.error);
  } else {
    calls.push({
      id: call.id,
      name: call.name,
      args: {},
      result: cap(call.result),
      ...(call.error ? { error: cap(call.error) } : {}),
      status,
      ts: Date.now(),
    });
  }
  saveHistory(conversationId, data);
}

/** Remove all persisted history for a conversation (e.g. chat deleted). */
export function clearHistory(conversationId: string): void {
  const store = storage();
  if (!store || !conversationId) return;
  try {
    store.removeItem(storageKey(conversationId));
  } catch {
    /* ignore */
  }
}

/** Every conversation id we currently hold history for. */
export function listHistoryConversationIds(): string[] {
  const store = storage();
  if (!store) return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

/**
 * Drop history for any conversation whose id is not in `keep`.
 * Returns the number of conversations removed. Used to reconcile our sidecar
 * after the user deletes a chat.
 */
export function pruneHistory(keep: Iterable<string>): number {
  const store = storage();
  if (!store) return 0;
  const keepSet = new Set(keep);
  let removed = 0;
  for (const id of listHistoryConversationIds()) {
    if (keepSet.has(id)) continue;
    try {
      store.removeItem(storageKey(id));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}
