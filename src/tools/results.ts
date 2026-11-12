import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tool } from "../harness";
import { log } from "../logging/host";

// Lossless offload for large tool results: results over the threshold
// are persisted locally and the model gets a small stub with a `ref`.
// `result_read` (paging) / `result_grep` (search) make the full text
// recoverable without ever flooding context. Refs and timestamps live
// only at rest; stubs carry just enough to navigate.

export const OFFLOAD_THRESHOLD = 8192;
export const MAX_REFS = 100;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_REF_BYTES = 4 * 1024 * 1024;
const PREVIEW_CHARS = 1500;

interface ResultEntry {
  tool: string;
  text: string;
  c: number; // created ms
  u: number; // last used ms
}

type Store = Record<string, ResultEntry>;

function resultsPath(): string {
  return process.env.DUCKAI_RESULTS_PATH || join(homedir(), ".duckai", "results.json");
}

let cachedPath = "";
let store: Store | null = null;

function load(): Store {
  const path = resultsPath();
  if (store && cachedPath === path) return store;
  cachedPath = path;
  store = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const [k, raw] of Object.entries(parsed)) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as Partial<ResultEntry>;
        if (typeof e.text !== "string") continue;
        store[k] = {
          tool: typeof e.tool === "string" ? e.tool : "tool",
          text: e.text,
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
    const path = resultsPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(load()));
    renameSync(tmp, path);
  } catch (err) {
    log.child("results").warn("failed to persist", err instanceof Error ? err.message : err);
  }
}

function totalBytes(s: Store): number {
  let n = 0;
  for (const e of Object.values(s)) n += Buffer.byteLength(e.text);
  return n;
}

function evict(s: Store): void {
  // Drop least-recently-used until within both caps.
  const entries = Object.entries(s).sort((a, b) => a[1].u - b[1].u);
  for (const [ref] of entries) {
    if (Object.keys(s).length <= MAX_REFS && totalBytes(s) <= MAX_TOTAL_BYTES) break;
    delete s[ref];
  }
}

function newRef(s: Store): string {
  for (;;) {
    const ref = `r_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;
    if (!(ref in s)) return ref;
  }
}

function renderResultText(result: unknown, indent = ""): string {
  if (typeof result === "string") return result;
  if (result === null || typeof result !== "object") return String(result ?? "");
  if (Array.isArray(result)) {
    return result.map((v) => renderResultText(v, indent)).join("\n");
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (typeof v === "string" || v === null || typeof v !== "object") {
      lines.push(`${indent}${k}: ${typeof v === "string" ? v : String(v ?? "")}`);
    } else {
      lines.push(`${indent}${k}:`);
      lines.push(renderResultText(v, `${indent}  `));
    }
  }
  return lines.join("\n");
}

/**
 * Offload `result` if its serialized form exceeds the threshold.
 * Returns the original value when small, else a stub object.
 */
export function maybeOffload(toolName: string, result: unknown): unknown {
  const text = typeof result === "string" ? result : renderResultText(result);
  const bytes = Buffer.byteLength(text);
  if (bytes <= OFFLOAD_THRESHOLD) return result;
  const s = load();
  const ref = newRef(s);
  const now = Date.now();
  // Byte-cap a single ref so one pathological result can't fill the store.
  const stored =
    bytes > MAX_REF_BYTES
      ? Buffer.from(text, "utf8").subarray(0, MAX_REF_BYTES).toString("utf8")
      : text;
  s[ref] = { tool: toolName, text: stored, c: now, u: now };
  evict(s);
  save();
  return {
    ref,
    tool: toolName,
    bytes,
    lines: text.split("\n").length,
    preview: text.slice(0, PREVIEW_CHARS),
    hint: "large result offloaded; use result_read (paging) / result_grep (search) with ref",
  };
}

function lookup(ref: string): ResultEntry | null {
  const s = load();
  const e = s[ref.trim()];
  if (!e) return null;
  e.u = Date.now();
  save();
  return e;
}

function normRef(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export const resultReadTool: Tool = {
  name: "result_read",
  permission: "allow",
  description: "Read lines from a large tool result by ref.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string" },
      start_line: { type: "integer" },
      line_count: { type: "integer" },
    },
    required: ["ref"],
  },
  execute: (args) => {
    const ref = normRef(args.ref);
    if (!ref) return { error: "ref required" };
    const e = lookup(ref);
    if (!e) return { error: "unknown ref" };
    const lines = e.text.split("\n");
    const start = Math.max(1, typeof args.start_line === "number" ? Math.floor(args.start_line) : 1);
    const count = Math.min(
      500,
      Math.max(1, typeof args.line_count === "number" ? Math.floor(args.line_count) : 50),
    );
    const slice = lines.slice(start - 1, start - 1 + count);
    return {
      ref,
      start_line: start,
      total_lines: lines.length,
      has_more: start - 1 + slice.length < lines.length,
      content: slice.join("\n"),
    };
  },
};

export const resultGrepTool: Tool = {
  name: "result_grep",
  permission: "allow",
  description: "Search lines in a large tool result by ref.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string" },
      query: { type: "string" },
      max_results: { type: "integer" },
    },
    required: ["ref", "query"],
  },
  execute: (args) => {
    const ref = normRef(args.ref);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!ref) return { error: "ref required" };
    if (!query) return { error: "query required" };
    const e = lookup(ref);
    if (!e) return { error: "unknown ref" };
    let re: RegExp;
    try {
      re = new RegExp(query, "i");
    } catch {
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const max = Math.min(
      200,
      Math.max(1, typeof args.max_results === "number" ? Math.floor(args.max_results) : 50),
    );
    const lines = e.text.split("\n");
    const matches: Array<{ line: number; text: string }> = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (m) {
        const line = lines[i]!;
        // For very long lines, show a window around the match, not the head.
        const text =
          line.length > 1000
            ? `…${line.slice(Math.max(0, m.index - 200), m.index + 800)}…`
            : line;
        matches.push({ line: i + 1, text });
        if (matches.length >= max) {
          truncated = i + 1 < lines.length;
          break;
        }
      }
      re.lastIndex = 0;
    }
    return { ref, matches, truncated };
  },
};

export const resultTools: Tool[] = [resultReadTool, resultGrepTool];
