import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Tool } from "../harness";
import { resolveUserPath } from "./fs";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".cache", ".next", ".turbo"]);

function globToRegex(glob: string, caseSensitive: boolean): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, caseSensitive ? "" : "i");
}

export const searchFilesTool: Tool = {
  name: "search_files",
  permission: "allow",
  description:
    "Find files matching a glob pattern or filename keyword (e.g. '*.ts', 'invoice*'). Automatically skips noise directories like node_modules and .git.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Base folder to search in (supports ~). Defaults to current directory.",
      },
      pattern: {
        type: "string",
        description: "Filename pattern or glob (e.g. '*.json', 'invoice*').",
      },
      max_results: {
        type: "integer",
        description: "Maximum number of file matches to return. Defaults to 50.",
      },
    },
    required: ["pattern"],
  },
  execute: (args) => {
    const rawPath = String(args.path || ".").trim();
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { error: "pattern is required" };

    const fullPath = resolveUserPath(rawPath);
    if (!existsSync(fullPath)) return { error: `Path not found: ${rawPath}` };

    const maxResults = Math.max(1, typeof args.max_results === "number" ? Math.floor(args.max_results) : 50);
    const regex = globToRegex(pattern, false);

    const matches: string[] = [];
    let truncated = false;

    function walk(dir: string, depth: number) {
      if (matches.length >= maxResults || depth > 10) {
        if (matches.length >= maxResults) truncated = true;
        return;
      }
      let items: string[];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }

      for (const item of items) {
        if (IGNORED_DIRS.has(item)) continue;
        const itemPath = join(dir, item);
        try {
          const st = lstatSync(itemPath);
          if (st.isDirectory()) {
            walk(itemPath, depth + 1);
          } else if (regex.test(item)) {
            matches.push(relative(fullPath, itemPath) || item);
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        } catch {
          // ignore inaccessible
        }
      }
    }

    try {
      walk(fullPath, 0);
      return {
        base_path: fullPath,
        pattern,
        matches,
        total_matches: matches.length,
        truncated,
      };
    } catch (err) {
      return { error: `Failed to search files: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export const grepSearchTool: Tool = {
  name: "grep_search",
  permission: "allow",
  description:
    "Fast regex or text search inside files within a directory or file. Returns matching files, line numbers, and text snippets.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory or file to search in (supports ~). Defaults to current directory.",
      },
      query: {
        type: "string",
        description: "Text or regular expression to search for.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Whether search is case-sensitive. Defaults to false.",
      },
      max_results: {
        type: "integer",
        description: "Maximum matches to return. Defaults to 50.",
      },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const rawPath = String(args.path || ".").trim();
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query is required" };

    const fullPath = resolveUserPath(rawPath);
    if (!existsSync(fullPath)) return { error: `Path not found: ${rawPath}` };

    const maxResults = Math.max(1, typeof args.max_results === "number" ? Math.floor(args.max_results) : 50);
    const caseSensitive = Boolean(args.case_sensitive);

    // Try ripgrep first
    try {
      const rgArgs = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count",
        String(maxResults),
      ];
      if (!caseSensitive) rgArgs.push("-i");
      rgArgs.push("-e", query, fullPath);

      const proc = Bun.spawn(rgArgs, {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = proc.stdout ? await new Response(proc.stdout as BodyInit).text() : "";
      const exitCode = await proc.exited;

      if (exitCode === 0 || (exitCode === 1 && !stdout.trim())) {
        const matches: GrepMatch[] = [];
        const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          if (matches.length >= maxResults) break;
          // rg format: filepath:line:text
          const parts = line.split(":");
          if (parts.length >= 3) {
            const file = relative(fullPath, parts[0]!) || parts[0]!;
            const lineNum = Number(parts[1]);
            const text = parts.slice(2).join(":").trim();
            matches.push({ file, line: lineNum, text });
          }
        }
        return {
          base_path: fullPath,
          query,
          matches,
          total_matches: matches.length,
          truncated: matches.length >= maxResults,
        };
      }
    } catch {
      // Ripgrep failed or not found, fall back to pure JS
    }

    // Fallback: Pure JS file walker + regex
    const matches: GrepMatch[] = [];
    let regex: RegExp;
    try {
      regex = new RegExp(query, caseSensitive ? "" : "i");
    } catch {
      return { error: `Invalid regex pattern: ${query}` };
    }

    function searchFile(file: string) {
      if (matches.length >= maxResults) return;
      try {
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          const l = lines[i]!;
          if (regex.test(l)) {
            matches.push({
              file: relative(fullPath, file) || file,
              line: i + 1,
              text: l.trim(),
            });
          }
        }
      } catch {
        // Binary or unreadable file
      }
    }

    function walk(dir: string, depth: number) {
      if (matches.length >= maxResults || depth > 8) return;
      let items: string[];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }
      for (const item of items) {
        if (IGNORED_DIRS.has(item)) continue;
        const itemPath = join(dir, item);
        try {
          const st = lstatSync(itemPath);
          if (st.isDirectory()) {
            walk(itemPath, depth + 1);
          } else if (st.isFile() && st.size < 1024 * 1024) {
            searchFile(itemPath);
          }
        } catch {
          // ignore
        }
      }
    }

    try {
      const st = lstatSync(fullPath);
      if (st.isDirectory()) {
        walk(fullPath, 0);
      } else if (st.isFile()) {
        searchFile(fullPath);
      }
      return {
        base_path: fullPath,
        query,
        matches,
        total_matches: matches.length,
        truncated: matches.length >= maxResults,
      };
    } catch (err) {
      return { error: `Grep search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const searchTools: Tool[] = [searchFilesTool, grepSearchTool];
