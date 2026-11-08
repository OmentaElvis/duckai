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

/** Register all app views. Called once at extension startup. */
export function registerBuiltinViews(): void {
  // Views above register at module load; keep this for symmetry / future
  // data-driven registration.
}
