import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/harness";

let testDir = "";
let resultsPath = "";
const prev = process.env.DUCKAI_RESULTS_PATH;

beforeAll(() => {
  testDir = join(tmpdir(), `duckai-results-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  resultsPath = join(testDir, "results.json");
  process.env.DUCKAI_RESULTS_PATH = resultsPath;
});

afterAll(() => {
  if (prev === undefined) delete process.env.DUCKAI_RESULTS_PATH;
  else process.env.DUCKAI_RESULTS_PATH = prev;
  rmSync(testDir, { recursive: true, force: true });
});

describe("result offload", () => {
  test("small results are not offloaded", async () => {
    const res = (await executeTool("echo", { text: "hi" })) as { echoed?: string; ref?: string };
    expect(res.echoed).toBe("hi");
    expect(res.ref).toBeUndefined();
  });

  test("large results become a lossless stub recoverable by paging + grep", async () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      i === 250 ? "needle invoice-42 here" : `line ${i} ${"x".repeat(40)}`,
    );
    const big = lines.join("\n");
    const stub = (await executeTool("echo", { text: big })) as {
      ref?: string;
      bytes?: number;
      lines?: number;
      preview?: string;
    };
    expect(stub.ref).toMatch(/^r_/);
    expect(stub.bytes).toBeGreaterThan(8192);
    expect(stub.lines).toBeGreaterThanOrEqual(500);
    expect(stub.preview).toContain("line 0");
    // Stub is small even though the result is large.
    expect(JSON.stringify(stub).length).toBeLessThan(3000);

    const page = (await executeTool("result_read", {
      ref: stub.ref,
      start_line: 251,
      line_count: 1,
    })) as { ref: string; total_lines: number; has_more: boolean; content: string };
    expect(page.total_lines).toBeGreaterThanOrEqual(500);
    expect(page.has_more).toBe(true);
    expect(page.content).toContain("needle invoice-42 here");

    const tail = (await executeTool("result_read", {
      ref: stub.ref,
      start_line: 500,
      line_count: 50,
    })) as { has_more: boolean; content: string };
    expect(tail.has_more).toBe(false);
    expect(tail.content).toContain("line 499");

    const found = (await executeTool("result_grep", {
      ref: stub.ref,
      query: "invoice-42",
    })) as { matches: Array<{ line: number; text: string }>; truncated: boolean };
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ line: 251 });
    expect(found.truncated).toBe(false);
  });

  test("unknown refs are errors", async () => {
    expect((await executeTool("result_read", { ref: "r_nope" })) as { error?: string }).toHaveProperty("error");
    expect((await executeTool("result_grep", { ref: "r_nope", query: "x" })) as { error?: string }).toHaveProperty(
      "error",
    );
  });

  test("paging tools themselves are never offloaded", async () => {
    // A long single line read should return content, not another stub.
    const big = "y".repeat(20000);
    const stub = (await executeTool("echo", { text: big })) as { ref: string };
    const page = (await executeTool("result_read", { ref: stub.ref, line_count: 5 })) as {
      content?: string;
      ref?: string;
    };
    expect(page.content?.length).toBeGreaterThan(0);
    // Not a stub (stubs have preview/hint, paging returns content).
    expect((page as Record<string, unknown>).preview).toBeUndefined();
  });
});
