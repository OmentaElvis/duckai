import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../logging/host";

// Minimal MCP client (stdio, tools-only) + lazy manager.
// Only one stdio process per configured server, spawned on first use
// and reused. The harness enumerates nothing — discovery is delegated
// to the `mcp_*` proxy tools, so N servers cost ~0 prompt tokens.

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
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

function validConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.command !== "string" || !c.command.trim()) return null;
  const args = Array.isArray(c.args) ? c.args.map(String) : [];
  const env: Record<string, string> = {};
  if (c.env && typeof c.env === "object") {
    for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) env[k] = String(v);
  }
  return { command: c.command, args, env, enabled: c.enabled !== false };
}

/** All configured servers (enabled + disabled), for the management UI. */
export function loadAllMcpServers(): Record<string, McpServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpConfigPath(), "utf8"));
  } catch {
    return {};
  }
  const root =
    parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).servers &&
    typeof (parsed as Record<string, unknown>).servers === "object"
      ? ((parsed as Record<string, unknown>).servers as Record<string, unknown>)
      : (parsed as Record<string, unknown> | null);
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

/** Create or update a server. Omit `env` to preserve existing env values. */
export function upsertMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}): McpServerConfig {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("invalid server name");
  const command = input.command.trim();
  if (!command) throw new Error("command required");
  const all = loadAllMcpServers();
  const prev = all[name];
  const cfg: McpServerConfig = {
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    env: input.env ?? prev?.env ?? {},
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
  command: string;
  args: string[];
  enabled: boolean;
  /** Env var names only — values are never sent to the page. */
  envKeys: string[];
}

/** Sanitized server list for the page UI (no env values). */
export function listMcpServersForUi(): McpServerUi[] {
  return Object.entries(loadAllMcpServers())
    .map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      enabled: cfg.enabled,
      envKeys: Object.keys(cfg.env).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class McpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private toolsCache: McpToolDef[] | null = null;
  private ready: Promise<void>;

  constructor(private cfg: McpServerConfig) {
    this.proc = Bun.spawn([cfg.command, ...cfg.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...cfg.env },
    });
    this.drainStderr();
    this.readLoop();
    this.proc.exited.then(() => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("mcp server exited"));
      }
      this.pending.clear();
    });
    this.ready = this.handshake();
  }

  private async drainStderr(): Promise<void> {
    try {
      const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const line = dec.decode(value, { stream: true }).trim();
        if (line) log.child("mcp").debug("stderr", line.slice(0, 200));
      }
    } catch {
      /* process ended */
    }
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg: { id?: unknown; result?: unknown; error?: { message?: string }; method?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(String(msg.error.message ?? "mcp error")));
            else p.resolve(msg.result);
          } else if (msg.method === "notifications/tools/list_changed") {
            this.toolsCache = null;
          }
        }
      }
    } catch {
      /* process ended */
    }
  }

  private send(msg: Record<string, unknown>): void {
    (this.proc.stdin as unknown as { write: (s: string) => void }).write(
      `${JSON.stringify(msg)}\n`,
    );
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("mcp timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async handshake(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "duckai", version: "0.1.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async tools(): Promise<McpToolDef[]> {
    await this.ready;
    if (this.toolsCache) return this.toolsCache;
    const res = (await this.request("tools/list", {})) as { tools?: unknown };
    const tools = Array.isArray(res?.tools) ? (res.tools as McpToolDef[]) : [];
    this.toolsCache = tools.filter((t) => t && typeof t.name === "string");
    return this.toolsCache;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }
}

// --- lazy manager: one client per server, respawned if its config changes ---

const clients = new Map<string, { sig: string; client: McpClient }>();

function sig(cfg: McpServerConfig): string {
  return JSON.stringify([cfg.command, cfg.args, cfg.env]);
}

async function getClient(server: string): Promise<McpClient> {
  const cfg = loadMcpServers()[server.trim().toLowerCase()];
  if (!cfg) throw new Error("unknown server");
  const s = sig(cfg);
  const existing = clients.get(server.trim().toLowerCase());
  if (existing && existing.sig === s) return existing.client;
  existing?.client.close();
  const client = new McpClient(cfg);
  clients.set(server.trim().toLowerCase(), { sig: s, client });
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

/** Kill all spawned MCP servers (tests / shutdown). */
export function closeAllMcpClients(): void {
  for (const { client } of clients.values()) client.close();
  clients.clear();
}
