/**
 * Shared protocol constants and pure helpers, used by BOTH the Bun harness and
 * the injected page script (bundled separately, so no runtime coupling).
 *
 * Custom (harness-executed) tools are synthesized client-side: the model is
 * instructed to emit a text envelope, which the fetch hook detects, executes
 * via the Bun bridge, and then auto-continues the conversation with the result.
 */

export interface ToolManifestEntry {
  name: string;
  description: string;
  /** JSON Schema describing the arguments object. */
  parameters: Record<string, unknown>;
}

/** A registered tool plus its current availability (for the management UI). */
export interface ToolInfo extends ToolManifestEntry {
  /** Whether the tool is currently offered to the agent. */
  enabled: boolean;
}

/**
 * How a tool call is authorized:
 * - `allow`: run without asking
 * - `ask`: prompt the user (allow once / always-for-session / reject)
 * - `deny`: refuse outright
 */
export type Permission = "allow" | "ask" | "deny";

/** Where an effective permission came from (for display). */
export type PermissionSource = "session" | "policy" | "default";

/** Scope level for granular permissions (e.g. specific tool, specific file, command binary). */
export interface PermissionScope {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** Tool info plus its effective permission, as shown in the management UI. */
export interface ManagedTool extends ToolInfo {
  permission: Permission;
  permissionSource: PermissionSource;
}

/**
 * Envelope grammar: a fenced code block tagged `duckai-tool` whose body is a
 * single JSON object `{"name": "...", "arguments": {...}}`.
 *
 * A fenced block is used deliberately: the DuckDuckGo backend appears to parse
 * and swallow XML-ish `<tool_call>` markup in model output (it collides with
 * its native function-calling syntax), so we avoid angle brackets entirely.
 */
export const TOOL_FENCE_INFO = "duckai-tool";
export const TOOL_OPEN = "```" + TOOL_FENCE_INFO;
export const FENCE_CLOSE = "```";

/** Markers delimiting a client tool result in the conversation. The start/end
 * pair exists so the model always knows exactly where machine output begins and
 * ends (and never mistakes it for user input). */
export const TOOL_RESULT_OPEN = "[duckai-ext:tool-result:start]";
export const TOOL_RESULT_CLOSE = "[duckai-ext:tool-result:end]";

/** Prefix used for locally-generated ids on synthetic tool-invocation events. */
export const CUSTOM_TOOL_ID_PREFIX = "duckai_ext_call_";

/**
 * Display-only sentinel emitted immediately after a tool fence is consumed.
 * It travels only in the SSE display stream (and is therefore persisted by
 * duck.ai as part of the assistant message text) so the UI can remember where
 * in the text the tool ran. Never reaches assistantText / continuation.
 *
 * Uses PUA Unicode so markdown renderers pass it through as an invisible
 * glyph. The slot id is also persisted in the sidecar history so a reload
 * can re-place the card exactly.
 */
export const SLOT_SENTINEL_PREFIX = "\uE001duckai-slot:";
export const SLOT_SENTINEL_SUFFIX = "\uE001";

export function sentinelFor(slotId: string): string {
  return `${SLOT_SENTINEL_PREFIX}${slotId}${SLOT_SENTINEL_SUFFIX}`;
}

/** Matches a sentinel even if the PUA delimiters were stripped by markdown sanitizers. */
export const SLOT_SENTINEL_RE_SOURCE = "\\uE001?duckai-slot:([a-z0-9]+)\\uE001?";

export function slotSentinelRegex(): RegExp {
  return new RegExp(SLOT_SENTINEL_RE_SOURCE, "g");
}

export function stripSlotSentinels(text: string): string {
  return text.replace(new RegExp(SLOT_SENTINEL_RE_SOURCE, "g"), "");
}

export function extractSlotIds(text: string): string[] {
  const re = new RegExp(SLOT_SENTINEL_RE_SOURCE, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

/** Marker embedded in the injected instruction block (idempotency guard). */
export const INSTRUCTION_MARKER = "[duckai-ext:tools:v1]";

/**
 * Tools executed server-side by DuckDuckGo. Their `tool-invocation` parts must
 * be preserved verbatim on the wire; anything else is ours and gets folded
 * back into plain text before resubmission.
 */
export const KNOWN_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "WebSearch",
  "SearchResults",
  "FindInDocument",
  "SportsLookup",
  "RelatedSearchTerms",
  "ReadDocument",
  "ReadDocumentSelection",
  "LocationPrompt",
  "GenerateImage",
  "Greeting",
  "WritingBlocks",
  "ImageGeneration",
]);

export interface ToolCallEnvelope {
  name: string;
  arguments: Record<string, unknown>;
  /** True when the call arrived through the native function-calling channel. */
  native?: boolean;
  /** Server-assigned call id (native calls only). */
  toolCallId?: string;
}

export function isKnownNativeTool(name: string): boolean {
  return KNOWN_NATIVE_TOOLS.has(name);
}

/**
 * A part is "custom" (and must be downgraded to text before resubmission) when
 * it references a tool the DuckDuckGo backend does not know about.
 */
export function isCustomToolPart(part: { toolName?: unknown; toolCallId?: unknown }): boolean {
  const name = typeof part.toolName === "string" ? part.toolName : "";
  if (name && isKnownNativeTool(name)) return false;
  const id = typeof part.toolCallId === "string" ? part.toolCallId : "";
  if (id.startsWith(CUSTOM_TOOL_ID_PREFIX)) return true;
  return Boolean(name);
}

/**
 * Compact required-params signature for one tool, e.g. `(path:string, content:string)`.
 * Optional params and inline descriptions are omitted — the model infers them from names,
 * or can call `tool_help` for the full schema.
 */
function sigLine(params: Record<string, unknown>): string {
  const props = (params as { properties?: Record<string, unknown> }).properties;
  const req = new Set<string>(
    Array.isArray((params as { required?: unknown }).required)
      ? ((params as { required: unknown[] }).required as string[])
      : [],
  );
  if (!props || typeof props !== "object") return "";
  const parts = Object.keys(props)
    .filter((k) => req.has(k))
    .map((k) => {
      const v = (props as Record<string, { type?: string }>)[k];
      return `${k}:${v?.type ?? "any"}`;
    });
  return parts.length ? `(${parts.join(", ")})` : "";
}

/**
 * The instruction block injected into the first user message.
 *
 * Lean by design: the preamble is a minimal contract (envelope format + STOP rule),
 * and the tool list shows only name + required-param signatures + a one-line description.
 * Full schemas are available on-demand via the `tool_help` tool, keeping the opening
 * message well under 1 000 tokens on a typical tool set.
 *
 * Deliberately written as the *user* explaining a client-side extension, not as
 * an authoritative system directive. Models reject anything that reads like a
 * prompt trying to impersonate or override the system ("that's not an active
 * tool connection"), so we simply describe the real situation: the client has
 * been extended with extra tools that are scanned for and executed for real.
 */
export function renderToolInstructions(manifest: ToolManifestEntry[]): string {
  const lines = manifest.map((t) => `  - ${t.name}${sigLine(t.parameters)}: ${t.description}`);
  return [
    `${INSTRUCTION_MARKER}`,
    "",
    "My duck.ai client is extended with local tools. To call one, emit a single fenced",
    "code block (and nothing else after it — stop immediately so the client can run it):",
    TOOL_OPEN,
    `{"name":"TOOL_NAME","arguments":{...}}`,
    FENCE_CLOSE,
    `The result arrives between \`${TOOL_RESULT_OPEN}\` and \`${TOOL_RESULT_CLOSE}\`.`,
    "CRITICAL: stop the moment you close the fence — never fabricate results.",
    "Call tool_help(name) for the full parameter schema of any tool before using it.",
    "",
    "Available tools (required params shown; use {} for tools with none):",
    ...lines,
  ].join("\n");
}
