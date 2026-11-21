import { describe, expect, test } from "bun:test";
import {
  emptyMcpForm,
  formFromServer,
  mcpStatus,
  parseArgs,
  parseEnv,
  parseHeaders,
  type McpServerUi,
} from "../src/injected/tools-model";

describe("MCP form parsing", () => {
  test("empty form defaults to an enabled stdio server", () => {
    expect(emptyMcpForm()).toEqual({
      name: "",
      type: "stdio",
      command: "",
      args: "",
      env: "",
      url: "",
      headers: "",
      enabled: true,
    });
  });

  test("args split on whitespace and ignore an empty string", () => {
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs("  mcp-server-gmail --verbose  ")).toEqual([
      "mcp-server-gmail",
      "--verbose",
    ]);
  });

  test("env parses KEY=VALUE lines and skips comments", () => {
    expect(parseEnv("# comment\nTOKEN=abc\nEMPTY=\nmalformed\n  SPACED = value  ")).toEqual({
      TOKEN: "abc",
      EMPTY: "",
      // Values keep leading whitespace; only the line and key are trimmed.
      SPACED: " value",
    });
  });

  test("headers accept both Name: Value and NAME=VALUE", () => {
    expect(
      parseHeaders("Authorization: Bearer token\nX-Api-Key=secret\n# ignored\ninvalid"),
    ).toEqual({
      Authorization: "Bearer token",
      "X-Api-Key": "secret",
    });
  });

  test("editing a server starts with blank secrets", () => {
    const server: McpServerUi = {
      name: "gmail",
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-gmail"],
      url: "",
      enabled: false,
      envKeys: ["TOKEN"],
      headerKeys: [],
    };
    const form = formFromServer(server);
    expect(form).toMatchObject({
      name: "gmail",
      type: "stdio",
      command: "uvx",
      args: "mcp-server-gmail",
      env: "",
      headers: "",
      enabled: false,
    });
  });
});

describe("mcpStatus", () => {
  test("reports enabled / total", () => {
    const base = {
      type: "stdio" as const,
      command: "",
      args: [],
      url: "",
      envKeys: [],
      headerKeys: [],
    };
    expect(
      mcpStatus([
        { ...base, name: "a", enabled: true },
        { ...base, name: "b", enabled: false },
        { ...base, name: "c", enabled: true },
      ]),
    ).toBe("2/3 enabled");
    expect(mcpStatus([])).toBe("0/0 enabled");
  });
});
