/**
 * The app harness: tool registry + execution engine (Bun side).
 *
 * The page (injected script) reaches this via `harnessCall({method, params})`
 * (webview-bun bind). Handlers must never throw — they return result objects;
 * unexpected failures are converted to `{ ok:false, error }`.
 *
 * Phase 1: plumbing (ping/pageReady/log/sseEvent) + echo tool.
 * Phase 2: manifest exposure + tool execution loop for synthesized calls.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeHealth, type HealthReport } from "./health-report";
import type { ManagedTool, Permission, PermissionSource, ToolInfo, ToolManifestEntry } from "./protocol";

export type { ToolManifestEntry };

export interface Tool extends ToolManifestEntry {
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  /**
   * Declared default permission for this tool. Defaults to `"ask"` so a new,
   * potentially-sensitive tool is never run silently. Read-only/benign tools
   * should declare `"allow"`.
   */
  permission?: Permission;
}

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

// --- settings (tool availability) ------------------------------------------

interface Settings {
  /** Names of registered tools the user has switched off. */
  disabledTools: string[];
  /**
   * Explicit per-tool permission overrides (persisted = global). These are only
   * written when the user explicitly changes a tool's permission in the UI; the
   * in-conversation "Always allow" prompt grants a *session* (in-memory) only.
   */
  toolPermissions: Record<string, Permission>;
}

const PERMISSIONS: readonly Permission[] = ["allow", "ask", "deny"];
const isPermission = (v: unknown): v is Permission => PERMISSIONS.includes(v as Permission);

/** In-memory "Always allow" grants for the current app session. */
const sessionGrants = new Set<string>();

function settingsPath(): string {
  return process.env.DUCKAI_SETTINGS_PATH || join(homedir(), ".duckai", "settings.json");
}

function readSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
      disabledTools?: unknown;
      toolPermissions?: unknown;
    };
    const disabled = Array.isArray(parsed.disabledTools) ? parsed.disabledTools.map(String) : [];
    const permissions: Record<string, Permission> = {};
    if (parsed.toolPermissions && typeof parsed.toolPermissions === "object") {
      for (const [name, value] of Object.entries(parsed.toolPermissions as Record<string, unknown>)) {
        if (isPermission(value)) permissions[name] = value;
      }
    }
    return { disabledTools: disabled, toolPermissions: permissions };
  } catch {
    return { disabledTools: [], toolPermissions: {} };
  }
}

function writeSettings(settings: Settings): void {
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.log("[harness] failed to persist settings:", err instanceof Error ? err.message : err);
  }
}

function isToolEnabled(name: string): boolean {
  return !readSettings().disabledTools.includes(name);
}

/** Effective permission for a tool, resolving session grant → policy → default. */
export function resolvePermission(name: string): {
  level: Permission;
  source: PermissionSource;
} {
  if (sessionGrants.has(name)) return { level: "allow", source: "session" };
  const policy = readSettings().toolPermissions[name];
  if (policy) return { level: policy, source: "policy" };
  return { level: tools.get(name)?.permission ?? "ask", source: "default" };
}

/** Grant "always allow" for a tool for the remainder of this session (in-memory). */
export function grantSession(name: string): void {
  if (!tools.has(name)) throw new Error(`unknown tool: ${name}`);
  sessionGrants.add(name);
}

/** Explicitly set a tool's persisted (global) permission. */
export function setToolPermission(name: string, level: Permission): ManagedTool[] {
  if (!tools.has(name)) throw new Error(`unknown tool: ${name}`);
  if (!isPermission(level)) throw new Error(`invalid permission: ${String(level)}`);
  const settings = readSettings();
  settings.toolPermissions[name] = level;
  writeSettings(settings);
  return listToolStatus();
}

export function listManifest(): ToolManifestEntry[] {
  return [...tools.values()]
    .filter((t) => isToolEnabled(t.name))
    .map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
}

/** Every registered tool with its current enabled state (for the UI). */
export function listTools(): ToolInfo[] {
  return [...tools.values()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
    enabled: isToolEnabled(name),
  }));
}

/** Tool list plus effective permission (drives the management UI). */
export function listToolStatus(): ManagedTool[] {
  return [...tools.values()].map(({ name, description, parameters }) => {
    const { level, source } = resolvePermission(name);
    return {
      name,
      description,
      parameters,
      enabled: isToolEnabled(name),
      permission: level,
      permissionSource: source,
    };
  });
}

/** Persist availability for a tool; returns the refreshed tool list. */
export function setToolEnabled(name: string, enabled: boolean): ManagedTool[] {
  if (!tools.has(name)) throw new Error(`unknown tool: ${name}`);
  const settings = readSettings();
  const disabled = new Set(settings.disabledTools);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeSettings({ ...settings, disabledTools: [...disabled].sort() });
  return listToolStatus();
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return await tool.execute(args);
}

/** Wire-protocol handler. Never throws. */
export async function handleHarnessCall(req: unknown): Promise<unknown> {
  try {
    const { method, params } = (req ?? {}) as { method?: string; params?: unknown };
    switch (method) {
      case "ping":
        return { ok: true, result: { pong: Date.now() } };
      case "pageReady":
        console.log("[harness] page ready:", JSON.stringify(params));
        return { ok: true, result: { version: "0.1.0" } };
      case "selfCheck": {
        const p = params as { telemetryBlocked?: boolean; bridgeOk?: boolean; error?: string };
        const status = p.telemetryBlocked && p.bridgeOk ? "OK" : "FAIL";
        console.log(`[harness] self-check: ${status}`, JSON.stringify(params));
        return { ok: true, result: { status } };
      }
      case "health": {
        const report = (params as { report?: HealthReport } | undefined)?.report;
        if (!report) return { ok: false, error: "missing health report" };
        console.log(summarizeHealth(report, { color: true }));
        return { ok: true, result: { status: report.status } };
      }
      case "log": {
        const p = params as { level?: string; msg?: string; data?: unknown };
        console.log(`[page:${p.level ?? "info"}] ${p.msg ?? ""}`, p.data ?? "");
        return { ok: true, result: null };
      }
      case "sseEvent": {
        const p = params as { json?: Record<string, unknown> | null; special?: string | null };
        // Structural events only — deltas are too chatty for stdout.
        const role = p.json?.role;
        if (p.special || (role && role !== "assistant")) {
          console.log(
            `[sse] ${p.special ? `[${p.special}]` : role}`,
            p.special ? "" : JSON.stringify(p.json).slice(0, 400),
          );
        }
        return { ok: true, result: null };
      }
      case "manifest":
        return { ok: true, result: listManifest() };
      case "tools":
        return { ok: true, result: listToolStatus() };
      case "setToolEnabled": {
        const p = params as { name?: string; enabled?: boolean };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        return { ok: true, result: setToolEnabled(p.name, p.enabled !== false) };
      }
      case "authorize": {
        const p = params as { name?: string };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        return { ok: true, result: resolvePermission(p.name) };
      }
      case "grantSession": {
        const p = params as { name?: string };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        grantSession(p.name);
        return { ok: true, result: listToolStatus() };
      }
      case "setPermission": {
        const p = params as { name?: string; level?: Permission };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        if (!isPermission(p.level)) return { ok: false, error: "invalid permission" };
        return { ok: true, result: setToolPermission(p.name, p.level) };
      }
      case "call": {
        const p = params as { name?: string; args?: Record<string, unknown> };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        console.log(`[harness] tool call: ${p.name}`, p.args ?? {});
        const result = await executeTool(p.name, p.args ?? {});
        return { ok: true, result };
      }
      default:
        return { ok: false, error: `unknown method: ${String(method)}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Phase 1 demo tool -----------------------------------------------------

registerTool({
  name: "echo",
  permission: "allow",
  description: "Echo back the provided text. Smoke-test tool for the harness bridge.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to echo back." },
    },
    required: ["text"],
  },
  execute: (args) => ({ echoed: String(args.text ?? ""), at: Date.now() }),
});

// --- Todo list (a real, persistent client-side tool set) --------------------

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
}

const TODO_PATH = join(homedir(), ".duckai", "todos.json");

let todoItems: TodoItem[] | null = null;
let todoNextId = 1;

function loadTodos(): TodoItem[] {
  if (todoItems) return todoItems;
  try {
    const parsed = JSON.parse(readFileSync(TODO_PATH, "utf8")) as {
      items?: TodoItem[];
      nextId?: number;
    };
    todoItems = Array.isArray(parsed.items) ? parsed.items : [];
    todoNextId = typeof parsed.nextId === "number" ? parsed.nextId : 1;
  } catch {
    todoItems = [];
    todoNextId = 1;
  }
  return todoItems;
}

function saveTodos(): void {
  try {
    mkdirSync(dirname(TODO_PATH), { recursive: true });
    writeFileSync(
      TODO_PATH,
      JSON.stringify({ items: loadTodos(), nextId: todoNextId }, null, 2),
    );
  } catch (err) {
    console.log("[harness] failed to persist todos:", err instanceof Error ? err.message : err);
  }
}

function todoSnapshot(): {
  todos: TodoItem[];
  summary: { total: number; open: number; done: number };
} {
  const items = loadTodos();
  const done = items.filter((t) => t.done).length;
  return { todos: items, summary: { total: items.length, open: items.length - done, done } };
}

registerTool({
  name: "todo_list",
  permission: "allow",
  description:
    "Show the user's todo list: every item with its id, text and done status, plus a summary.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: () => todoSnapshot(),
});

registerTool({
  name: "todo_add",
  permission: "ask",
  description: "Add a new item to the user's todo list. Returns the created item and the full list.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "The task text to add." } },
    required: ["text"],
  },
  execute: (args) => {
    const text = String(args.text ?? "").trim();
    if (!text) return { error: "text is required" };
    const item: TodoItem = { id: todoNextId++, text, done: false, createdAt: Date.now() };
    loadTodos().push(item);
    saveTodos();
    return { added: item, ...todoSnapshot() };
  },
});

registerTool({
  name: "todo_complete",
  permission: "ask",
  description:
    "Mark an existing todo item as done, or reopen it, by its numeric id. Returns the updated item and full list.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "integer", description: "The id of the todo item." },
      done: { type: "boolean", description: "Set true to complete, false to reopen. Defaults to true." },
    },
    required: ["id"],
  },
  execute: (args) => {
    const id = Number(args.id);
    const item = loadTodos().find((t) => t.id === id);
    if (!item) return { error: `no todo item with id ${id}` };
    item.done = args.done === undefined ? true : Boolean(args.done);
    saveTodos();
    return { updated: item, ...todoSnapshot() };
  },
});

registerTool({
  name: "todo_remove",
  permission: "ask",
  description: "Remove a todo item from the list by its numeric id. Returns the removed item and full list.",
  parameters: {
    type: "object",
    properties: { id: { type: "integer", description: "The id of the todo item." } },
    required: ["id"],
  },
  execute: (args) => {
    const id = Number(args.id);
    const items = loadTodos();
    const idx = items.findIndex((t) => t.id === id);
    if (idx === -1) return { error: `no todo item with id ${id}` };
    const [removed] = items.splice(idx, 1);
    saveTodos();
    return { removed, ...todoSnapshot() };
  },
});

registerTool({
  name: "get_current_time",
  permission: "allow",
  description: "Return the current date and time on the user's machine.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "Optional IANA timezone, e.g. 'Europe/London'. Defaults to the system zone.",
      },
    },
    required: [],
  },
  execute: (args) => {
    const tz = typeof args.timezone === "string" && args.timezone ? args.timezone : undefined;
    const now = new Date();
    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat("en-GB", {
        dateStyle: "full",
        timeStyle: "long",
        ...(tz ? { timeZone: tz } : {}),
      }).format(now);
    } catch {
      formatted = now.toString();
    }
    return { iso: now.toISOString(), formatted, timezone: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
  },
});
