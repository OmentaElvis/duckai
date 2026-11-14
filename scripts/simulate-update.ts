/**
 * Prepares an isolated cache that looks like an older Duck.ai build, so the
 * upstream update banner can be exercised end to end without waiting for a real
 * deployment or touching your normal cache.
 *
 * Usage:
 *   bun scripts/simulate-update.ts
 *   DUCKAI_CACHE_DIR=/tmp/duckai-update-sim bun run dev
 *
 * The helper copies the current cache into the target directory and rewrites
 * both the cached HTML and version.json to an old build tag. The SHA is left
 * untouched on purpose: update detection must depend on the build tag.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE_TAG = "serp_20000101_000000_ET";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value) {
    console.error(`simulate-update: ${name} needs a directory`);
    process.exit(1);
  }
  return value;
}

const sourceDir = resolve(
  argValue("--from") ?? process.env.DUCKAI_CACHE_DIR ?? join(homedir(), ".duckai", "cache"),
);
const targetDir = resolve(argValue("--dir") ?? join(tmpdir(), "duckai-update-sim"));

if (sourceDir === targetDir) {
  console.error("simulate-update: --from and --dir must be different directories");
  process.exit(1);
}

const sourceHtml = join(sourceDir, "duckai.html");
const sourceVersion = join(sourceDir, "version.json");

let html: string;
let metadata: { versionTag?: string; versionSha?: string; updatedAt?: number };
try {
  html = await readFile(sourceHtml, "utf8");
  metadata = JSON.parse(await readFile(sourceVersion, "utf8")) as typeof metadata;
} catch {
  console.error(`simulate-update: no cache found in ${sourceDir}`);
  console.error("Run the app online once so it can populate the cache, then retry.");
  process.exit(1);
}

const tagPattern = /data-version-tag=(["'])[^"']*\1/i;
if (!tagPattern.test(html)) {
  console.error("simulate-update: cached HTML has no data-version-tag attribute");
  process.exit(1);
}

const simulatedHtml = html.replace(
  tagPattern,
  (_match, quote: string) => `data-version-tag=${quote}${FAKE_TAG}${quote}`,
);

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await writeFile(join(targetDir, "duckai.html"), simulatedHtml, "utf8");
await writeFile(
  join(targetDir, "version.json"),
  JSON.stringify(
    {
      versionTag: FAKE_TAG,
      versionSha: metadata.versionSha ?? "simulated",
      updatedAt: Date.now(),
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`simulated old build: ${FAKE_TAG}`);
console.log(`isolated cache:       ${targetDir}`);
console.log("");
console.log("Start the app with that cache:");
console.log(`  DUCKAI_CACHE_DIR=${targetDir} bun run dev`);
console.log("or:");
console.log(`  DUCKAI_CACHE_DIR=${targetDir} ./dist/duckai`);
console.log("");
console.log("Expected: banner appears after the upstream check; Reload shows the");
console.log("loading overlay, then the banner stays gone once the new build loads.");