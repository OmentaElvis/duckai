/**
 * Wire-message shaping for the outbound chat request.
 *
 *  - `prepareMessages` injects the custom-tool instruction block into the first
 *    user message (idempotently) so the model knows our envelope grammar.
 *  - `sanitizeMessages` folds any *custom* `tool-invocation` parts (which the
 *    DuckDuckGo backend does not understand) back into plain text before
 *    resubmission, while leaving native tool parts untouched.
 *  - `buildContinuation` appends the assistant's envelope output plus a
 *    tool-result turn used to auto-continue the conversation.
 */
import {
  FENCE_CLOSE,
  INSTRUCTION_MARKER,
  stripSlotSentinels,
  TOOL_OPEN,
  TOOL_RESULT_CLOSE,
  TOOL_RESULT_OPEN,
  isCustomToolPart,
  type ToolCallEnvelope,
} from "../protocol";

export type Json = Record<string, unknown>;
export type WireMessage = Json;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolResultRecord {
  toolCallId: string;
  name: string;
  result: string;
  error?: string;
  /** Native (function-calling) call: emit `tool-invocation` parts on the wire. */
  native?: boolean;
  /** Original arguments (native calls only). */
  arguments?: Record<string, unknown>;
}

export function isTextPart(v: unknown): v is TextPart {
  return Boolean(v) && typeof v === "object" && (v as Json).type === "text";
}

function hasInstruction(messages: WireMessage[]): boolean {
  for (const m of messages) {
    const content = m.content;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (isTextPart(p) && p.text.includes(INSTRUCTION_MARKER)) return true;
      }
    } else if (typeof content === "string" && content.includes(INSTRUCTION_MARKER)) {
      return true;
    }
  }
  return false;
}

/**
 * Prepend the tool instructions to the first user message. Returns the input
 * unchanged when there is nothing to do (empty instructions or already present).
 */
export function prepareMessages(messages: WireMessage[], instructions: string): WireMessage[] {
  if (!instructions.trim() || hasInstruction(messages)) return messages;

  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser === -1) return messages;

  const clone = messages.map((m) => ({ ...m }));
  const target = { ...clone[firstUser]! };
  const content = target.content;
  if (Array.isArray(content)) {
    // The backend expects a single text part for user turns, so merge the
    // instructions into the first existing text part rather than adding one.
    let merged = false;
    target.content = (content as unknown[]).map((p) => {
      if (!merged && isTextPart(p)) {
        merged = true;
        return { ...p, text: `${instructions}\n\n${p.text}` };
      }
      return p;
    });
    if (!merged) target.content = [{ type: "text", text: instructions }, ...(content as unknown[])];
  } else if (typeof content === "string") {
    target.content = [{ type: "text", text: `${instructions}\n\n${content}` }];
  } else {
    target.content = [{ type: "text", text: instructions }];
  }
  clone[firstUser] = target;
  return clone;
}

function callToText(part: Json, name: string): TextPart {
  let args: Record<string, unknown> = {};
  const raw = part.toolArguments;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
    } catch {
      /* leave as {} */
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    args = raw as Record<string, unknown>;
  }
  const payload = JSON.stringify({ name, arguments: args });
  return { type: "text", text: `${TOOL_OPEN}\n${payload}\n${FENCE_CLOSE}` };
}

function resultToText(part: Json, name: string): TextPart {
  const result = typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? null);
  return { type: "text", text: `${TOOL_RESULT_OPEN}\n- ${name} -> ${result}\n${TOOL_RESULT_CLOSE}` };
}

/** Convert custom tool-invocation parts to text; leave everything else as-is.
 * Also strips display-only slot sentinels from assistant text: they are persisted
 * by duck.ai for inline placement on reload, but must never be sent to the model. */
export function sanitizeMessages(messages: WireMessage[]): WireMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) return m;

    const idToName = new Map<string, string>();
    for (const p of m.parts as Json[]) {
      if (p && typeof p === "object" && typeof p.toolCallId === "string") {
        const nm = typeof p.toolName === "string" ? p.toolName : "";
        if (nm) idToName.set(p.toolCallId, nm);
      }
    }

    let changed = false;
    const parts: Array<Json | TextPart> = [];
    for (const p of m.parts as Json[]) {
      if (p && typeof p === "object" && p.type === "tool-invocation" && isCustomToolPart(p)) {
        const name =
          (typeof p.toolName === "string" && p.toolName) ||
          idToName.get(typeof p.toolCallId === "string" ? p.toolCallId : "") ||
          "tool";
        parts.push(p.state === "result" ? resultToText(p, name) : callToText(p, name));
        changed = true;
      } else if (isTextPart(p)) {
        const stripped = stripSlotSentinels(p.text);
        if (stripped !== p.text) {
          changed = true;
          // A sentinel-only part was purely a placement placeholder — drop it.
          if (stripped === "" && p.text.trim() !== "") {
            // drop
          } else {
            parts.push({ ...p, text: stripped });
          }
        } else {
          parts.push(p);
        }
      } else {
        parts.push(p);
      }
    }
    if (!changed) return m;
    return { ...m, parts };
  });
}

/**
 * Build the messages for the continuation request: the already-sent
 * conversation, the assistant's raw output (including the envelope), and a
 * user turn carrying the tool results.
 */
export function buildContinuation(
  messages: WireMessage[],
  assistantText: string,
  results: ToolResultRecord[],
): WireMessage[] {
  const native = results.some((r) => r.native);
  if (native) {
    // The model used its native function-calling channel: replay the assistant
    // turn as `tool-invocation` parts (call + result) so the backend accepts it.
    const parts: Json[] = [];
    if (assistantText) parts.push({ type: "text", text: assistantText });
    for (const r of results) {
      parts.push({
        type: "tool-invocation",
        state: "call",
        toolCallId: r.toolCallId,
        toolName: r.name,
        toolArguments: JSON.stringify(r.arguments ?? {}),
      });
      parts.push({
        type: "tool-invocation",
        state: "result",
        toolCallId: r.toolCallId,
        toolName: r.name,
        result: r.error ? JSON.stringify({ error: r.error }) : r.result,
      });
    }
    return [...messages, { role: "assistant", content: "", parts }];
  }

  const assistant: WireMessage = {
    role: "assistant",
    content: "",
    parts: [{ type: "text", text: assistantText }],
  };

  const lines = results.map((r) =>
    r.error
      ? `- ${r.name} -> ERROR: ${r.error}`
      : `- ${r.name} -> ${r.result}`,
  );
  // The format of this message is described once, in the injected instruction
  // block (the start/end markers), so each round stays minimal.
  const text = [TOOL_RESULT_OPEN, ...lines, TOOL_RESULT_CLOSE].join("\n");

  return [
    ...messages,
    assistant,
    { role: "user", content: [{ type: "text", text }] },
  ];
}

/** Convenience re-export for callers that only need the grammar constant. */
export { TOOL_OPEN, FENCE_CLOSE, type ToolCallEnvelope };
