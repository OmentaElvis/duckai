/**
 * Incremental detector for the custom tool-call text envelope.
 *
 * The model streams ordinary assistant text; somewhere in it (or as the whole
 * reply) it may emit a fenced block tagged `duckai-tool`:
 *
 *   ```duckai-tool
 *   {"name":"echo","arguments":{"text":"hi"}}
 *   ```
 *
 * The detector turns a sequence of text deltas into (a) safe user-visible text
 * with the envelope removed and (b) parsed calls. It holds back only the tail
 * that could still grow into the open fence, so streaming stays live.
 */
import { FENCE_CLOSE, TOOL_OPEN, type ToolCallEnvelope } from "../protocol";

function stripFences(body: string): string {
  const trimmed = body.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fence ? fence[1]! : trimmed).trim();
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse the body of a `duckai-tool` fence. Returns null when it is not a
 * well-formed call (in which case the caller keeps it as visible text).
 */
export function parseToolCallSegment(body: string): ToolCallEnvelope | null {
  const parsed = firstJsonObject(stripFences(body));
  if (!parsed) return null;

  const name = parsed.name;
  if (typeof name !== "string" || !name) return null;
  const a = parsed.arguments;
  const args = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
  return { name, arguments: args };
}

/** Longest suffix of `s` that is a proper prefix of the open fence. */
function heldPrefixLen(s: string): number {
  const max = Math.min(s.length, TOOL_OPEN.length - 1);
  for (let k = max; k >= 1; k--) {
    if (s.endsWith(TOOL_OPEN.slice(0, k))) return k;
  }
  return 0;
}

export interface EnvelopeStep {
  safeText: string;
  calls: ToolCallEnvelope[];
}

export class EnvelopeDetector {
  #buf = "";

  /** Feed a text delta; returns immediately-renderable text and any calls. */
  push(chunk: string): EnvelopeStep {
    this.#buf += chunk;
    let safeText = "";
    const calls: ToolCallEnvelope[] = [];

    for (;;) {
      const idx = this.#buf.indexOf(TOOL_OPEN);
      if (idx === -1) {
        const held = heldPrefixLen(this.#buf);
        const cut = this.#buf.length - held;
        safeText += this.#buf.slice(0, cut);
        this.#buf = this.#buf.slice(cut);
        break;
      }

      safeText += this.#buf.slice(0, idx);
      const rest = this.#buf.slice(idx + TOOL_OPEN.length);
      const closeIdx = rest.indexOf(FENCE_CLOSE);
      if (closeIdx === -1) {
        // Fence not yet closed: hold everything from the open marker.
        this.#buf = this.#buf.slice(idx);
        break;
      }

      const body = rest.slice(0, closeIdx);
      this.#buf = rest.slice(closeIdx + FENCE_CLOSE.length);

      const call = parseToolCallSegment(body);
      if (call) calls.push(call);
      else safeText += TOOL_OPEN + body + FENCE_CLOSE;
    }

    return { safeText, calls };
  }

  /** Emit any remaining buffered text at end-of-stream (lossless). */
  flush(): EnvelopeStep {
    const safeText = this.#buf;
    this.#buf = "";
    return { safeText, calls: [] };
  }
}
