import type { Tool } from "../harness";
import {
  callMcpTool,
  getMcpTools,
  listMcpServerNames,
  type McpToolDef,
} from "../mcp/client";

// Lazy MCP gateway: 3 proxies only. Individual MCP tool schemas are
// never enumerated into the manifest; `mcp_tools` loads one server's
// compact summary on demand, `mcp_call` executes.

const DESC_MAX = 500;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_ARGS_BYTES = 32 * 1024;

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function propType(p: Record<string, unknown>): string {
  const base = Array.isArray(p.type)
    ? (p.type as unknown[]).map(String).join("|")
    : typeof p.type === "string"
      ? p.type
      : "any";
  if (Array.isArray(p.enum)) return `${base}:${(p.enum as unknown[]).map(String).join("|")}`;
  return base;
}

function summarize(tool: McpToolDef): Record<string, unknown> {
  const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [];
  const compact: Record<string, string> = {};
  for (const [name, def] of Object.entries(props)) compact[name] = propType(def ?? {});
  const out: Record<string, unknown> = { name: tool.name, props: compact };
  if (required.length) out.required = required;
  if (tool.description) out.desc = trunc(tool.description, DESC_MAX);
  return out;
}

function argsOf(a: Record<string, unknown>): Record<string, unknown> {
  const raw = a.arguments ?? a.args ?? {};
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export const mcpServersTool: Tool = {
  name: "mcp_servers",
  permission: "allow",
  description: "List MCP servers.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: () => ({ servers: listMcpServerNames() }),
};

export const mcpToolsTool: Tool = {
  name: "mcp_tools",
  permission: "allow",
  description: "List an MCP server's tools.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string" },
      query: { type: "string" },
      limit: { type: "integer" },
      detail: { type: "string", enum: ["summary", "full"] },
    },
    required: ["server"],
  },
  execute: async (args) => {
    const server = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
    if (!server) return { error: "server required" };
    let tools: McpToolDef[];
    try {
      tools = await getMcpTools(server);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const filtered = q
      ? tools.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.description ?? "").toLowerCase().includes(q),
        )
      : tools;
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_LIMIT),
    );
    const page = filtered.slice(0, limit);
    if (args.detail === "full") return { tools: page };
    return { tools: page.map(summarize) };
  },
};

export const mcpCallTool: Tool = {
  name: "mcp_call",
  permission: "ask",
  description: "Call an MCP server tool.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string" },
      tool: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["server", "tool", "arguments"],
  },
  execute: async (args) => {
    const server = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
    const tool = typeof args.tool === "string" ? args.tool.trim() : "";
    if (!server || !tool) return { error: "server required" };
    const callArgs = argsOf(args);
    if (Buffer.byteLength(JSON.stringify(callArgs)) > MAX_ARGS_BYTES) return { error: "args too large" };
    try {
      return await callMcpTool(server, tool, callArgs);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const mcpTools: Tool[] = [mcpServersTool, mcpToolsTool, mcpCallTool];
