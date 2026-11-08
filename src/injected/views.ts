/**
 * App-registered custom views for tool calls.
 *
 * This is the app-level choke point for presentation: each tool name maps to a
 * neutral `ToolView` (a one-line `summary` + expanded `body` blocks). Nothing
 * here references duck.ai classes, shadow DOM, or CSS — the widget layer owns
 * all of that (see `tool-render.ts` / `ui.ts`). Add views for new tools here;
 * tools without a view fall back to the neutral JSON view automatically.
 *
 * A `ToolCallView` gives you `{ name, args, status, result, error }`. When the
 * call is still `running`, `result` is undefined — so a good summary reads from
 * `args` and a good body can show a "working…" state.
 */
import { registerToolView, type RenderBlock, type ToolCallView } from "./tool-render";

/** Parse a JSON tool result, returning undefined instead of throwing. */
function parse<T = unknown>(raw?: string): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

interface Todo {
  id: number;
  text: string;
  done: boolean;
}
interface TodoSnapshot {
  added?: Todo;
  updated?: Todo;
  removed?: Todo;
  todos?: Todo[];
  summary?: { total: number; open: number; done: number };
  error?: string;
}

function todoBlocks(call: ToolCallView): RenderBlock[] {
  const snap = parse<TodoSnapshot>(call.result);
  if (!snap?.todos) return [];
  const items = snap.todos.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text} (#${t.id})`);
  const s = snap.summary;
  const blocks: RenderBlock[] = [
    { kind: "list", label: s ? `Todos · ${s.open} open, ${s.done} done` : "Todos", items },
  ];
  return blocks;
}

// --- Todo tools -------------------------------------------------------------

registerToolView("todo_list", {
  summary: (c) => {
    const s = parse<TodoSnapshot>(c.result)?.summary;
    return s ? `${s.open} open · ${s.done} done` : "list todos";
  },
  body: todoBlocks,
});

registerToolView("todo_add", {
  summary: (c) => {
    const text = (c.args as { text?: string } | undefined)?.text ?? parse<TodoSnapshot>(c.result)?.added?.text;
    return text ? `add “${text}”` : "add todo";
  },
  body: todoBlocks,
});

registerToolView("todo_complete", {
  summary: (c) => {
    const id = (c.args as { id?: number } | undefined)?.id ?? parse<TodoSnapshot>(c.result)?.updated?.id;
    const done = parse<TodoSnapshot>(c.result)?.updated?.done;
    return `#${id ?? "?"} → ${done === false ? "reopened" : "done"}`;
  },
  body: todoBlocks,
});

registerToolView("todo_remove", {
  summary: (c) => {
    const id = (c.args as { id?: number } | undefined)?.id ?? parse<TodoSnapshot>(c.result)?.removed?.id;
    return `remove #${id ?? "?"}`;
  },
  body: todoBlocks,
});

// --- misc -------------------------------------------------------------------

registerToolView("get_current_time", {
  summary: (c) => parse<{ formatted?: string }>(c.result)?.formatted ?? "current time",
  body: (c) => {
    const r = parse<{ formatted?: string; iso?: string; timezone?: string }>(c.result);
    if (!r) return [];
    return [
      {
        kind: "fields",
        fields: [
          { label: "Time", value: r.formatted ?? "" },
          { label: "Zone", value: r.timezone ?? "" },
          { label: "ISO", value: r.iso ?? "" },
        ],
      },
    ];
  },
});

interface ListDirectoryResult {
  path?: string;
  total?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  next_offset?: number;
  entries?: string[];
  error?: string;
}

function baseName(path?: string): string {
  if (!path) return "";
  const parts = path.split(/[/\\]/);
  return parts.pop() || path;
}

function extToLang(path?: string): string | undefined {
  if (!path) return undefined;
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "sh":
    case "bash":
      return "bash";
    case "py":
      return "python";
    case "html":
      return "html";
    case "css":
      return "css";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return undefined;
  }
}

registerToolView("list_directory", {
  summary: (c) => {
    const r = parse<ListDirectoryResult>(c.result);
    if (!r || r.error) return "list directory";
    const total = r.total ?? 0;
    const offset = r.offset ?? 0;
    const count = r.entries?.length ?? 0;
    if (total === 0) return `${r.path || "."} (empty)`;
    return `${r.path || "."} (${offset + 1}–${offset + count} of ${total})`;
  },
  body: (c) => {
    const r = parse<ListDirectoryResult>(c.result);
    if (!r?.entries) return [];
    const fields: Array<{ label: string; value: string }> = [
      { label: "Path", value: r.path ?? "." },
      { label: "Items", value: `${r.entries.length} shown (total ${r.total ?? r.entries.length})` },
    ];
    if (r.has_more && r.next_offset !== undefined) {
      fields.push({ label: "Next page", value: `offset: ${r.next_offset}` });
    }
    return [
      { kind: "fields", fields },
      { kind: "list", label: "Entries", items: r.entries },
    ];
  },
});

// --- Filesystem tool views --------------------------------------------------

interface ReadFileResult {
  path?: string;
  total_lines?: number;
  start_line?: number;
  lines_returned?: number;
  truncated?: boolean;
  content?: string;
  error?: string;
}

registerToolView("read_file", {
  summary: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<ReadFileResult>(c.result);
    const file = baseName(r?.path || args?.path);
    if (r?.total_lines !== undefined && r.start_line !== undefined && r.lines_returned !== undefined) {
      return `read ${file} (${r.start_line}–${r.start_line + r.lines_returned - 1} of ${r.total_lines} lines)`;
    }
    return `read ${file || "file"}`;
  },
  body: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<ReadFileResult>(c.result);
    if (!r) return [];
    const fields: Array<{ label: string; value: string }> = [
      { label: "Path", value: r.path ?? args?.path ?? "" },
    ];
    if (r.total_lines !== undefined) {
      fields.push({
        label: "Lines",
        value: `${r.start_line ?? 1}–${(r.start_line ?? 1) + (r.lines_returned ?? 0) - 1} of ${r.total_lines}`,
      });
    }
    if (r.truncated) fields.push({ label: "Notice", value: "Content capped at 64KB" });

    const blocks: RenderBlock[] = [{ kind: "fields", fields }];
    if (r.content !== undefined) {
      blocks.push({
        kind: "code",
        label: "File Content",
        text: r.content,
        language: extToLang(r.path || args?.path),
      });
    }
    return blocks;
  },
});

interface WriteFileResult {
  success?: boolean;
  path?: string;
  bytes_written?: number;
  append?: boolean;
  error?: string;
}

registerToolView("write_file", {
  summary: (c) => {
    const args = c.args as { path?: string; append?: boolean } | undefined;
    const r = parse<WriteFileResult>(c.result);
    const file = baseName(r?.path || args?.path);
    const mode = args?.append ? "append to" : "write";
    if (r?.bytes_written !== undefined) {
      return `${mode} ${file} (${r.bytes_written} B)`;
    }
    return `${mode} ${file || "file"}`;
  },
  body: (c) => {
    const args = c.args as { path?: string; content?: string; append?: boolean } | undefined;
    const r = parse<WriteFileResult>(c.result);
    const fields: Array<{ label: string; value: string }> = [
      { label: "Path", value: r?.path ?? args?.path ?? "" },
      { label: "Mode", value: args?.append ? "Append" : "Overwrite" },
    ];
    if (r?.bytes_written !== undefined) {
      fields.push({ label: "Written", value: `${r.bytes_written} bytes` });
    }
    const blocks: RenderBlock[] = [{ kind: "fields", fields }];
    if (args?.content) {
      blocks.push({
        kind: "code",
        label: "Content",
        text: args.content,
        language: extToLang(args.path),
      });
    }
    return blocks;
  },
});

interface EditFileResult {
  success?: boolean;
  path?: string;
  occurrences_replaced?: number;
  error?: string;
}

registerToolView("edit_file", {
  summary: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<EditFileResult>(c.result);
    const file = baseName(r?.path || args?.path);
    const count = r?.occurrences_replaced;
    return `edit ${file}${count !== undefined ? ` (${count} replaced)` : ""}`;
  },
  body: (c) => {
    const args = c.args as { path?: string; target?: string; replacement?: string } | undefined;
    const r = parse<EditFileResult>(c.result);
    const fields: Array<{ label: string; value: string }> = [
      { label: "Path", value: r?.path ?? args?.path ?? "" },
    ];
    if (r?.occurrences_replaced !== undefined) {
      fields.push({ label: "Replaced", value: `${r.occurrences_replaced} occurrence(s)` });
    }
    const blocks: RenderBlock[] = [{ kind: "fields", fields }];
    if (args?.target !== undefined) {
      blocks.push({ kind: "code", label: "Target (Find)", text: args.target });
    }
    if (args?.replacement !== undefined) {
      blocks.push({ kind: "code", label: "Replacement", text: args.replacement });
    }
    return blocks;
  },
});

interface FileInfoResult {
  path?: string;
  type?: string;
  size?: number;
  mode?: string;
  modified?: string;
  created?: string;
  error?: string;
}

registerToolView("file_info", {
  summary: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<FileInfoResult>(c.result);
    const file = baseName(r?.path || args?.path);
    return `info ${file} · ${r?.type ?? "stat"}`;
  },
  body: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<FileInfoResult>(c.result);
    if (!r) return [];
    return [
      {
        kind: "fields",
        fields: [
          { label: "Path", value: r.path ?? args?.path ?? "" },
          { label: "Type", value: r.type ?? "unknown" },
          { label: "Size", value: r.size !== undefined ? `${r.size} bytes` : "" },
          { label: "Permissions", value: r.mode ?? "" },
          { label: "Modified", value: r.modified ?? "" },
          { label: "Created", value: r.created ?? "" },
        ],
      },
    ];
  },
});

interface DeleteFileResult {
  success?: boolean;
  action?: string;
  path?: string;
  error?: string;
}

registerToolView("delete_file", {
  summary: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<DeleteFileResult>(c.result);
    const file = baseName(r?.path || args?.path);
    const action = r?.action === "trashed" ? "trash" : "delete";
    return `${action} ${file}`;
  },
  body: (c) => {
    const args = c.args as { path?: string } | undefined;
    const r = parse<DeleteFileResult>(c.result);
    return [
      {
        kind: "fields",
        fields: [
          { label: "Path", value: r?.path ?? args?.path ?? "" },
          { label: "Action", value: r?.action === "trashed" ? "Moved to trash" : "Permanently deleted" },
        ],
      },
    ];
  },
});

// --- Search tool views ------------------------------------------------------

interface SearchFilesResult {
  base_path?: string;
  pattern?: string;
  matches?: string[];
  total_matches?: number;
  truncated?: boolean;
  error?: string;
}

registerToolView("search_files", {
  summary: (c) => {
    const args = c.args as { pattern?: string; path?: string } | undefined;
    const r = parse<SearchFilesResult>(c.result);
    const pattern = r?.pattern ?? args?.pattern ?? "*";
    const count = r?.total_matches ?? r?.matches?.length;
    return `find '${pattern}'${count !== undefined ? ` (${count} matches)` : ""}`;
  },
  body: (c) => {
    const args = c.args as { pattern?: string; path?: string } | undefined;
    const r = parse<SearchFilesResult>(c.result);
    if (!r?.matches) return [];
    const fields: Array<{ label: string; value: string }> = [
      { label: "Base Path", value: r.base_path ?? args?.path ?? "." },
      { label: "Pattern", value: r.pattern ?? args?.pattern ?? "" },
      { label: "Found", value: `${r.matches.length}${r.truncated ? " (truncated)" : ""}` },
    ];
    return [
      { kind: "fields", fields },
      { kind: "list", label: "Matching Files", items: r.matches },
    ];
  },
});

interface GrepMatchItem {
  file: string;
  line: number;
  text: string;
}

interface GrepSearchResult {
  base_path?: string;
  query?: string;
  matches?: GrepMatchItem[];
  total_matches?: number;
  truncated?: boolean;
  error?: string;
}

registerToolView("grep_search", {
  summary: (c) => {
    const args = c.args as { query?: string; path?: string } | undefined;
    const r = parse<GrepSearchResult>(c.result);
    const query = r?.query ?? args?.query ?? "";
    const count = r?.total_matches ?? r?.matches?.length;
    return `grep '${query}'${count !== undefined ? ` (${count} matches)` : ""}`;
  },
  body: (c) => {
    const args = c.args as { query?: string; path?: string } | undefined;
    const r = parse<GrepSearchResult>(c.result);
    if (!r?.matches) return [];
    const fields: Array<{ label: string; value: string }> = [
      { label: "Base Path", value: r.base_path ?? args?.path ?? "." },
      { label: "Query", value: r.query ?? args?.query ?? "" },
      { label: "Found", value: `${r.matches.length}${r.truncated ? " (truncated)" : ""}` },
    ];
    const items = r.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
    return [
      { kind: "fields", fields },
      { kind: "list", label: "Matches", items },
    ];
  },
});

// --- Execution & notification views -----------------------------------------

interface RunCommandResult {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
  error?: string;
}

registerToolView("run_command", {
  summary: (c) => {
    const args = c.args as { command?: string } | undefined;
    const r = parse<RunCommandResult>(c.result);
    const cmd = args?.command ? args.command.slice(0, 50) : "command";
    if (r?.timed_out) return `$ ${cmd} (timed out)`;
    if (r?.exit_code !== undefined) return `$ ${cmd} (exit ${r.exit_code})`;
    return `$ ${cmd}`;
  },
  body: (c) => {
    const args = c.args as { command?: string; cwd?: string } | undefined;
    const r = parse<RunCommandResult>(c.result);
    const fields: Array<{ label: string; value: string }> = [
      { label: "Command", value: args?.command ?? "" },
      { label: "Directory", value: args?.cwd || "." },
    ];
    if (r?.exit_code !== undefined) fields.push({ label: "Exit code", value: String(r.exit_code) });
    if (r?.timed_out) fields.push({ label: "Notice", value: "Timed out" });

    const blocks: RenderBlock[] = [{ kind: "fields", fields }];
    if (r?.stdout) {
      blocks.push({ kind: "code", label: "Output (stdout)", text: r.stdout, language: "bash" });
    }
    if (r?.stderr) {
      blocks.push({ kind: "code", label: "Errors (stderr)", text: r.stderr, language: "bash" });
    }
    return blocks;
  },
});

interface NotifyResult {
  success?: boolean;
  channel?: string;
  delivery?: {
    desktop?: { sent: boolean; error?: string };
    ntfy?: { sent: boolean; status?: number; error?: string };
  };
  error?: string;
}

registerToolView("notify", {
  summary: (c) => {
    const args = c.args as { message?: string; title?: string; channel?: string } | undefined;
    const r = parse<NotifyResult>(c.result);
    const preview = args?.title || args?.message || "notification";
    const channel = r?.channel || args?.channel || "notify";
    return `notify · “${preview.slice(0, 40)}” (${channel})`;
  },
  body: (c) => {
    const args = c.args as { message?: string; title?: string; channel?: string } | undefined;
    const r = parse<NotifyResult>(c.result);
    const fields: Array<{ label: string; value: string }> = [
      { label: "Message", value: args?.message ?? "" },
    ];
    if (args?.title) fields.push({ label: "Title", value: args.title });
    fields.push({ label: "Channel", value: r?.channel ?? args?.channel ?? "default" });

    if (r?.delivery?.desktop) {
      fields.push({
        label: "Desktop",
        value: r.delivery.desktop.sent ? "Delivered" : r.delivery.desktop.error || "Failed",
      });
    }
    if (r?.delivery?.ntfy) {
      fields.push({
        label: "ntfy.sh",
        value: r.delivery.ntfy.sent ? "Delivered" : r.delivery.ntfy.error || "Failed",
      });
    }

    return [{ kind: "fields", fields }];
  },
});

/** Register all app views. Called once at extension startup. */
export function registerBuiltinViews(): void {
  // Views above register at module load; keep this for symmetry / future
  // data-driven registration.
}
