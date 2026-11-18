import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../logging/host";
import { VERSION } from "../version";
import {
  HttpTransport,
  McpSessionExpiredError,
  SseTransport,
  StdioTransport,
  type JsonRpcMessage,
  type McpTransport,
  type NotificationHandler,
} from "./transports";

// Minimal MCP client (tools-only) + lazy manager.
//
// Transports: stdio child processes, Streamable HTTP and legacy HTTP+SSE.
// Nothing is enumerated at startup — discovery is delegated to the `mcp_*`
// proxy tools, so N servers cost ~0 prompt tokens. Clients are created on
// first use and reused until the config changes.

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerConfig {
  type: McpTransportKind;
  /** stdio only. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** http/sse only. */
  url: string;
  /** http/sse only. Secrets (e.g. Authorization) live here. */
  headers: Record<string, string>;
  enabled: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 64 * 1024;

export function mcpConfigPath(): string {
  return process.env.DUCKAI_MCP_CONFIG_PATH || join(homedir(), ".duckai", "mcp.json");
}

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = String(value);
    }
  }
  return out;
}

function transportKind(raw: unknown, hasUrl: boolean): McpTransportKind {
  if (typeof raw !== "string") return hasUrl ? "http" : "stdio";
  switch (raw.trim().toLowerCase()) {
    case "http":
    case "streamable-http":
    case "streamablehttp":
    case "streamable":
      return "http";
    case "sse":
      return "sse";
    case "stdio":
      return "stdio";
    default:
      return hasUrl ? "http" : "stdio";
  }
}

function validConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const command = typeof c.command === "string" ? c.command.trim() : "";
  const url = typeof c.url === "string" ? c.url.trim() : "";
  const type = transportKind(c.type ?? c.transport, Boolean(url));
  if (type === "stdio" ? !command : !url) return null;
  if (type !== "stdio" && !/^https?:\/\//i.test(url)) return null;
  return {
    type,
    command,
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    env: stringMap(c.env),
    url,
    headers: stringMap(c.headers),
    enabled: c.enabled !== false,
  };
}

/** All configured servers (enabled + disabled), for the management UI. */
export function loadAllMcpServers(): Record<string, McpServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpConfigPath(), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  // Accept `{"servers":{…}}` (our format), `{"mcpServers":{…}}` (common in
  // other MCP clients) or a bare map of server name → config.
  const nested = record.servers ?? record.mcpServers;
  const root = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  if (!root || typeof root !== "object") return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(root)) {
    const key = name.trim().toLowerCase();
    if (!NAME_RE.test(key)) continue;
    const cfg = validConfig(raw);
    if (cfg) out[key] = cfg;
  }
  return out;
}

/** Load configured servers (enabled only). Supports `{"servers":{…}}` or a bare map. */
export function loadMcpServers(): Record<string, McpServerConfig> {
  const all = loadAllMcpServers();
  const out: Record<string, McpServerConfig> = {};
  for (const [k, v] of Object.entries(all)) if (v.enabled) out[k] = v;
  return out;
}

function saveMcpServers(all: Record<string, McpServerConfig>): void {
  const path = mcpConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const sorted: Record<string, McpServerConfig> = {};
  for (const k of Object.keys(all).sort()) sorted[k] = all[k]!;
  writeFileSync(path, `${JSON.stringify({ servers: sorted }, null, 2)}\n`);
}

export function closeMcpClient(name: string): void {
  const key = name.trim().toLowerCase();
  clients.get(key)?.client.close();
  clients.delete(key);
}

export interface McpUpsertInput {
  name: string;
  type?: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Create or update a server. Omit `env`/`headers` to preserve existing secrets. */
export function upsertMcpServer(input: McpUpsertInput): McpServerConfig {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("invalid server name");
  const all = loadAllMcpServers();
  const prev = all[name];
  const url = input.url?.trim() ?? prev?.url ?? "";
  const type =
    input.type ??
    prev?.type ??
    (url ? "http" : "stdio");
  const command = input.command?.trim() ?? prev?.command ?? "";
  if (type === "stdio" && !command) throw new Error("command required");
  if (type !== "stdio") {
    if (!url) throw new Error("url required");
    if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  }
  const cfg: McpServerConfig = {
    type,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : (prev?.args ?? []),
    env: input.env ?? prev?.env ?? {},
    url,
    headers: input.headers ?? prev?.headers ?? {},
    enabled: input.enabled ?? prev?.enabled ?? true,
  };
  all[name] = cfg;
  saveMcpServers(all);
  if (!cfg.enabled) closeMcpClient(name);
  return cfg;
}

export function deleteMcpServer(name: string): boolean {
  const key = name.trim().toLowerCase();
  const all = loadAllMcpServers();
  if (!(key in all)) return false;
  delete all[key];
  saveMcpServers(all);
  closeMcpClient(key);
  return true;
}

export function setMcpServerEnabled(name: string, enabled: boolean): McpServerConfig {
  const key = name.trim().toLowerCase();
  const all = loadAllMcpServers();
  const cfg = all[key];
  if (!cfg) throw new Error("unknown server");
  cfg.enabled = enabled;
  saveMcpServers(all);
  if (!enabled) closeMcpClient(key);
  return cfg;
}

export interface McpServerUi {
  name: string;
  type: McpTransportKind;
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  /** Env/header names only — values are never sent to the page. */
  envKeys: string[];
  headerKeys: string[];
}

/** Sanitized server list for the page UI (no env/header values). */
export function listMcpServersForUi(): McpServerUi[] {
  return Object.entries(loadAllMcpServers())
    .map(([name, cfg]) => ({
      name,
      type: cfg.type,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      enabled: cfg.enabled,
      envKeys: Object.keys(cfg.env).sort(),
      headerKeys: Object.keys(cfg.headers).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function createTransport(
  cfg: McpServerConfig,
  onNotification: NotificationHandler,
  onClose: () => void,
): McpTransport {
  if (cfg.type === "http") return new HttpTransport(cfg, onNotification, onClose);
  if (cfg.type === "sse") return new SseTransport(cfg, onNotification, onClose);
  return new StdioTransport(cfg, onNotification, onClose);
}

class McpClient {
  private transport: McpTransport;
  private nextId = 1;
  private toolsCache: McpToolDef[] | null = null;
  private toolsCacheAt = 0;
  private ready: Promise<void>;
  private closed = false;
  private sessionRecovery: Promise<void> | null = null;

  constructor(
    cfg: McpServerConfig,
    private onClose: () => void,
  ) {
    this.transport = createTransport(
      cfg,
      (message) => this.onNotification(message),
      () => this.fail(new Error("mcp transport closed")),
    );
    this.ready = this.handshake().catch((error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    // Mark the rejection as handled even if no request observes it; callers
    // still get the original rejection from `this.ready`.
    void this.ready.catch(() => {});
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
    log.child("mcp").debug("client closed", error.message);
    this.onClose();
  }

  private onNotification(message: JsonRpcMessage): void {
    if (message.method === "notifications/tools/list_changed") {
      this.toolsCache = null;
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return this.transport.request({ jsonrpc: "2.0", id, method, params }, REQUEST_TIMEOUT_MS);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    try {
      return await this.sendRequest(method, params);
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      // Streamable HTTP sessions can expire server-side. Re-initialize once
      // and retry, sharing the recovery across concurrent callers.
      this.toolsCache = null;
      const recovery = this.sessionRecovery ??= this.handshake().finally(() => {
        this.sessionRecovery = null;
      });
      await recovery;
      return this.sendRequest(method, params);
    }
  }

  private async handshake(): Promise<void> {
    await this.transport.start();
    const result = (await this.transport.request(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: this.transport.initialProtocolVersion,
          capabilities: {},
          clientInfo: { name: "duckai", version: VERSION },
        },
      },
      REQUEST_TIMEOUT_MS,
    )) as { protocolVersion?: unknown } | undefined;
    const version =
      typeof result?.protocolVersion === "string"
        ? result.protocolVersion
        : this.transport.initialProtocolVersion;
    this.transport.initialized(version);
    await this.transport.notify(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      REQUEST_TIMEOUT_MS,
    );
  }

  async tools(): Promise<McpToolDef[]> {
    await this.ready;
    const ttl = this.transport.toolListTtlMs;
    if (this.toolsCache && Date.now() - this.toolsCacheAt < ttl) return this.toolsCache;
    const res = (await this.request("tools/list", {})) as { tools?: unknown };
    const tools = Array.isArray(res?.tools) ? (res.tools as McpToolDef[]) : [];
    this.toolsCache = tools.filter((tool) => tool && typeof tool.name === "string");
    this.toolsCacheAt = Date.now();
    return this.toolsCache;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }
}

// --- lazy manager: one client per server, respawned if its config changes ---

const clients = new Map<string, { sig: string; client: McpClient }>();

function sig(cfg: McpServerConfig): string {
  return JSON.stringify([
    cfg.type,
    cfg.command,
    cfg.args,
    cfg.env,
    cfg.url,
    cfg.headers,
  ]);
}

async function getClient(server: string): Promise<McpClient> {
  const key = server.trim().toLowerCase();
  const cfg = loadMcpServers()[key];
  if (!cfg) throw new Error("unknown server");
  const nextSig = sig(cfg);
  const existing = clients.get(key);
  if (existing && existing.sig === nextSig) return existing.client;
  existing?.client.close();
  const client = new McpClient(cfg, () => {
    if (clients.get(key)?.client === client) clients.delete(key);
  });
  clients.set(key, { sig: nextSig, client });
  return client;
}

export function listMcpServerNames(): string[] {
  return Object.keys(loadMcpServers()).sort();
}

export async function getMcpTools(server: string): Promise<McpToolDef[]> {
  return (await getClient(server)).tools();
}

function capText(s: string): string {
  return s.length > MAX_RESULT_BYTES ? `${s.slice(0, MAX_RESULT_BYTES)}\n… [truncated]` : s;
}

/** Flatten an MCP call result to a token-lean value for the model. */
export function flattenMcpResult(result: unknown, isError?: boolean): unknown {
  const r = (result ?? {}) as { structuredContent?: unknown; content?: unknown };
  if (r.structuredContent !== undefined) return r.structuredContent;
  const content = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
  const texts = content.filter((c) => c?.type === "text").map((c) => String(c.text ?? ""));
  const text = texts.length && content.length === texts.length ? texts.join("\n") : "";
  if (text) return isError ? { error: capText(text) } : { text: capText(text) };
  if (content.length) return { content };
  return result ?? {};
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = await getClient(server);
  const result = (await client.call(tool, args)) as { isError?: boolean } & Record<string, unknown>;
  return flattenMcpResult(result, Boolean(result?.isError));
}

/** Kill all spawned MCP servers / close HTTP sessions (tests / shutdown). */
export function closeAllMcpClients(): void {
  for (const { client } of clients.values()) client.close();
  clients.clear();
}
