import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  grantSession,
  handleHarnessCall,
  resolvePermission,
  type AuthorizationResult,
} from "../src/harness";

describe("granular tool permissions", () => {
  it("mcp_call produces tiered permission scopes and isolates tool approvals", async () => {
    const listIssuesArgs = { server: "github", tool: "list_issues" };
    const deleteRepoArgs = { server: "github", tool: "delete_repo" };
    const filesystemArgs = { server: "filesystem", tool: "delete_file" };

    // Initial check: ask
    const initial = resolvePermission("mcp_call", listIssuesArgs);
    expect(initial.level).toBe("ask");
    expect(initial.scopes.map((s) => s.id)).toEqual([
      "mcp:github:list_issues",
      "mcp:github:*",
      "mcp_call",
    ]);

    // Grant ONLY this specific tool
    grantSession("mcp:github:list_issues");

    // list_issues is now allowed
    const afterToolGrant = resolvePermission("mcp_call", listIssuesArgs);
    expect(afterToolGrant.level).toBe("allow");
    expect(afterToolGrant.source).toBe("session");

    // Other tools on github server are STILL ask (not free game!)
    const deleteRepoCheck = resolvePermission("mcp_call", deleteRepoArgs);
    expect(deleteRepoCheck.level).toBe("ask");

    // Other MCP servers are STILL ask
    const filesystemCheck = resolvePermission("mcp_call", filesystemArgs);
    expect(filesystemCheck.level).toBe("ask");

    // Grant server-level wildcard
    grantSession("mcp:github:*");

    // Now delete_repo on github is allowed
    const afterServerGrant = resolvePermission("mcp_call", deleteRepoArgs);
    expect(afterServerGrant.level).toBe("allow");
    expect(afterServerGrant.source).toBe("session");

    // Filesystem server is STILL ask
    expect(resolvePermission("mcp_call", filesystemArgs).level).toBe("ask");
  });

  it("run_command produces tiered command line / binary scopes", async () => {
    const gitStatusArgs = { command: "git status" };
    const gitDiffArgs = { command: "git diff && git status" };
    const dangerousArgs = { command: "rm -rf /tmp/test" };

    const initial = resolvePermission("run_command", gitDiffArgs);
    expect(initial.level).toBe("ask");
    expect(initial.scopes.map((s) => s.id)).toEqual([
      "cmd:git diff && git status",
      "bin:git:*",
      "run_command",
    ]);

    // Grant exact command line
    grantSession("cmd:git status");

    // Exact command is allowed
    expect(resolvePermission("run_command", gitStatusArgs).level).toBe("allow");

    // Different command with git is still ask
    expect(resolvePermission("run_command", gitDiffArgs).level).toBe("ask");

    // Grant binary wildcard for git
    grantSession("bin:git:*");

    // Now any git command is allowed
    expect(resolvePermission("run_command", gitDiffArgs).level).toBe("allow");

    // Dangerous non-git command is still ask!
    expect(resolvePermission("run_command", dangerousArgs).level).toBe("ask");
  });

  it("file tools isolate permissions to specific files and directories", async () => {
    const targetFile = resolve("/tmp/duckai_test_project/config.json");
    const sameDirFile = resolve("/tmp/duckai_test_project/secret.key");
    const otherDirFile = resolve("/tmp/other_project/file.txt");

    const writeArgs = { path: targetFile, content: "{}" };
    const initial = resolvePermission("write_file", writeArgs);
    expect(initial.level).toBe("ask");
    expect(initial.scopes.map((s) => s.id)).toEqual([
      `file:${targetFile}`,
      `dir:${resolve("/tmp/duckai_test_project")}:*`,
      "write_file",
    ]);

    // Grant ONLY this file
    grantSession(`file:${targetFile}`);

    // Writing to config.json is allowed
    expect(resolvePermission("write_file", writeArgs).level).toBe("allow");

    // Writing to secret.key in same directory is still ask!
    expect(resolvePermission("write_file", { path: sameDirFile, content: "x" }).level).toBe("ask");

    // Grant directory scope
    grantSession(`dir:${resolve("/tmp/duckai_test_project")}:*`);

    // secret.key in same dir is now allowed
    expect(resolvePermission("write_file", { path: sameDirFile, content: "x" }).level).toBe("allow");

    // Other project file is STILL ask!
    expect(resolvePermission("write_file", { path: otherDirFile, content: "y" }).level).toBe("ask");
  });

  it("handleHarnessCall wires authorize with args and grantSession with scope", async () => {
    const authRes = (await handleHarnessCall({
      method: "authorize",
      params: {
        name: "mcp_call",
        args: { server: "weather", tool: "get_temp" },
      },
    })) as { ok: boolean; result: AuthorizationResult };

    expect(authRes.ok).toBe(true);
    expect(authRes.result.level).toBe("ask");
    expect(authRes.result.scopes[0]?.id).toBe("mcp:weather:get_temp");

    // Grant session using the new scope param
    const grantRes = (await handleHarnessCall({
      method: "grantSession",
      params: {
        name: "mcp_call",
        scope: "mcp:weather:get_temp",
      },
    })) as { ok: boolean };
    expect(grantRes.ok).toBe(true);

    // Re-check: now allowed
    const recheckRes = (await handleHarnessCall({
      method: "authorize",
      params: {
        name: "mcp_call",
        args: { server: "weather", tool: "get_temp" },
      },
    })) as { ok: boolean; result: AuthorizationResult };
    expect(recheckRes.result.level).toBe("allow");

    // Calling another tool on weather is still ask
    const otherCheck = (await handleHarnessCall({
      method: "authorize",
      params: {
        name: "mcp_call",
        args: { server: "weather", tool: "forecast" },
      },
    })) as { ok: boolean; result: AuthorizationResult };
    expect(otherCheck.result.level).toBe("ask");
  });
});
