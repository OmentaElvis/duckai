/** Pure MCP form/model helpers — no DOM, easy to unit test. */

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerUi {
  name: string;
  type: McpTransportKind;
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  envKeys: string[];
  headerKeys: string[];
}

export interface McpUpsert {
  name: string;
  type: McpTransportKind;
  command?: string;
  args: string[];
  /** Omit to preserve existing env values. */
  env?: Record<string, string>;
  url?: string;
  /** Omit to preserve existing header values. */
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpFormState {
  name: string;
  type: McpTransportKind;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  enabled: boolean;
}

export function emptyMcpForm(): McpFormState {
  return {
    name: "",
    type: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
    enabled: true,
  };
}

export function parseArgs(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

export function parseEnv(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const index = text.indexOf("=");
    if (index <= 0) continue;
    out[text.slice(0, index).trim()] = text.slice(index + 1);
  }
  return out;
}

/** Accept both `Name: Value` (HTTP headers) and `NAME=VALUE`. */
export function parseHeaders(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const colon = text.indexOf(":");
    const equals = text.indexOf("=");
    const index = colon >= 0 && (equals < 0 || colon < equals) ? colon : equals;
    if (index <= 0) continue;
    out[text.slice(0, index).trim()] = text.slice(index + 1).trim();
  }
  return out;
}

/** Editing keeps secrets opaque: env/headers start blank. */
export function formFromServer(server: McpServerUi): McpFormState {
  return {
    name: server.name,
    type: server.type,
    command: server.command,
    args: server.args.join(" "),
    env: "",
    url: server.url,
    headers: "",
    enabled: server.enabled,
  };
}

export function mcpStatus(servers: McpServerUi[]): string {
  return `${servers.filter((server) => server.enabled).length}/${servers.length} enabled`;
}
