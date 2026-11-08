/**
 * Generic rendering interface for custom tool calls.
 *
 * This is the *only* contract a tool needs to know about. Tool authors describe
 * what to show as plain data (`RenderBlock[]`) plus a one-line `summary`, and
 * never touch duck.ai classes, shadow DOM, CSS variables, or layout. The widget
 * layer (`ui.ts`) is the single choke point that turns these descriptors into
 * DOM — so when duck.ai's markup or class names change, only `ui.ts` changes.
 *
 * Registration is keyed by tool name, so adding rich views for e.g. an email
 * tool is just:
 *
 *   registerToolView("mail_search", {
 *     summary: (c) => `${count(c)} emails`,
 *     body: (c) => [
 *       { kind: "fields", label: "From", fields: [ { label: "Subject", value: … } ] },
 *       { kind: "list", label: "Results", items: … },
 *     ],
 *   });
 *
 * Tools without a registered view fall back to a neutral JSON view.
 */

export type ToolStatus = "running" | "ok" | "error";

/** A rendered block inside an expanded tool row. Pure data — no DOM. */
export type RenderBlock =
  | { kind: "text"; label?: string; text: string }
  | { kind: "code"; label?: string; text: string; language?: string }
  | { kind: "fields"; label?: string; fields: Array<{ label: string; value: string }> }
  | { kind: "list"; label?: string; items: string[] }
  | { kind: "link"; label?: string; text: string; href: string };

/** The data a view is given for a single tool call. */
export interface ToolCallView {
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: string;
  error?: string;
}

export interface ToolView {
  /** One-line summary shown in the collapsed row (plain text). */
  summary?: (call: ToolCallView) => string;
  /** Blocks shown when the row is expanded. */
  body?: (call: ToolCallView) => RenderBlock[];
}

const registry = new Map<string, ToolView>();

/** Register a custom view for a tool name (overwrites any previous one). */
export function registerToolView(name: string, view: ToolView): void {
  if (!name) return;
  registry.set(name, view);
}

/** Unregister a tool view. */
export function unregisterToolView(name: string): void {
  registry.delete(name);
}

export function getToolView(name: string): ToolView | undefined {
  return registry.get(name);
}

/** Registered tool names (useful for debugging / tests). */
export function registeredToolViews(): string[] {
  return [...registry.keys()];
}

export function clearToolViews(): void {
  registry.clear();
}

/**
 * Safe summary lookup: a throwing view degrades to `undefined` (the widget
 * layer then uses its neutral default) instead of breaking the whole message.
 */
export function callSummary(call: ToolCallView): string | undefined {
  const view = registry.get(call.name);
  if (!view?.summary) return undefined;
  try {
    return view.summary(call);
  } catch {
    return undefined;
  }
}

/**
 * Safe body lookup: a throwing view degrades to `undefined` (neutral default).
 */
export function callBody(call: ToolCallView): RenderBlock[] | undefined {
  const view = registry.get(call.name);
  if (!view?.body) return undefined;
  try {
    const blocks = view.body(call);
    return Array.isArray(blocks) ? blocks : undefined;
  } catch {
    return undefined;
  }
}
