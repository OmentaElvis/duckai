import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, handleHarnessCall } from "../src/harness";
import { closeAllMcpClients, loadAllMcpServers } from "../src/mcp/client";

let testDir = "";
let serverPath = "";
let configPath = "";
const prev = process.env.DUCKAI_MCP_CONFIG_PATH;

beforeAll(() => {
  testDir = join(tmpdir(), `duckai-mcp-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  serverPath = join(testDir, "fake-server.js");
  configPath = join(testDir, "mcp.json");
  writeFileSync(
    serverPath,
    `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } else if (msg.method === "notifications/initialized") {
    return;
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo text back to the caller verbatim so the agent can confirm roundtrip behavior without any transformation applied to the payload", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (args.text ?? "") }] } });
    else if (name === "fail") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
`,
  );
  writeFileSync(
    configPath,
    JSON.stringify({ servers: { fake: { command: "bun", args: [serverPath] } } }),
  );
  process.env.DUCKAI_MCP_CONFIG_PATH = configPath;
});

afterAll(() => {
  closeAllMcpClients();
  if (prev === undefined) delete process.env.DUCKAI_MCP_CONFIG_PATH;
  else process.env.DUCKAI_MCP_CONFIG_PATH = prev;
  rmSync(testDir, { recursive: true, force: true });
});

describe("mcp gateway", () => {
  test("mcp_servers lists configured servers without spawning schemas", async () => {
    const res = (await executeTool("mcp_servers", {})) as { servers: string[] };
    expect(res.servers).toEqual(["fake"]);
  });

  test("mcp_tools returns token-lean plain text list and honors query", async () => {
    const res = (await executeTool("mcp_tools", { server: "fake" })) as string;
    expect(typeof res).toBe("string");
    expect(res).toContain("fake tools (2):");
    expect(res).toContain("- echo:");
    expect(res).toContain("- fail:");
    // Zero JSON syntax noise and zero parameter dumps in listing
    expect(res).not.toContain("inputSchema");
    expect(res).not.toContain("props");
    expect(res).not.toContain("required");

    const filtered = (await executeTool("mcp_tools", { server: "fake", query: "echo" })) as string;
    expect(filtered).toContain("- echo:");
    expect(filtered).not.toContain("- fail:");
  });

  test("mcp_tools inspects single tool parameters in plain text", async () => {
    const detail = (await executeTool("mcp_tools", { server: "fake", tool: "echo" })) as string;
    expect(typeof detail).toBe("string");
    expect(detail).toContain("Tool: echo (fake)");
    expect(detail).toContain("Parameters:");
    expect(detail).toContain("text (string, required)");
    // Does not dump unrequested tools
    expect(detail).not.toContain("fail");
  });

  test("mcp_call flattens text and surfaces isError", async () => {
    const ok = (await executeTool("mcp_call", {
      server: "fake",
      tool: "echo",
      arguments: { text: "hi" },
    })) as { text?: string; error?: string };
    expect(ok).toEqual({ text: "echo:hi" });

    const bad = (await executeTool("mcp_call", {
      server: "fake",
      tool: "fail",
      arguments: {},
    })) as { error?: string };
    expect(bad.error).toContain("kaboom");
  });

  test("unknown server and unknown tool are errors, not crashes", async () => {
    const res = (await executeTool("mcp_tools", { server: "nope" })) as { error?: string };
    expect(res.error).toBeDefined();
    const res2 = (await executeTool("mcp_call", {
      server: "fake",
      tool: "nope",
      arguments: {},
    })) as { error?: string };
    expect(res2.error).toBeDefined();
  });

  test("adding a server is config-only (hot reload, no restart)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          fake: { command: "bun", args: [serverPath] },
          fake2: { command: "bun", args: [serverPath] },
        },
      }),
    );
    const res = (await executeTool("mcp_servers", {})) as { servers: string[] };
    expect(res.servers).toEqual(["fake", "fake2"]);
    const tools = (await executeTool("mcp_tools", { server: "fake2" })) as string;
    expect(tools).toContain("fake2 tools");
  });

  test("UI config API: upsert/list/delete without leaking env values", async () => {
    const saved = process.env.DUCKAI_MCP_CONFIG_PATH;
    process.env.DUCKAI_MCP_CONFIG_PATH = join(testDir, "ui-mcp.json");
    try {
      const created = (await handleHarnessCall({
        method: "mcpUpsert",
        params: { name: "Gmail", command: "uvx", args: ["mcp-gmail"], env: { GOOGLE_TOKEN: "secret123" }, enabled: true },
      })) as { ok: boolean; result: Array<{ name: string; envKeys: string[] }> };
      expect(created.ok).toBe(true);
      expect(created.result).toEqual([
        expect.objectContaining({ name: "gmail", command: "uvx", envKeys: ["GOOGLE_TOKEN"] }),
      ]);
      expect(JSON.stringify(created.result)).not.toContain("secret123");

      // Edit without env preserves the stored secret.
      await handleHarnessCall({ method: "mcpUpsert", params: { name: "gmail", command: "uvx", args: ["mcp-gmail2"] } });
      expect(loadAllMcpServers().gmail?.env).toEqual({ GOOGLE_TOKEN: "secret123" });
      expect(loadAllMcpServers().gmail?.args).toEqual(["mcp-gmail2"]);

      // Disable hides it from the agent-facing list but keeps it for the UI.
      await handleHarnessCall({ method: "mcpSetEnabled", params: { name: "gmail", enabled: false } });
      expect((await executeTool("mcp_servers", {})) as { servers: string[] }).toEqual({ servers: [] });
      const ui = (await handleHarnessCall({ method: "mcpServers" })) as {
        result: Array<{ name: string; enabled: boolean }>;
      };
      expect(ui.result[0]).toMatchObject({ name: "gmail", enabled: false });

      await handleHarnessCall({ method: "mcpDelete", params: { name: "gmail" } });
      expect(loadAllMcpServers().gmail).toBeUndefined();
    } finally {
      process.env.DUCKAI_MCP_CONFIG_PATH = saved;
    }
  });
});
