/**
 * Builds a Debian package for the compiled linux-x64 binary.
 *
 * The compiled binary embeds webview-bun's native library, so only the
 * GTK 4 / WebKitGTK 6 system libraries are needed at runtime.
 *
 * Usage: bun scripts/build-deb.ts [--version <x.y.z>]
 */
import { chmod, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGE = "duckai";
const ARCH = "amd64";

// Keep staged files at conventional 755/644 permissions regardless of umask.
process.umask(0o022);

const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
  version: string;
  author?: string;
  homepage?: string;
};

const versionArg = process.argv.indexOf("--version");
const version = (versionArg !== -1 ? process.argv[versionArg + 1] : pkg.version)?.replace(/^v/, "");

if (!version || !/^\d[A-Za-z0-9.+~:-]*$/.test(version)) {
  console.error(`build-deb: invalid Debian version: ${version ?? "(missing)"}`);
  process.exit(1);
}

const binary = join(ROOT, "dist", "duckai");
const binaryStat = await stat(binary).catch(() => null);
if (!binaryStat?.isFile()) {
  console.error("build-deb: dist/duckai not found — run `bun run build` first");
  process.exit(1);
}

const stage = join(ROOT, "dist", ".deb", `${PACKAGE}_${version}_${ARCH}`);
const output = join(ROOT, "dist", `${PACKAGE}_${version}_${ARCH}.deb`);

await rm(stage, { recursive: true, force: true });

const binDir = join(stage, "usr/bin");
const applicationsDir = join(stage, "usr/share/applications");
const iconDir = join(stage, "usr/share/icons/hicolor/scalable/apps");
await mkdir(binDir, { recursive: true });
await mkdir(applicationsDir, { recursive: true });
await mkdir(iconDir, { recursive: true });
await mkdir(join(stage, "DEBIAN"), { recursive: true });

await cp(binary, join(binDir, PACKAGE));
await chmod(join(binDir, PACKAGE), 0o755);
await cp(join(ROOT, "assets/duckai.svg"), join(iconDir, `${PACKAGE}.svg`));
await chmod(join(iconDir, `${PACKAGE}.svg`), 0o644);

const installedSize = Math.ceil(binaryStat.size / 1024);
const maintainer = pkg.author ?? "OmentaElvis <omentaelvis@gmail.com>";

const control = `Package: ${PACKAGE}
Version: ${version}
Architecture: ${ARCH}
Maintainer: ${maintainer}
Depends: libgtk-4-1, libwebkitgtk-6.0-4
Section: net
Priority: optional
Installed-Size: ${installedSize}
${pkg.homepage ? `Homepage: ${pkg.homepage}\n` : ""}Description: Desktop client for Duck.ai
 Duck.ai in a native GTK window, with a local tool harness for
 filesystem, shell, search, MCP servers and desktop notifications.
`;

const desktopEntry = `[Desktop Entry]
Type=Application
Name=Duck.ai
GenericName=AI Chat
Comment=Chat with Duck.ai in a native window
Exec=${PACKAGE}
Icon=${PACKAGE}
Terminal=false
Categories=Network;Chat;InstantMessaging;
Keywords=duckai;duckduckgo;ai;chat;
StartupNotify=true
StartupWMClass=${PACKAGE}
`;

await writeFile(join(stage, "DEBIAN/control"), control);
await writeFile(join(applicationsDir, `${PACKAGE}.desktop`), desktopEntry);
await chmod(join(stage, "DEBIAN/control"), 0o644);
await chmod(join(applicationsDir, `${PACKAGE}.desktop`), 0o644);

const result = Bun.spawn(["dpkg-deb", "--build", "--root-owner-group", stage, output], {
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await result.exited;

if (exitCode !== 0) {
  console.error(`build-deb: dpkg-deb exited with code ${exitCode}`);
  process.exit(exitCode);
}

await rm(join(ROOT, "dist", ".deb"), { recursive: true, force: true });

const outputStat = await stat(output);
console.log(
  `deb built: ${relative(ROOT, output)} (${(outputStat.size / 1024 / 1024).toFixed(1)} MiB)`,
);
