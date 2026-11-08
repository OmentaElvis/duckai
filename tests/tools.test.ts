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
