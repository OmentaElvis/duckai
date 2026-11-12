import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tool } from "../harness";
import { log } from "../logging/host";

// Bounded, token-lean global memory: key -> short fact, durable across
// sessions/chats. On-disk keeps accounting timestamps (c/u) that are
// NEVER returned to the agent; read results stay bare maps / key lists
// (no timestamps, tags, or snapshot dumps) so recall stays cheap.
// Writes are user-approved (`ask`); reads are free.

export const MAX_ENTRIES = 100;
export const MAX_VALUE_BYTES = 1024;
export const MAX_TOTAL_BYTES = 32768;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SECRET_RE = /(password|passwd|api[_-]?key|secret)\s*[:=]|bearer\s+[A-Za-z0-9._-]{10,}/i;

/** At-rest entry. `c` = created ms, `u` = updated ms. */
interface MemoryEntry {
  v: string;
  c: number;
  u: number;
}

type Store = Record<string, MemoryEntry>;

function memoryPath(): string {
  return process.env.DUCKAI_MEMORY_PATH || join(homedir(), ".duckai", "memory.json");
}

let cachedPath = "";
let store: Store | null = null;

function load(): Store {
  const path = memoryPath();
  if (store && cachedPath === path) return store;
  cachedPath = path;
  store = {};
  try {
    // Single schema only (no legacy handling): each entry must be an
    // object with a string `v`; anything else is ignored as corrupt.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { m?: unknown };
    const m = parsed?.m;
    if (m && typeof m === "object" && !Array.isArray(m)) {
      for (const [k, raw] of Object.entries(m as Record<string, unknown>)) {
        if (!KEY_RE.test(k)) continue;
        if (!raw || typeof raw !== "object") continue;
        const e = raw as Partial<MemoryEntry>;
        if (typeof e.v !== "string") continue;
        store[k] = {
          v: e.v.slice(0, MAX_VALUE_BYTES),
          c: typeof e.c === "number" ? e.c : 0,
          u: typeof e.u === "number" ? e.u : 0,
        };
      }
    }
  } catch {
    /* corrupt/missing — start empty */
  }
  return store;
}

function save(): void {
  try {
    const path = memoryPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ m: load() }));
    renameSync(tmp, path);
  } catch (err) {
    log.child("memory").warn("failed to persist", err instanceof Error ? err.message : err);
  }
}

function normKey(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function normValue(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function totalBytes(s: Store): number {
  let n = 0;
  // Cap counts key+value only; timestamps are fixed overhead (~2 numbers).
  for (const [k, e] of Object.entries(s)) n += Buffer.byteLength(k) + Buffer.byteLength(e.v);
  return n;
}

export const memoryListTool: Tool = {
  name: "memory_list",
  permission: "allow",
  description: "List stored memory keys.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: [] },
  execute: (args) => {
    const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const s = load();
    const keys = Object.keys(s)
      .filter((k) => !q || k.includes(q) || s[k]!.v.toLowerCase().includes(q))
      .sort();
    return { keys };
  },
};

export const memoryGetTool: Tool = {
  name: "memory_get",
  permission: "allow",
  description: "Read stored values by keys.",
  parameters: {
    type: "object",
    properties: { keys: { type: "array", items: { type: "string" } } },
    required: ["keys"],
  },
  execute: (args) => {
    if (!Array.isArray(args.keys) || args.keys.length === 0) return { error: "keys required" };
    const s = load();
    const out: Record<string, string> = {};
    for (const raw of args.keys) {
      const k = normKey(raw);
      // Values only — c/u timestamps stay at rest for accounting.
      if (k && s[k] !== undefined) out[k] = s[k]!.v;
    }
    return out;
  },
};

export const memorySetTool: Tool = {
  name: "memory_set",
  permission: "ask",
  description: "Save durable cross-session fact by key.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" }, value: { type: "string" } },
    required: ["key", "value"],
  },
  execute: (args) => {
    const k = normKey(args.key);
    if (!KEY_RE.test(k)) return { error: "invalid key" };
    const v = normValue(args.value);
    if (!v) return { error: "value required" };
    if (Buffer.byteLength(v) > MAX_VALUE_BYTES) return { error: "value too long" };
    if (SECRET_RE.test(v)) return { error: "refusing to store a credential" };
    const s = load();
    if (!(k in s) && Object.keys(s).length >= MAX_ENTRIES) return { error: "memory full" };
    const prev = s[k];
    const now = Date.now();
    s[k] = prev ? { v, c: prev.c, u: now } : { v, c: now, u: now };
    if (totalBytes(s) > MAX_TOTAL_BYTES) {
      if (prev === undefined) delete s[k];
      else s[k] = prev;
      return { error: "memory full" };
    }
    save();
    return { k };
  },
};

export const memoryForgetTool: Tool = {
  name: "memory_forget",
  permission: "ask",
  description: "Delete stored memory key.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
  execute: (args) => {
    const k = normKey(args.key);
    const s = load();
    if (!k || !(k in s)) return { error: "not found" };
    delete s[k];
    save();
    return { k };
  },
};

export const memoryTools: Tool[] = [
  memoryListTool,
  memoryGetTool,
  memorySetTool,
  memoryForgetTool,
];
