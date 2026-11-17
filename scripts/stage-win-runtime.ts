/**
 * Copies the Microsoft Visual C++ 2015-2022 x64 runtime next to the compiled
 * Windows executable.
 *
 * webview-bun's libwebview.dll is built with MSVC and links the dynamic CRT
 * (MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll). Those DLLs are not part
 * of Windows, so `dlopen` fails with error 126 on a machine without the VC++
 * Redistributable. Shipping them app-local is the supported zero-prerequisite
 * option — Windows resolves a DLL's dependencies from the executable's folder.
 *
 * Source preference:
 *   1. Visual Studio's `VC\Redist\MSVC\*\x64\Microsoft.VC14*.CRT` (build machines)
 *   2. `%SystemRoot%\System32` (after installing vc_redist.x64.exe)
 *
 * Usage: bun scripts/stage-win-runtime.ts [--out <dir>]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REQUIRED = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] as const;

const outArg = process.argv.indexOf("--out");
const outDir = resolve(outArg !== -1 ? (process.argv[outArg + 1] ?? "dist") : join(ROOT, "dist"));

if (process.platform !== "win32") {
  console.error("stage-win-runtime: this step only makes sense on Windows");
  process.exit(1);
}

/** Directories holding `Microsoft.VC14*.CRT` for each MSVC redist version. */
function crtDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  const dirs: string[] = [];
  for (const version of readdirSync(base)) {
    const versionDir = join(base, version, "x64");
    if (!existsSync(versionDir)) continue;
    for (const name of readdirSync(versionDir)) {
      if (/^Microsoft\.VC14.*\.CRT$/i.test(name)) dirs.push(join(versionDir, name));
    }
  }
  return dirs;
}

function newest(dirs: string[]): string[] {
  return dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
}

function fromVisualStudio(): string | null {
  const candidates: string[] = [];
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );

  if (existsSync(vswhere)) {
    const result = Bun.spawnSync(
      [
        vswhere,
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const vs = result.stdout.toString().trim().split(/\r?\n/)[0];
    if (vs) candidates.push(...crtDirs(join(vs, "VC", "Redist", "MSVC")));
  }

  // vswhere missing/empty (e.g. only one VS edition installed) — scan directly.
  for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!programFiles) continue;
    for (const edition of ["Enterprise", "Professional", "Community", "BuildTools"]) {
      candidates.push(
        ...crtDirs(join(programFiles, "Microsoft Visual Studio", "2022", edition, "VC", "Redist", "MSVC")),
      );
    }
  }

  for (const dir of newest(candidates)) {
    if (REQUIRED.every((file) => existsSync(join(dir, file)))) return dir;
  }
  return null;
}

function fromSystem32(): string | null {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  return REQUIRED.every((file) => existsSync(join(system32, file))) ? system32 : null;
}

const source = fromVisualStudio() ?? fromSystem32();
if (!source) {
  console.error(
    "stage-win-runtime: could not find the VC++ x64 runtime.\n" +
      "  Install the Visual Studio C++ build tools, or the Microsoft Visual C++\n" +
      "  Redistributable (https://aka.ms/vs/17/release/vc_redist.x64.exe).",
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// Only the DLLs libwebview.dll actually imports. Keeping the set minimal also
// lets the MSI list them explicitly instead of harvesting (which WiX warns
// against for per-user packages).
const files = [...REQUIRED];

let total = 0;
for (const file of files) {
  const from = join(source, file);
  const to = join(outDir, file);
  copyFileSync(from, to);
  total += statSync(to).size;
}

const missing = REQUIRED.filter((file) => !existsSync(join(outDir, file)));
if (missing.length) {
  console.error(`stage-win-runtime: missing required runtime files: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(
  `staged ${files.length} VC++ runtime DLL(s) from ${source} → ${relative(ROOT, outDir) || "."} ` +
    `(${(total / 1024 / 1024).toFixed(1)} MiB)`,
);
