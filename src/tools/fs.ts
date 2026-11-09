import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Tool } from "../harness";

export function resolveUserPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

const MAX_READ_BYTES = 64 * 1024; // 64 KB per read to preserve model context
const MAX_DIR_ENTRIES = 300;

export const readFileTool: Tool = {
  name: "read_file",
  permission: "allow",
  description:
    "Read text content from a file with optional pagination (start_line and line_count) and size capping to avoid overwhelming the conversation context.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path (supports ~ for home directory)." },
      start_line: {
        type: "integer",
        description: "1-based line number to start reading from. Defaults to 1.",
      },
      line_count: {
        type: "integer",
        description: "Maximum number of lines to return. Defaults to 500.",
      },
    },
    required: ["path"],
  },
  execute: (args) => {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return { error: "path is required" };
    const fullPath = resolveUserPath(rawPath);

    if (!existsSync(fullPath)) {
      return { error: `File not found: ${rawPath}` };
    }

    const st = statSync(fullPath);
    if (st.isDirectory()) {
      return { error: `Path is a directory, not a file: ${rawPath}. Use list_directory instead.` };
    }

    let text: string;
    try {
      text = readFileSync(fullPath, "utf8");
    } catch (err) {
      return { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
    }

    const lines = text.split("\n");
    const totalLines = lines.length;
    const start = Math.max(1, typeof args.start_line === "number" ? Math.floor(args.start_line) : 1);
    const count = Math.max(1, typeof args.line_count === "number" ? Math.floor(args.line_count) : 500);

    const startIndex = start - 1;
    const slice = lines.slice(startIndex, startIndex + count);
    let content = slice.join("\n");
    let truncated = false;

    if (content.length > MAX_READ_BYTES) {
      content = content.slice(0, MAX_READ_BYTES) + "\n\n... [Content truncated at 64KB]";
      truncated = true;
    }

    return {
      path: fullPath,
      total_lines: totalLines,
      start_line: start,
      lines_returned: slice.length,
      truncated,
      content,
    };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  permission: "ask",
  description:
    "Write content to a file. Creates parent directories automatically. Can overwrite or append.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path (supports ~)." },
      content: { type: "string", description: "Text content to write." },
      append: {
        type: "boolean",
        description: "If true, appends content to the end of the file instead of overwriting. Defaults to false.",
      },
    },
    required: ["path", "content"],
  },
  execute: (args) => {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return { error: "path is required" };
    const content = String(args.content ?? "");
    const append = Boolean(args.append);
    const fullPath = resolveUserPath(rawPath);

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, {
        encoding: "utf8",
        flag: append ? "a" : "w",
      });
      return {
        success: true,
        path: fullPath,
        bytes_written: Buffer.byteLength(content, "utf8"),
        append,
      };
    } catch (err) {
      return { error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  permission: "ask",
  description:
    "Make precise find-and-replace edits to a file. Replaces target occurrences with the replacement string.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path (supports ~)." },
      target: { type: "string", description: "Exact string to find and replace." },
      replacement: { type: "string", description: "String to replace the target with." },
    },
    required: ["path", "target", "replacement"],
  },
  execute: (args) => {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return { error: "path is required" };
    const target = String(args.target ?? "");
    const replacement = String(args.replacement ?? "");
    if (!target) return { error: "target string cannot be empty" };

    const fullPath = resolveUserPath(rawPath);
    if (!existsSync(fullPath)) return { error: `File not found: ${rawPath}` };

    try {
      const original = readFileSync(fullPath, "utf8");
      if (!original.includes(target)) {
        return { error: `Target string not found in ${rawPath}` };
      }
      const count = original.split(target).length - 1;
      const updated = original.replaceAll(target, replacement);
      writeFileSync(fullPath, updated, "utf8");
      return {
        success: true,
        path: fullPath,
        occurrences_replaced: count,
      };
    } catch (err) {
      return { error: `Failed to edit file: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface RawDirEntry {
  name: string;
  formatted: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: number;
}

export const listDirectoryTool: Tool = {
  name: "list_directory",
  permission: "allow",
  description:
    "List directory contents in a clean Unix style (folders end with '/', symlinks show '-> target'). Supports paging (offset, limit), pattern filtering, type filtering, and sorting.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list (supports ~). Defaults to current directory.",
      },
      offset: {
        type: "integer",
        description: "0-based index to start listing from for pagination. Defaults to 0.",
      },
      limit: {
        type: "integer",
        description: "Maximum entries to return in this page (max 200). Defaults to 50.",
      },
      depth: {
        type: "integer",
        description: "Folder traversal depth (1 = immediate contents only, max 3). Defaults to 1.",
      },
      include_hidden: {
        type: "boolean",
        description: "Whether to include hidden files (starting with .). Defaults to false.",
      },
      file_type: {
        type: "string",
        enum: ["all", "file", "directory"],
        description: "Filter by item type ('all', 'file', or 'directory'). Defaults to 'all'.",
      },
      pattern: {
        type: "string",
        description: "Optional wildcard or keyword filter (e.g. '*.pdf', 'Downloads*').",
      },
      sort_by: {
        type: "string",
        enum: ["name", "modified", "size"],
        description: "Sort property ('name', 'modified', or 'size'). Defaults to 'name'.",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction ('asc' or 'desc'). Defaults to 'asc'.",
      },
    },
    required: [],
  },
  execute: (args) => {
    const rawPath = String(args.path || ".").trim();
    const fullPath = resolveUserPath(rawPath);
    const depth = Math.min(3, Math.max(1, typeof args.depth === "number" ? Math.floor(args.depth) : 1));
    const includeHidden = Boolean(args.include_hidden);
    const offset = Math.max(0, typeof args.offset === "number" ? Math.floor(args.offset) : 0);
    const limit = Math.min(200, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 50));
    const fileType = typeof args.file_type === "string" ? args.file_type : "all";
    const patternStr = typeof args.pattern === "string" ? args.pattern.trim() : "";
    const sortBy = typeof args.sort_by === "string" ? args.sort_by : "name";
    const sortOrder = typeof args.sort_order === "string" ? args.sort_order : "asc";

    if (!existsSync(fullPath)) return { error: `Directory not found: ${rawPath}` };

    const patternRegex = patternStr
      ? new RegExp(
          patternStr
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, "."),
          "i",
        )
      : null;

    const allEntries: RawDirEntry[] = [];

    function walk(dir: string, currentDepth: number) {
      let items: string[];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }

      for (const item of items) {
        if (!includeHidden && item.startsWith(".")) continue;

        const itemPath = join(dir, item);
        const relPath = relative(fullPath, itemPath);

        try {
          const lst = lstatSync(itemPath);
          let type: RawDirEntry["type"] = "other";
          let formatted = relPath;

          if (lst.isSymbolicLink()) {
            type = "symlink";
            try {
              const target = readlinkSync(itemPath);
              formatted = `${relPath} -> ${target}`;
            } catch {
              formatted = `${relPath}@`;
            }
          } else if (lst.isDirectory()) {
            type = "directory";
            formatted = `${relPath}/`;
          } else if (lst.isFile()) {
            type = "file";
            formatted = `${relPath} (${formatSize(lst.size)})`;
          }

          if (fileType === "file" && type !== "file") {
            // skip non-file
          } else if (fileType === "directory" && type !== "directory") {
            // skip non-directory
          } else if (patternRegex && !patternRegex.test(item)) {
            // skip non-matching
          } else {
            allEntries.push({
              name: relPath,
              formatted,
              type,
              size: lst.size,
              mtime: lst.mtimeMs,
            });
          }

          if (lst.isDirectory() && currentDepth < depth) {
            walk(itemPath, currentDepth + 1);
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    }

    try {
      const st = statSync(fullPath);
      if (!st.isDirectory()) {
        return { error: `Path is not a directory: ${rawPath}` };
      }
      walk(fullPath, 1);

      // Sorting
      allEntries.sort((a, b) => {
        let cmp = 0;
        if (sortBy === "size") {
          cmp = a.size - b.size;
        } else if (sortBy === "modified") {
          cmp = a.mtime - b.mtime;
        } else {
          // name
          cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        }
        return sortOrder === "desc" ? -cmp : cmp;
      });

      const total = allEntries.length;
      const page = allEntries.slice(offset, offset + limit);
      const hasMore = offset + page.length < total;
      const nextOffset = hasMore ? offset + page.length : undefined;

      return {
        path: fullPath,
        total,
        offset,
        limit,
        has_more: hasMore,
        ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
        entries: page.map((e) => e.formatted),
      };
    } catch (err) {
      return { error: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const fileInfoTool: Tool = {
  name: "file_info",
  permission: "allow",
  description:
    "Retrieve file or folder metadata (size, permissions, timestamps, type) without reading file contents.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to inspect (supports ~)." },
    },
    required: ["path"],
  },
  execute: (args) => {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return { error: "path is required" };
    const fullPath = resolveUserPath(rawPath);

    if (!existsSync(fullPath)) return { error: `File not found: ${rawPath}` };

    try {
      const lst = lstatSync(fullPath);
      return {
        path: fullPath,
        exists: true,
        type: lst.isDirectory() ? "directory" : lst.isFile() ? "file" : lst.isSymbolicLink() ? "symlink" : "other",
        size: lst.size,
        mode: "0" + (lst.mode & 0o777).toString(8),
        created: lst.birthtime?.toISOString?.() ?? lst.ctime.toISOString(),
        modified: lst.mtime.toISOString(),
      };
    } catch (err) {
      return { error: `Failed to inspect file: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

function isPathProtected(fullPath: string): boolean {
  // Root filesystem is always protected from deletion
  if (fullPath === "/" || fullPath === "\\") return true;

  try {
    const settingsPath = process.env.DUCKAI_SETTINGS_PATH || join(homedir(), ".duckai", "settings.json");
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        protectedPaths?: unknown;
      };
      if (Array.isArray(parsed.protectedPaths)) {
        for (const p of parsed.protectedPaths) {
          if (typeof p === "string" && p.trim()) {
            const resolved = resolveUserPath(p.trim());
            if (resolved === fullPath) return true;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export const deleteFileTool: Tool = {
  name: "delete_file",
  permission: "ask",
  description:
    "Safely delete a file or directory. By default moves the item to the OS trash; if unsupported or trash=false, deletes it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target path to delete or trash (supports ~)." },
      trash: {
        type: "boolean",
        description: "Move to system trash if true (default: true). Set false to delete permanently.",
      },
    },
    required: ["path"],
  },
  execute: (args) => {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return { error: "path is required" };
    const fullPath = resolveUserPath(rawPath);

    if (isPathProtected(fullPath)) {
      return { error: `Refusing to delete protected path: ${rawPath}` };
    }

    const useTrash = args.trash === undefined ? true : Boolean(args.trash);

    if (!existsSync(fullPath)) return { error: `Target not found: ${rawPath}` };

    if (useTrash) {
      try {
        const proc = Bun.spawnSync(["gio", "trash", fullPath]);
        if (proc.exitCode === 0) {
          return { success: true, action: "trashed", path: fullPath };
        }
      } catch {
        // Fallback to permanent delete if gio trash is not available
      }
    }

    try {
      rmSync(fullPath, { recursive: true, force: true });
      return { success: true, action: "deleted", path: fullPath };
    } catch (err) {
      return { error: `Failed to delete: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const fsTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  fileInfoTool,
  deleteFileTool,
];
