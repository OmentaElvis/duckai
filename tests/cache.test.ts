import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractVersion,
  readCachedHtml,
  writeCachedHtml,
} from "../src/cache";

const SAMPLE_HTML = `<!doctype html>
<html lang="en-US"
      class="react no-js"
      data-version-tag="serp_20261112_050146_ET"
      data-version-sha="b1bcb7f41b1db8dc506464b54a5e3df3ff00a8cf">
<head>
    <title>Duck.ai</title>
</head>
<body>Hello</body>
</html>`;

describe("cache manager", () => {
  let tempDir: string;
  const originalEnv = process.env.DUCKAI_CACHE_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "duckai-cache-test-"));
    process.env.DUCKAI_CACHE_DIR = tempDir;
  });

  afterEach(() => {
    process.env.DUCKAI_CACHE_DIR = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts version tag and sha from html", () => {
    const res = extractVersion(SAMPLE_HTML);
    expect(res.versionTag).toBe("serp_20261112_050146_ET");
    expect(res.versionSha).toBe("b1bcb7f41b1db8dc506464b54a5e3df3ff00a8cf");
  });

  it("handles missing version attributes gracefully", () => {
    const res = extractVersion("<html><body>none</body></html>");
    expect(res.versionTag).toBeUndefined();
    expect(res.versionSha).toBeUndefined();
  });

  it("returns null when no cache exists", () => {
    expect(readCachedHtml()).toBeNull();
  });

  it("writes and reads cached html roundtrip", () => {
    const written = writeCachedHtml(SAMPLE_HTML);
    expect(written.versionTag).toBe("serp_20261112_050146_ET");
    expect(written.versionSha).toBe("b1bcb7f41b1db8dc506464b54a5e3df3ff00a8cf");

    const read = readCachedHtml();
    expect(read).not.toBeNull();
    expect(read?.html).toBe(SAMPLE_HTML);
    expect(read?.versionTag).toBe("serp_20261112_050146_ET");
    expect(read?.versionSha).toBe("b1bcb7f41b1db8dc506464b54a5e3df3ff00a8cf");
    expect(read?.updatedAt).toBe(written.updatedAt);
  });
});
