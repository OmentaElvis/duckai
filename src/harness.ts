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
import { isLogLevel, type LogEntry } from "./logging/core";
import { log, supportsColor } from "./logging/host";
import {
  deleteMcpServer,
  listMcpServersForUi,
  setMcpServerEnabled,
  upsertMcpServer,
} from "./mcp/client";
import type {
  ManagedTool,
  Permission,
  PermissionScope,
  PermissionSource,
  ToolInfo,
  ToolManifestEntry,
} from "./protocol";
import { maybeOffload } from "./tools/results";
import { coreTools } from "./tools";

export type { ToolManifestEntry, PermissionScope };

export interface Tool extends ToolManifestEntry {
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  /**
   * Declared default permission for this tool. Defaults to `"ask"` so a new,
   * potentially-sensitive tool is never run silently. Read-only/benign tools
   * should declare `"allow"`.
   */
  permission?: Permission;
  /**
   * Domain-specific permission scopes for this call's arguments.
   * If omitted, defaults to a single scope matching the tool name.
   */
  permissionScopes?: (args: Record<string, unknown>) => PermissionScope[];
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
  /** File or directory paths protected against destructive tools (like delete_file). */
  protectedPaths?: string[];
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
      protectedPaths?: unknown;
    };
    const disabled = Array.isArray(parsed.disabledTools) ? parsed.disabledTools.map(String) : [];
    const protectedPaths = Array.isArray(parsed.protectedPaths) ? parsed.protectedPaths.map(String) : [];
    const permissions: Record<string, Permission> = {};
    if (parsed.toolPermissions && typeof parsed.toolPermissions === "object") {
      for (const [name, value] of Object.entries(parsed.toolPermissions as Record<string, unknown>)) {
        if (isPermission(value)) permissions[name] = value;
      }
    }
    return { disabledTools: disabled, toolPermissions: permissions, protectedPaths };
  } catch {
    return { disabledTools: [], toolPermissions: {}, protectedPaths: [] };
  }
}

export function getProtectedPaths(): string[] {
  return readSettings().protectedPaths ?? [];
}

function writeSettings(settings: Settings): void {
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2));
  } catch (err) {
    log.child("settings").warn("failed to persist", err instanceof Error ? err.message : err);
  }
}

function isToolEnabled(name: string): boolean {
  return !readSettings().disabledTools.includes(name);
}

export interface AuthorizationResult {
  level: Permission;
  source: PermissionSource;
  scopes: PermissionScope[];
}

/** Effective permission for a tool, resolving session grant → policy → default across scopes. */
export function resolvePermission(
  name: string,
  args?: Record<string, unknown>,
): AuthorizationResult {
  const tool = tools.get(name);
  const toolScopes = tool?.permissionScopes?.(args ?? {}) ?? [
    { id: name, label: `All ${name} calls`, isDefault: true },
  ];

  // 1. Session grants (from most specific scope to tool name)
  for (const s of toolScopes) {
    if (sessionGrants.has(s.id)) return { level: "allow", source: "session", scopes: toolScopes };
  }
  if (sessionGrants.has(name)) return { level: "allow", source: "session", scopes: toolScopes };

  // 2. Persisted policy settings (from most specific scope to tool name)
  const settings = readSettings().toolPermissions;
  for (const s of toolScopes) {
    const policy = settings[s.id];
    if (policy) return { level: policy, source: "policy", scopes: toolScopes };
  }
  const toolPolicy = settings[name];
  if (toolPolicy) return { level: toolPolicy, source: "policy", scopes: toolScopes };

  // 3. Tool default permission
  return {
    level: tool?.permission ?? "ask",
    source: "default",
    scopes: toolScopes,
  };
}

/** Grant "always allow" for a scope or tool for the remainder of this session (in-memory). */
export function grantSession(target: string): void {
  sessionGrants.add(target);
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

/** Tools whose results must never be offloaded (paging/discovery themselves). */
const NO_OFFLOAD = new Set(["result_read", "result_grep"]);

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);

  const required =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as { required?: unknown }).required
      : undefined;

  if (Array.isArray(required)) {
    for (const reqKey of required) {
      if (typeof reqKey === "string") {
        const val = args[reqKey];
        if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
          return { error: `Missing required argument "${reqKey}" for tool "${name}".` };
        }
      }
    }
  }

  const result = await tool.execute(args);
  // Lossless offload: large results become a small stub + ref, recoverable
  // via result_read/result_grep instead of being truncated away.
  if (NO_OFFLOAD.has(name)) return result;
  try {
    return maybeOffload(name, result);
  } catch {
    return result;
  }
}

export interface UpdateInfo {
  hasUpdate: boolean;
  cachedVersion?: string;
  upstreamVersion?: string;
  updatedAt?: number;
}

let availableUpdate: UpdateInfo = { hasUpdate: false };

export function setAvailableUpdate(info: UpdateInfo): void {
  availableUpdate = info;
}

export function getAvailableUpdate(): UpdateInfo {
  return availableUpdate;
}

/** Wire-protocol handler. Never throws. */
export async function handleHarnessCall(req: unknown): Promise<unknown> {
  try {
    const { method, params } = (req ?? {}) as { method?: string; params?: unknown };
    switch (method) {
      case "ping":
        return { ok: true, result: { pong: Date.now() } };
      case "pageReady":
        log.child("bridge").info("page ready", params);
        return { ok: true, result: { version: "0.1.0", update: getAvailableUpdate() } };
      case "checkUpdate":
        return { ok: true, result: getAvailableUpdate() };
      case "selfCheck": {
        const p = params as { telemetryBlocked?: boolean; bridgeOk?: boolean; error?: string };
        const status = p.telemetryBlocked && p.bridgeOk ? "OK" : "FAIL";
        log.child("health").info(`self-check: ${status}`, params);
        return { ok: true, result: { status } };
      }
      case "health": {
        const report = (params as { report?: HealthReport } | undefined)?.report;
        if (!report) return { ok: false, error: "missing health report" };
        log.child("health").info(summarizeHealth(report, { color: supportsColor() }));
        return { ok: true, result: { status: report.status } };
      }
      case "log": {
        const p = params as {
          t?: unknown;
          level?: unknown;
          scope?: unknown;
          msg?: unknown;
          data?: unknown;
        };
        const entry: LogEntry = {
          t: typeof p.t === "number" ? p.t : Date.now(),
          level: isLogLevel(p.level) ? p.level : "info",
          scope: typeof p.scope === "string" && p.scope ? p.scope : "page",
          msg: typeof p.msg === "string" ? p.msg : String(p.msg ?? ""),
        };
        if (p.data !== undefined) entry.data = p.data;
        log.ingest(entry);
        return { ok: true, result: null };
      }
      case "sseEvent": {
        const p = params as { json?: Record<string, unknown> | null; special?: string | null };
        // Structural events only — deltas are too chatty for stdout.
        const role = p.json?.role;
        if (p.special || (role && role !== "assistant")) {
          log
            .child("sse")
            .info(p.special ? `[${p.special}]` : String(role), p.special ? undefined : p.json);
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
        const p = params as { name?: string; args?: Record<string, unknown> };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        return { ok: true, result: resolvePermission(p.name, p.args) };
      }
      case "grantSession": {
        const p = params as { name?: string; scope?: string };
        const target = p?.scope || p?.name;
        if (!target) return { ok: false, error: "missing tool name or scope" };
        grantSession(target);
        return { ok: true, result: listToolStatus() };
      }
      case "setPermission": {
        const p = params as { name?: string; level?: Permission };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        if (!isPermission(p.level)) return { ok: false, error: "invalid permission" };
        return { ok: true, result: setToolPermission(p.name, p.level) };
      }
      case "mcpServers":
        return { ok: true, result: listMcpServersForUi() };
      case "mcpUpsert": {
        const p = params as {
          name?: string;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          enabled?: boolean;
        };
        if (!p?.name?.trim() || !p?.command?.trim()) return { ok: false, error: "name and command required" };
        try {
          upsertMcpServer({
            name: p.name,
            command: p.command,
            args: p.args,
            env: p.env,
            enabled: p.enabled,
          });
          return { ok: true, result: listMcpServersForUi() };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "mcpDelete": {
        const p = params as { name?: string };
        if (!p?.name) return { ok: false, error: "missing name" };
        return { ok: true, result: deleteMcpServer(p.name) ? listMcpServersForUi() : [] };
      }
      case "mcpSetEnabled": {
        const p = params as { name?: string; enabled?: boolean };
        if (!p?.name) return { ok: false, error: "missing name" };
        try {
          setMcpServerEnabled(p.name, p.enabled !== false);
          return { ok: true, result: listMcpServersForUi() };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "call": {
        const p = params as { name?: string; args?: Record<string, unknown> };
        if (!p?.name) return { ok: false, error: "missing tool name" };
        log.child("tool").info(`call ${p.name}`, p.args ?? {});
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


const isTest = process.env.NODE_ENV === "test";
if (isTest) {
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
}

// --- Core tools registration -----------------------------------------------

for (const tool of coreTools) {
  registerTool(tool);
}
