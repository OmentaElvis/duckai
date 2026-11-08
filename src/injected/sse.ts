/**
 * Incremental SSE parser for duck.ai's chat stream.
 *
 * Wire format (observed in HAR):
 *   data: {"role":"assistant","message":"Hi","created":1791…,"action":"success"}\n\n
 *   data: {"action":"success","role":"tool-invocation","state":"call",…}\n\n
 *   data: [PING]\n\n
 *   data: [DONE]\n\n
 *
 * Every JSON event carries `action: "success" | "error"`.
 * Special (non-JSON) payloads are bracketed tokens: [PING], [DONE],
 * [CHAT_TITLE:…], [DONE][STOP_REASON:…].
 */

export interface SSEEvent {
  /** Raw payload after the "data: " prefix (may be partial-JSON garbage on errors). */
  data: string;
  /** Parsed JSON when the payload is an object, else null. */
  json: Record<string, unknown> | null;
  /** Bracketed token name for specials, e.g. "PING" | "DONE" | "CHAT_TITLE:Hello". */
  special: string | null;
  /** Full original event text including trailing blank line (for faithful passthrough). */
  raw: string;
}

export type SSEEventHook = (ev: SSEEvent) => void;
export type SSEEventSink = (ev: SSEEvent) => void;

const hooks: SSEEventHook[] = [];

export function onSSEEvent(hook: SSEEventHook): void {
  hooks.push(hook);
}

function parsePayload(data: string): Pick<SSEEvent, "json" | "special"> {
  const trimmed = data.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { json: null, special: trimmed.slice(1, -1) };
  }
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { json: v as Record<string, unknown>, special: null };
    }
  } catch {
    /* fall through — malformed payload surfaced as plain data */
  }
  return { json: null, special: null };
}

/** Build an event from one raw SSE record; null when it carries no data line. */
export function buildEvent(raw: string): SSEEvent | null {
  const dataLines = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  const { json, special } = parsePayload(data);
  return { data, json, special, raw };
}

/** Default sink: fan out to the globally registered observation hooks. */
export function dispatch(ev: SSEEvent): void {
  for (const hook of hooks) {
    try {
      hook(ev);
    } catch (err) {
      console.error("[duck-ext] sse hook threw", err);
    }
  }
}

/** Serialize a raw payload back into an SSE record. */
export function formatEvent(data: string): string {
  return `data: ${data}\n\n`;
}

/**
 * Stateful line/event parser. Feed it decoded text chunks in order; it
 * invokes the sink for each complete `data:` event (terminated by a blank
 * line) and keeps partial tails buffered until the next push or `end()`.
 */
export class SSEParser {
  #buf = "";
  #sink: SSEEventSink;

  constructor(sink: SSEEventSink = dispatch) {
    this.#sink = sink;
  }

  push(chunk: string): void {
    this.#buf += chunk;
    // Events end with "\n\n" (also tolerate "\r\n\r\n").
    for (;;) {
      const sep = /\r?\n\r?\n/.exec(this.#buf);
      if (!sep) break;
      const raw = this.#buf.slice(0, sep.index + sep[0].length);
      this.#buf = this.#buf.slice(sep.index + sep[0].length);
      const ev = buildEvent(raw);
      if (ev) this.#sink(ev);
    }
  }

  /** Flush a trailing event that was not terminated by a blank line. */
  end(): void {
    const tail = this.#buf.trim();
    this.#buf = "";
    if (!tail) return;
    const ev = buildEvent(tail);
    if (ev) this.#sink(ev);
  }
}

/**
 * Observe a byte stream without altering it. Returns a TransformStream that
 * decodes UTF-8 chunks, parses SSE events for hooks, and enqueues the
 * original bytes unchanged.
 */
export function createObservingStream(): TransformStream<Uint8Array, Uint8Array> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        parser.push(decoder.decode(chunk, { stream: true }));
      } catch (err) {
        console.error("[duck-ext] sse parse error", err);
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      try {
        const tail = decoder.decode();
        if (tail) parser.push(tail);
        parser.end();
      } catch {
        /* ignore */
      }
      void controller;
    },
  });
}

/**
 * Pull-based SSE reader. Yields parsed events as they arrive from a response
 * body; cancels the underlying reader when the generator is closed early.
 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = /\r?\n\r?\n/.exec(buf);
        if (!sep) break;
        const raw = buf.slice(0, sep.index + sep[0].length);
        buf = buf.slice(sep.index + sep[0].length);
        const ev = buildEvent(raw);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) {
      const ev = buildEvent(tail);
      if (ev) yield ev;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* reader may already be released */
    }
  }
}
