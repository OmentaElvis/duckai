import type { Tool } from "../harness";
import {
  callMcpTool,
  getMcpTools,
  listMcpServerNames,
  type McpToolDef,
} from "../mcp/client";

// Lazy MCP gateway: 4 proxies only. Individual MCP tool schemas are
// never enumerated into the manifest; `mcp_tools` loads one server's
// compact summary on demand, `mcp_schema` renders one tool's full
// schema, `mcp_call` executes.

const DESC_MAX = 120;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const MAX_ARGS_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 6;

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function asSchema(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Type keyword for a schema node, inferring from shape when `type` is absent. */
function typeLabel(p: Record<string, unknown>): string {
  let base = Array.isArray(p.type)
    ? (p.type as unknown[]).map(String).join("|")
    : typeof p.type === "string"
      ? p.type
      : p.properties
        ? "object"
        : p.items
          ? "array"
          : p.anyOf || p.oneOf
            ? "union"
            : "any";
  if (base === "array") {
    const inner = typeLabel(asSchema(p.items));
    if (inner !== "any") base = `array<${inner}>`;
  }
  if (Array.isArray(p.enum)) base = `${base}:${(p.enum as unknown[]).map(String).join("|")}`;
  return base;
}

/** Compact `key=value` markers for the schema constraints JSON spells out verbosely. */
function constraintSuffix(p: Record<string, unknown>): string {
  const bits: string[] = [];
  if (p.default !== undefined) {
    // Strings get single quotes so defaults don't read as JSON noise.
    const d =
      typeof p.default === "string"
        ? `'${trunc(p.default, 40)}'`
        : JSON.stringify(p.default);
    if (d !== undefined) bits.push(`default=${d}`);
  }
  if (p.additionalProperties === false) bits.push("additionalProperties=false");
  const keys = [
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ];
  for (const k of keys) {
    const v = p[k];
    if (v !== undefined && v !== null && typeof v !== "object") bits.push(`${k}=${String(v)}`);
  }
  return bits.length ? ` [${bits.join(" ")}]` : "";
}

function formatToolDetail(server: string, tool: McpToolDef): string {
  const schema = asSchema(tool.inputSchema);
  const props = asSchema(schema.properties);
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
      const p = asSchema(props[key]);
      const typeStr = typeLabel(p);
      const reqStr = required.has(key) ? "required" : "optional";
      const desc = typeof p.description === "string" && p.description.trim() ? ` - ${p.description.trim()}` : "";
      lines.push(`  - ${key} (${typeStr}, ${reqStr})${desc}`);
    }
  }
  return lines.join("\n");
}

/**
 * Full schema for one tool, rendered as an indented tree.
 *
 * Deliberately not raw JSON: a JSON Schema repeats `"type":`, `"properties":`,
 * `"required":`, quotes and braces on every node, which costs several times the
 * tokens of the equivalent tree while carrying no extra information. Every
 * schema fact (types, enums, nesting, required/optional, defaults, constraints)
 * is preserved — just without the syntactic overhead.
 */
function renderSchemaNode(
  lines: string[],
  key: string | null,
  p: Record<string, unknown>,
  depth: number,
  required: boolean,
): void {
  const indent = "  ".repeat(depth + 1);
  const label = key ? `${key} ` : "";
  const desc = typeof p.description === "string" && p.description.trim() ? ` - ${p.description.trim()}` : "";
  const reqStr = required ? "required" : "optional";
  lines.push(`${indent}- ${label}(${typeLabel(p)}, ${reqStr})${constraintSuffix(p)}${desc}`);
  if (depth >= MAX_SCHEMA_DEPTH) return;

  const props = asSchema(p.properties);
  const propReq = new Set(Array.isArray(p.required) ? p.required.map(String) : []);
  for (const [k, v] of Object.entries(props)) {
    renderSchemaNode(lines, k, asSchema(v), depth + 1, propReq.has(k));
  }

  const items = asSchema(p.items);
  const itemProps = asSchema(items.properties);
  const itemReq = new Set(Array.isArray(items.required) ? items.required.map(String) : []);
  for (const [k, v] of Object.entries(itemProps)) {
    renderSchemaNode(lines, `[] ${k}`, asSchema(v), depth + 1, itemReq.has(k));
  }

  for (const union of [p.anyOf, p.oneOf]) {
    if (Array.isArray(union)) {
      for (const alt of union) renderSchemaNode(lines, "|", asSchema(alt), depth + 1, false);
    }
  }

  if (p.additionalProperties && typeof p.additionalProperties === "object") {
    renderSchemaNode(lines, "*", asSchema(p.additionalProperties), depth + 1, false);
  }
}

function formatToolSchema(server: string, tool: McpToolDef): string {
  const schema = asSchema(tool.inputSchema);
  const lines: string[] = [
    `Tool: ${tool.name} (${server})`,
    `Description: ${tool.description ? tool.description.trim() : "No description."}`,
    `Schema: ${typeLabel(schema)}${constraintSuffix(schema)}`,
  ];
  const props = asSchema(schema.properties);
  const propKeys = Object.keys(props);
  if (propKeys.length === 0) {
    lines.push("  (no parameters)");
    return lines.join("\n");
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  for (const key of propKeys) {
    renderSchemaNode(lines, key, asSchema(props[key]), 0, required.has(key));
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

async function loadTools(server: string): Promise<{ tools: McpToolDef[] } | { error: string }> {
  try {
    return { tools: await getMcpTools(server) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function findTool(tools: McpToolDef[], name: string): McpToolDef | undefined {
  const needle = name.toLowerCase();
  return tools.find((t) => t.name.toLowerCase() === needle);
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
      tool: {
        type: "string",
        description: "Optional name of a specific tool to inspect its parameters. Use mcp_schema for the full (nested) schema.",
      },
      limit: { type: "integer", description: "Maximum tools to list (default 30)." },
    },
    required: ["server"],
  },
  execute: async (args) => {
    const server = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
    if (!server) return { error: "server required" };
    const loaded = await loadTools(server);
    if ("error" in loaded) return loaded;
    const tools = loaded.tools;

    const requestedTool = typeof args.tool === "string" ? args.tool.trim() : "";
    if (requestedTool) {
      const match = findTool(tools, requestedTool);
      if (!match) {
        return { error: `Tool "${requestedTool}" not found on server "${server}".` };
      }
      return formatToolDetail(server, match);
    }

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_LIMIT),
    );
    return formatToolList(server, tools.slice(0, limit));
  },
};

export const mcpSchemaTool: Tool = {
  name: "mcp_schema",
  permission: "allow",
  description:
    "Fetch the full schema of one MCP tool: parameter types, nesting, enums, defaults and constraints.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "Name of the MCP server." },
      tool: { type: "string", description: "Name of the tool to fetch the schema for." },
    },
    required: ["server", "tool"],
  },
  execute: async (args) => {
    const server = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
    if (!server) return { error: "server required" };
    const toolName = typeof args.tool === "string" ? args.tool.trim() : "";
    if (!toolName) return { error: "tool required" };
    const loaded = await loadTools(server);
    if ("error" in loaded) return loaded;
    const match = findTool(loaded.tools, toolName);
    if (!match) return { error: `Tool "${toolName}" not found on server "${server}".` };
    return formatToolSchema(server, match);
  },
};

export const mcpCallTool: Tool = {
  name: "mcp_call",
  permission: "ask",
  description: "Call an MCP server tool.",
  permissionScopes: (args) => {
    const server = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
    const tool = typeof args.tool === "string" ? args.tool.trim() : "";
    if (!server || !tool) {
      return [{ id: "mcp_call", label: "All MCP calls across all servers", isDefault: true }];
    }
    return [
      {
        id: `mcp:${server}:${tool}`,
        label: `This tool only (${tool} on ${server})`,
        description: `Only auto-approve "${tool}" on server "${server}"`,
        isDefault: true,
      },
      {
        id: `mcp:${server}:*`,
        label: `All tools on server "${server}"`,
        description: `Auto-approve any tool called on the "${server}" server`,
      },
      {
        id: "mcp_call",
        label: "All MCP tools across all servers",
        description: "Auto-approve every tool from every MCP server",
      },
    ];
  },
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

export const mcpTools: Tool[] = [mcpServersTool, mcpToolsTool, mcpSchemaTool, mcpCallTool];
