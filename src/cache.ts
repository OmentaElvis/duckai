/**
 * Local offline cache & upstream version manager for Duck.ai.
 *
 * Caches the upstream base HTML document to ~/.duckai/cache/duckai.html and
 * tracks the front-end build version tags (`data-version-tag` and `data-version-sha`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log as rootLog } from "./logging/host";

const log = rootLog.child("cache");

export interface CachedVersion {
  versionTag: string;
  versionSha: string;
  updatedAt: number;
}

export interface CachedSite extends CachedVersion {
  html: string;
}

export function cacheDir(): string {
  return process.env.DUCKAI_CACHE_DIR || join(homedir(), ".duckai", "cache");
}

export function htmlCachePath(): string {
  return join(cacheDir(), "duckai.html");
}

export function versionCachePath(): string {
  return join(cacheDir(), "version.json");
}

const VERSION_TAG_RE = /data-version-tag=["']([^"']+)["']/i;
const VERSION_SHA_RE = /data-version-sha=["']([^"']+)["']/i;

/** Extract version metadata from the Duck.ai <html> block. */
export function extractVersion(html: string): { versionTag?: string; versionSha?: string } {
  const tagMatch = html.match(VERSION_TAG_RE);
  const shaMatch = html.match(VERSION_SHA_RE);
  return {
    versionTag: tagMatch ? tagMatch[1] : undefined,
    versionSha: shaMatch ? shaMatch[1] : undefined,
  };
}

/** Read the locally cached site HTML and metadata, if present. */
export function readCachedHtml(): CachedSite | null {
  try {
    const htmlFile = htmlCachePath();
    const verFile = versionCachePath();
    if (!existsSync(htmlFile) || !existsSync(verFile)) return null;

    const html = readFileSync(htmlFile, "utf8");
    if (!html || !html.trim()) return null;

    const verData = JSON.parse(readFileSync(verFile, "utf8")) as Partial<CachedVersion>;
    const versionTag = verData.versionTag || extractVersion(html).versionTag || "unknown";
    const versionSha = verData.versionSha || extractVersion(html).versionSha || "unknown";
    const updatedAt = typeof verData.updatedAt === "number" ? verData.updatedAt : Date.now();

    return { html, versionTag, versionSha, updatedAt };
  } catch (err) {
    log.warn("failed to read cached HTML", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Save upstream HTML to disk and update version metadata. */
export function writeCachedHtml(html: string): CachedSite {
  const { versionTag = "dev", versionSha = "hash" } = extractVersion(html);
  const site: CachedSite = {
    html,
    versionTag,
    versionSha,
    updatedAt: Date.now(),
  };

  try {
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });

    writeFileSync(htmlCachePath(), html, "utf8");
    const meta: CachedVersion = {
      versionTag,
      versionSha,
      updatedAt: site.updatedAt,
    };
    writeFileSync(versionCachePath(), JSON.stringify(meta, null, 2), "utf8");
    log.info(`saved cached HTML: ${versionTag} (${versionSha.slice(0, 8)})`);
  } catch (err) {
    log.error("failed to write cached HTML", err instanceof Error ? err.message : String(err));
  }

  return site;
}

/** Fetch upstream HTML with a timeout and extract version. */
export async function fetchUpstream(
  url = process.env.DUCKAI_URL ?? "https://duck.ai",
  timeoutMs = 8000,
): Promise<{ html: string; versionTag?: string; versionSha?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) {
      log.warn(`upstream fetch failed: HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const { versionTag, versionSha } = extractVersion(html);
    return { html, versionTag, versionSha };
  } catch (err) {
    log.debug("upstream fetch error / offline", err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
