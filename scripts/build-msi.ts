/**
 * Builds the per-user Windows MSI installer from the compiled Windows binary.
 *
 * WiX is pinned in .config/dotnet-tools.json (v6, the last release line without
 * the v7 OSMF EULA gate) and restored with the .NET SDK. The script restores it
 * on demand, so no global `wix` install is needed.
 *
 * Run `bun run build:win:release` and `bun run stage:win-runtime` first so
 * dist/duckai.exe and its VC++ runtime DLLs exist.
 *
 * Usage: bun scripts/build-msi.ts [--version <x.y.z>]
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");

const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };

const versionArg = process.argv.indexOf("--version");
const raw = (versionArg !== -1 ? process.argv[versionArg + 1] : pkg.version)?.replace(/^v/, "");

// Windows Installer accepts only numeric major.minor.build versions.
const msiVersion = raw?.split(/[-+]/)[0] ?? "";
const [major = -1, minor = -1, build = -1, ...rest] = msiVersion.split(".").map(Number);
const valid =
  rest.length === 0 &&
  Number.isInteger(major) &&
  major >= 0 &&
  major <= 255 &&
  Number.isInteger(minor) &&
  minor >= 0 &&
  minor <= 255 &&
  Number.isInteger(build) &&
  build >= 0 &&
  build <= 65535;

if (!valid) {
  console.error(
    `build-msi: invalid MSI version "${raw ?? "(missing)"}" — expected numeric major.minor.build ` +
      "(major/minor ≤ 255, build ≤ 65535)",
  );
  process.exit(1);
}

const exe = join(ROOT, "dist", "duckai.exe");
const exeStat = await stat(exe).catch(() => null);
if (!exeStat?.isFile()) {
  console.error("build-msi: dist/duckai.exe not found — run `bun run build:win:release` first");
  process.exit(1);
}

// The installer must carry the VC++ runtime or the app dies with dlopen error
// 126 on clean Windows installs (see scripts/stage-win-runtime.ts).
const runtime = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
const missingRuntime = runtime.filter((file) => !existsSync(join(ROOT, "dist", file)));
if (missingRuntime.length) {
  console.error(
    `build-msi: missing ${missingRuntime.join(", ")} in dist/ — run \`bun run stage:win-runtime\` first`,
  );
  process.exit(1);
}

const output = join(ROOT, "dist", `duckai_${msiVersion}_x64.msi`);
const args = [
  "tool",
  "run",
  "wix",
  "build",
  join(ROOT, "packaging", "windows", "duckai.wxs"),
  "-arch",
  "x64",
  "-d",
  `Version=${msiVersion}`,
  "-d",
  `ExePath=${resolve(exe)}`,
  "-d",
  `RuntimeDir=${resolve(join(ROOT, "dist"))}`,
  "-d",
  `AssetDir=${resolve(join(ROOT, "assets"))}`,
  "-o",
  output,
];

let exitCode: number;
try {
  const restore = Bun.spawn(["dotnet", "tool", "restore"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  const restoreCode = await restore.exited;
  if (restoreCode !== 0) {
    console.error(
      "build-msi: `dotnet tool restore` failed — WiX is pinned in .config/dotnet-tools.json",
    );
    process.exit(1);
  }

  exitCode = await Bun.spawn(["dotnet", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
} catch (err) {
  if ((err as { code?: string }).code === "ENOENT") {
    console.error("build-msi: `dotnet` not found — install the .NET 8 SDK (https://dot.net)");
    process.exit(1);
  }
  throw err;
}

if (exitCode !== 0) {
  console.error(`build-msi: wix build exited with code ${exitCode}`);
  process.exit(exitCode);
}

const outputStat = await stat(output);
console.log(
  `msi built: ${relative(ROOT, output)} (${(outputStat.size / 1024 / 1024).toFixed(1)} MiB)`,
);
