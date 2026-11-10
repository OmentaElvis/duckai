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

const DESC_MAX = 120;
const DEFAULT_LIMIT = 30;
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

function formatToolDetail(server: string, tool: McpToolDef): string {
  const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const lines: string[] = [
    `Tool: ${tool.name} (${server})`,
    `Description: ${tool.description ? tool.description.trim() : "No description."}`,
  ];
  const propKeys = Object.keys(props);
  if (propKeys.length === 0) {
    lines.push("Parameters: none");
  } else {
    lines.push("Parameters:");
    for (const key of propKeys) {
      const p = props[key] ?? {};
      const typeStr = propType(p);
      const reqStr = required.has(key) ? "required" : "optional";
      const desc = typeof p.description === "string" && p.description.trim() ? ` - ${p.description.trim()}` : "";
      lines.push(`  - ${key} (${typeStr}, ${reqStr})${desc}`);
    }
  }
  return lines.join("\n");
}

function formatToolList(server: string, tools: McpToolDef[]): string {
  if (tools.length === 0) return `No tools found for server "${server}".`;
  const lines: string[] = [`${server} tools (${tools.length}):`];
  for (const t of tools) {
    const desc = t.description ? `: ${trunc(t.description.trim(), DESC_MAX)}` : "";
    lines.push(`- ${t.name}${desc}`);
  }
  return lines.join("\n");
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
  description: "List an MCP server's tools (names + brief purpose), or inspect parameters for a specific tool.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "Name of the MCP server." },
      tool: { type: "string", description: "Optional name of a specific tool to inspect its parameters." },
      query: { type: "string", description: "Optional keyword to filter tools." },
      limit: { type: "integer", description: "Maximum tools to list (default 30)." },
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

    const requestedTool = typeof args.tool === "string" ? args.tool.trim() : "";
    if (requestedTool) {
      const match = tools.find((t) => t.name.toLowerCase() === requestedTool.toLowerCase());
      if (!match) {
        return { error: `Tool "${requestedTool}" not found on server "${server}".` };
      }
      return formatToolDetail(server, match);
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
    return formatToolList(server, page);
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
