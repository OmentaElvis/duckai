import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/harness";

let testDir = "";

beforeAll(() => {
  testDir = join(tmpdir(), `duckai-tools-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("fs tools", () => {
  test("write_file and read_file with line slicing", async () => {
    const file = join(testDir, "test.txt");
    const writeRes = (await executeTool("write_file", {
      path: file,
      content: "line1\nline2\nline3\nline4\nline5",
    })) as { success: boolean; bytes_written: number };

    expect(writeRes.success).toBe(true);
    expect(existsSync(file)).toBe(true);

    const readRes = (await executeTool("read_file", {
      path: file,
      start_line: 2,
      line_count: 2,
    })) as { total_lines: number; start_line: number; lines_returned: number; content: string };

    expect(readRes.total_lines).toBe(5);
    expect(readRes.start_line).toBe(2);
    expect(readRes.lines_returned).toBe(2);
    expect(readRes.content).toBe("line2\nline3");
  });

  test("edit_file replaces target string", async () => {
    const file = join(testDir, "edit-test.txt");
    writeFileSync(file, "Hello world, welcome to world.");

    const editRes = (await executeTool("edit_file", {
      path: file,
      target: "world",
      replacement: "Earth",
    })) as { success: boolean; occurrences_replaced: number };

    expect(editRes.success).toBe(true);
    expect(editRes.occurrences_replaced).toBe(2);
    expect(readFileSync(file, "utf8")).toBe("Hello Earth, welcome to Earth.");
  });

  test("list_directory returns structured Unix-style entries with paging", async () => {
    const subDir = join(testDir, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "a.txt"), "hello");
    writeFileSync(join(subDir, "b.txt"), "world");

    const listRes = (await executeTool("list_directory", {
      path: testDir,
      depth: 2,
      limit: 1,
    })) as {
      total: number;
      offset: number;
      limit: number;
      has_more: boolean;
      next_offset?: number;
      entries: string[];
    };

    expect(listRes.total).toBeGreaterThan(1);
    expect(listRes.limit).toBe(1);
    expect(listRes.has_more).toBe(true);
    expect(listRes.next_offset).toBe(1);
    expect(listRes.entries.length).toBe(1);

    // Fetch next page
    const page2 = (await executeTool("list_directory", {
      path: testDir,
      depth: 2,
      offset: listRes.next_offset,
      limit: 10,
    })) as { entries: string[] };

    expect(page2.entries.length).toBeGreaterThan(0);
    // Check Unix-style markers
    expect(
      listRes.entries.concat(page2.entries).some((e) => e.includes("sub/")),
    ).toBe(true);
    expect(
      listRes.entries.concat(page2.entries).some((e) => e.includes("a.txt (5 B)")),
    ).toBe(true);
  });

  test("file_info returns metadata", async () => {
    const file = join(testDir, "info.txt");
    writeFileSync(file, "metadata test");

    const infoRes = (await executeTool("file_info", { path: file })) as {
      exists: boolean;
      type: string;
      size: number;
    };

    expect(infoRes.exists).toBe(true);
    expect(infoRes.type).toBe("file");
    expect(infoRes.size).toBe(13);
  });

  test("delete_file removes file", async () => {
    const file = join(testDir, "to-delete.txt");
    writeFileSync(file, "delete me");

    const delRes = (await executeTool("delete_file", { path: file, trash: false })) as {
      success: boolean;
      action: string;
    };

    expect(delRes.success).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("delete_file rejects missing path argument", async () => {
    const res = (await executeTool("delete_file", {})) as { error: string };
    expect(res.error).toContain("path");
  });

  test("delete_file refuses to delete filesystem root", async () => {
    const res = (await executeTool("delete_file", { path: "/" })) as { error: string };
    expect(res.error).toContain("Refusing to delete");
  });

  test("delete_file respects protectedPaths setting", async () => {
    const protectedFile = join(testDir, "do-not-touch.txt");
    writeFileSync(protectedFile, "important data");

    const settingsFile = join(testDir, "test-settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({ protectedPaths: [protectedFile] }),
    );
    process.env.DUCKAI_SETTINGS_PATH = settingsFile;

    try {
      const res = (await executeTool("delete_file", { path: protectedFile })) as { error: string };
      expect(res.error).toContain("protected path");
      expect(existsSync(protectedFile)).toBe(true);
    } finally {
      delete process.env.DUCKAI_SETTINGS_PATH;
    }
  });
});

describe("search tools", () => {
  test("search_files finds matching patterns", async () => {
    const searchDir = join(testDir, "search");
    mkdirSync(searchDir, { recursive: true });
    writeFileSync(join(searchDir, "invoice-123.pdf"), "content");
    writeFileSync(join(searchDir, "note.txt"), "content");

    const res = (await executeTool("search_files", {
      path: searchDir,
      pattern: "*.pdf",
    })) as { matches: string[]; total_matches: number };

    expect(res.total_matches).toBe(1);
    expect(res.matches[0]).toContain("invoice-123.pdf");
  });

  test("grep_search finds text across files", async () => {
    const grepDir = join(testDir, "grep");
    mkdirSync(grepDir, { recursive: true });
    writeFileSync(join(grepDir, "doc.txt"), "first line\nsecret_keyword_here\nthird line");

    const res = (await executeTool("grep_search", {
      path: grepDir,
      query: "secret_keyword",
    })) as { matches: { file: string; line: number; text: string }[]; total_matches: number };

    expect(res.total_matches).toBeGreaterThan(0);
    expect(res.matches[0]?.text).toContain("secret_keyword_here");
  });
});

describe("exec tools", () => {
  test("run_command executes and captures stdout", async () => {
    const res = (await executeTool("run_command", {
      command: "echo 'hello from bun'",
    })) as { exit_code: number; stdout: string; timed_out: boolean };

    expect(res.exit_code).toBe(0);
    expect(res.stdout.trim()).toBe("hello from bun");
    expect(res.timed_out).toBe(false);
  });
});

describe("system tools", () => {
  test("get_current_time returns ISO and formatted date", async () => {
    const res = (await executeTool("get_current_time", {})) as {
      iso: string;
      formatted: string;
      timezone: string;
    };

    expect(res.iso).toBeDefined();
    expect(res.formatted).toBeDefined();
    expect(res.timezone).toBeDefined();
  });

  test("notify tool handles missing ntfy topic gracefully", async () => {
    const res = (await executeTool("notify", {
      channel: "ntfy",
      message: "Test message",
    })) as { success: boolean; delivery: { ntfy?: { error?: string } } };

    expect(res.delivery.ntfy?.error).toContain("ntfy topic not configured");
  });

  test("notify tool supports ntfy basic auth and bearer token", async () => {
    let capturedAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedAuth = req.headers.get("Authorization") || "";
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const res1 = (await executeTool("notify", {
        channel: "ntfy",
        topic: "private-test",
        server: `http://localhost:${server.port}`,
        message: "Hello",
        username: "alice",
        password: "secretpassword",
      })) as { success: boolean; delivery: { ntfy?: { sent: boolean } } };

      expect(res1.delivery.ntfy?.sent).toBe(true);
      expect(capturedAuth).toBe(`Basic ${Buffer.from("alice:secretpassword").toString("base64")}`);

      const res2 = (await executeTool("notify", {
        channel: "ntfy",
        topic: "private-test",
        server: `http://localhost:${server.port}`,
        message: "Hello again",
        token: "tk_abcdef12345",
      })) as { success: boolean; delivery: { ntfy?: { sent: boolean } } };

      expect(res2.delivery.ntfy?.sent).toBe(true);
      expect(capturedAuth).toBe("Bearer tk_abcdef12345");
    } finally {
      server.stop(true);
    }
  });
});

describe("memory tools", () => {
  const memPath = () => join(testDir, "memory.json");
  const prev = process.env.DUCKAI_MEMORY_PATH;
  test("set/get/list/forget roundtrip is token-lean", async () => {
    process.env.DUCKAI_MEMORY_PATH = memPath();
    try {
      const set = (await executeTool("memory_set", {
        key: "User.Timezone",
        value: "Europe/London",
      })) as { k?: string; error?: string };
      expect(set).toEqual({ k: "user.timezone" });

      const get = (await executeTool("memory_get", { keys: ["user.timezone", "missing"] })) as Record<string, string>;
      expect(get).toEqual({ "user.timezone": "Europe/London" });
      // No extra metadata fields in read output.
      expect(Object.keys(get)).toEqual(["user.timezone"]);

      const list = (await executeTool("memory_list", {})) as { keys: string[] };
      expect(list).toEqual({ keys: ["user.timezone"] });

      const filtered = (await executeTool("memory_list", { query: "london" })) as { keys: string[] };
      expect(filtered.keys).toEqual(["user.timezone"]);

      const forget = (await executeTool("memory_forget", { key: "user.timezone" })) as { k?: string };
      expect(forget).toEqual({ k: "user.timezone" });
      const gone = (await executeTool("memory_get", { keys: ["user.timezone"] })) as Record<string, string>;
      expect(gone).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.DUCKAI_MEMORY_PATH;
      else process.env.DUCKAI_MEMORY_PATH = prev;
    }
  });

  test("rejects invalid keys, empties, secrets, and overflow", async () => {
    process.env.DUCKAI_MEMORY_PATH = memPath();
    try {
      expect((await executeTool("memory_set", { key: "NO SPACES", value: "x" })) as { error?: string })
        .toHaveProperty("error");
      expect((await executeTool("memory_set", { key: "ok.key", value: "   " })) as { error?: string })
        .toHaveProperty("error");
      expect((await executeTool("memory_set", { key: "ok.key", value: "password: hunter2" })) as { error?: string })
        .toHaveProperty("error");
      // Unknown forget is an error, not a silent no-op.
      expect((await executeTool("memory_forget", { key: "nope.key" })) as { error?: string })
        .toHaveProperty("error");
      // Oversize values are rejected, not silently truncated.
      expect((await executeTool("memory_set", { key: "ok.key", value: "x".repeat(2048) })) as { error?: string })
        .toHaveProperty("error");
    } finally {
      if (prev === undefined) delete process.env.DUCKAI_MEMORY_PATH;
      else process.env.DUCKAI_MEMORY_PATH = prev;
    }
  });

  test("entry cap is enforced", async () => {
    process.env.DUCKAI_MEMORY_PATH = join(testDir, "memory-cap.json");
    try {
      for (let i = 0; i < 100; i++) {
        const r = (await executeTool("memory_set", { key: `k.${i}`, value: "v" })) as { k?: string };
        expect(r.k).toBe(`k.${i}`);
      }
      const over = (await executeTool("memory_set", { key: "k.overflow", value: "v" })) as { error?: string };
      expect(over.error).toBe("memory full");
      // Replacing an existing key still works at capacity.
      const upd = (await executeTool("memory_set", { key: "k.0", value: "new" })) as { k?: string };
      expect(upd.k).toBe("k.0");
    } finally {
      if (prev === undefined) delete process.env.DUCKAI_MEMORY_PATH;
      else process.env.DUCKAI_MEMORY_PATH = prev;
    }
  });

  test("timestamps are kept at rest but never returned to the agent", async () => {
    const path = join(testDir, "memory-ts.json");
    process.env.DUCKAI_MEMORY_PATH = path;
    try {
      await executeTool("memory_set", { key: "a.key", value: "first" });
      await executeTool("memory_set", { key: "a.key", value: "second" });
      const raw = JSON.parse(await Bun.file(path).text()) as {
        m: Record<string, { v: string; c: number; u: number }>;
      };
      expect(raw.m["a.key"]!.v).toBe("second");
      expect(typeof raw.m["a.key"]!.c).toBe("number");
      expect(typeof raw.m["a.key"]!.u).toBe("number");
      expect(raw.m["a.key"]!.c).toBeGreaterThan(0);
      // Created preserved across the update; updated >= created.
      expect(raw.m["a.key"]!.u).toBeGreaterThanOrEqual(raw.m["a.key"]!.c);
      // Reads expose values only — no c/u leakage.
      const get = (await executeTool("memory_get", { keys: ["a.key"] })) as Record<string, string>;
      expect(get).toEqual({ "a.key": "second" });
      expect(JSON.stringify(get)).not.toContain('"c"');
      const list = (await executeTool("memory_list", {})) as { keys: string[] };
      expect(JSON.stringify(list)).not.toContain('"c"');
    } finally {
      if (prev === undefined) delete process.env.DUCKAI_MEMORY_PATH;
      else process.env.DUCKAI_MEMORY_PATH = prev;
    }
  });
});
