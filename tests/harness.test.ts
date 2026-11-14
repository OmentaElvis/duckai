import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAvailableUpdate,
  handleHarnessCall,
  listManifest,
  listTools,
  setAvailableUpdate,
  setReloadHandler,
} from "../src/harness";

// Isolate persisted tool settings so tests never touch ~/.duckai/settings.json.
let settingsPath = "";
beforeAll(() => {
  settingsPath = join(tmpdir(), `duckai-settings-test-${Date.now()}.json`);
  process.env.DUCKAI_SETTINGS_PATH = settingsPath;
});
afterAll(() => {
  delete process.env.DUCKAI_SETTINGS_PATH;
  rmSync(settingsPath, { force: true });
});

describe("harness bridge", () => {
  test("ping responds", async () => {
    const res = (await handleHarnessCall({ method: "ping" })) as { ok: boolean; result: unknown };
    expect(res.ok).toBe(true);
    expect((res.result as { pong: number }).pong).toBeGreaterThan(0);
  });

  test("manifest lists echo tool", async () => {
    const res = (await handleHarnessCall({ method: "manifest" })) as {
      ok: boolean;
      result: { name: string }[];
    };
    expect(res.ok).toBe(true);
    expect(res.result.map((t) => t.name)).toContain("echo");
    expect(listManifest()[0]!.parameters).toBeDefined();
  });

  test("tools list reports enabled state and disabling filters the manifest", async () => {
    const all = await handleHarnessCall({ method: "tools" });
    const before = (all as { result: { name: string; enabled: boolean }[] }).result;
    expect(before.find((t) => t.name === "echo")?.enabled).toBe(true);

    const off = await handleHarnessCall({
      method: "setToolEnabled",
      params: { name: "echo", enabled: false },
    });
    const after = (off as { result: { name: string; enabled: boolean }[] }).result;
    expect(after.find((t) => t.name === "echo")?.enabled).toBe(false);
    expect(listManifest().map((t) => t.name)).not.toContain("echo");
    expect(listTools().find((t) => t.name === "echo")?.enabled).toBe(false);

    await handleHarnessCall({
      method: "setToolEnabled",
      params: { name: "echo", enabled: true },
    });
    expect(listManifest().map((t) => t.name)).toContain("echo");
  });

  test("setToolEnabled rejects unknown tools", async () => {
    const res = (await handleHarnessCall({
      method: "setToolEnabled",
      params: { name: "nope", enabled: false },
    })) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown tool");
  });

  test("permission resolves: default → session grant → explicit policy", async () => {
    const auth = async (name: string) =>
      (
        (await handleHarnessCall({ method: "authorize", params: { name } })) as {
          result: { level: string; source: string };
        }
      ).result;

    expect(await auth("echo")).toMatchObject({ level: "allow", source: "default" });
    expect(await auth("todo_add")).toMatchObject({ level: "ask", source: "default" });

    await handleHarnessCall({ method: "grantSession", params: { name: "todo_add" } });
    expect(await auth("todo_add")).toMatchObject({ level: "allow", source: "session" });
    // A session grant must not be persisted.
    const saved = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf8")) as {
          toolPermissions?: Record<string, string>;
        })
      : {};
    expect(saved.toolPermissions?.todo_add).toBeUndefined();

    await handleHarnessCall({ method: "setPermission", params: { name: "echo", level: "deny" } });
    expect(await auth("echo")).toMatchObject({ level: "deny", source: "policy" });
  });

  test("setToolEnabled preserves explicit permissions", async () => {
    await handleHarnessCall({ method: "setPermission", params: { name: "todo_add", level: "deny" } });
    await handleHarnessCall({ method: "setToolEnabled", params: { name: "echo", enabled: false } });
    const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      toolPermissions?: Record<string, string>;
      disabledTools?: string[];
    };
    expect(saved.toolPermissions?.todo_add).toBe("deny");
    expect(saved.disabledTools).toContain("echo");
    await handleHarnessCall({ method: "setToolEnabled", params: { name: "echo", enabled: true } });
  });

  test("call executes echo", async () => {
    const res = (await handleHarnessCall({
      method: "call",
      params: { name: "echo", args: { text: "hi" } },
    })) as { ok: boolean; result: { echoed: string } };
    expect(res.ok).toBe(true);
    expect(res.result.echoed).toBe("hi");
  });

  test("unknown tool and method return errors, never throw", async () => {
    const a = (await handleHarnessCall({
      method: "call",
      params: { name: "nope", args: {} },
    })) as { ok: boolean; error: string };
    expect(a.ok).toBe(false);
    expect(a.error).toContain("unknown tool");

    const b = (await handleHarnessCall({ method: "wat" })) as { ok: boolean; error: string };
    expect(b.ok).toBe(false);
    expect(b.error).toContain("unknown method");
  });

  test("version update status query and notification", async () => {
    setAvailableUpdate({
      hasUpdate: true,
      cachedVersion: "serp_v1",
      upstreamVersion: "serp_v2",
    });

    const res = (await handleHarnessCall({ method: "checkUpdate" })) as {
      ok: boolean;
      result: { hasUpdate: boolean; cachedVersion?: string; upstreamVersion?: string };
    };
    expect(res.ok).toBe(true);
    expect(res.result.hasUpdate).toBe(true);
    expect(res.result.cachedVersion).toBe("serp_v1");
    expect(res.result.upstreamVersion).toBe("serp_v2");

    const pageReadyRes = (await handleHarnessCall({
      method: "pageReady",
      params: { href: "https://duck.ai" },
    })) as {
      ok: boolean;
      result: { update?: { hasUpdate: boolean } };
    };
    expect(pageReadyRes.ok).toBe(true);
    expect(pageReadyRes.result.update?.hasUpdate).toBe(true);

    // Reset
    setAvailableUpdate({ hasUpdate: false });
    expect(getAvailableUpdate().hasUpdate).toBe(false);
  });

  test("pageReady keeps the notice while the old build is still loaded", async () => {
    setAvailableUpdate({
      hasUpdate: true,
      cachedVersion: "serp_v1",
      upstreamVersion: "serp_v2",
      // The SHA is deliberately identical to the upstream one: build timestamps
      // can change without the source hash changing, and the SHA must not be
      // enough to clear the notice.
      upstreamSha: "same_sha",
    });

    const res = (await handleHarnessCall({
      method: "pageReady",
      params: { versionTag: "serp_v1", versionSha: "same_sha" },
    })) as { result: { update?: { hasUpdate: boolean } } };
    expect(res.result.update?.hasUpdate).toBe(true);

    setAvailableUpdate({ hasUpdate: false });
  });

  test("pageReady clears the notice once the new build has loaded", async () => {
    setAvailableUpdate({
      hasUpdate: true,
      cachedVersion: "serp_v1",
      upstreamVersion: "serp_v2",
      upstreamSha: "sha_v2",
    });

    const res = (await handleHarnessCall({
      method: "pageReady",
      params: { versionTag: "serp_v2", versionSha: "sha_v2" },
    })) as { result: { update?: { hasUpdate: boolean } } };
    expect(res.result.update?.hasUpdate).toBe(false);
    expect(getAvailableUpdate().hasUpdate).toBe(false);
  });

  test("checkUpdate can also clear the notice for the loaded build", async () => {
    setAvailableUpdate({
      hasUpdate: true,
      cachedVersion: "serp_v1",
      upstreamVersion: "serp_v2",
    });

    const res = (await handleHarnessCall({
      method: "checkUpdate",
      params: { versionTag: "serp_v2" },
    })) as { result: { hasUpdate: boolean } };
    expect(res.result.hasUpdate).toBe(false);
  });

  test("reloadUpdate invokes the worker reload hook", async () => {
    let requested = 0;
    setReloadHandler(() => {
      requested++;
      return true;
    });

    const res = (await handleHarnessCall({ method: "reloadUpdate" })) as {
      ok: boolean;
      result: { reloading: boolean };
    };
    expect(res.ok).toBe(true);
    expect(res.result.reloading).toBe(true);
    expect(requested).toBe(1);

    // Without a registered hook the page can fall back safely.
    setReloadHandler(null);
    const missing = (await handleHarnessCall({ method: "reloadUpdate" })) as {
      ok: boolean;
      error: string;
    };
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("not ready");
  });
});
