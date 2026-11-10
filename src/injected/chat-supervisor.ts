/**
 * Chat stream supervisor.
 *
 * Wraps a duck.ai SSE response and turns custom tool calls into real harness
 * executions. Two call channels are recognised:
 *
 *   - a fenced ` ```duckai-tool ` text envelope emitted in the message stream,
 *   - a native `tool-invocation` event for one of our tool names.
 *
 * For either channel:
 *
 *   1. the envelope/event is not shown to the user,
 *   2. the tool is executed on the Bun side,
 *   3. synthetic `tool-invocation` call/result events are emitted so UI state
 *      and the conversation `parts` stay consistent,
 *   4. the conversation is auto-continued with the tool result and its stream
 *      is spliced back into the *same* response, so the user sees one
 *      continuous assistant message.
 *
 * Multi-round tool use is supported up to `maxLoops`.
 */
import {
  CUSTOM_TOOL_ID_PREFIX,
  sentinelFor,
  type ToolCallEnvelope,
} from "../protocol";
import { EnvelopeDetector } from "./envelope";
import { buildContinuation, type ToolResultRecord, type WireMessage } from "./messages";
import { readSSE, type SSEEvent } from "./sse";

const encoder = new TextEncoder();
const DEFAULT_MAX_LOOPS = 6;

/** Re-exported for existing imports; canonical home is `../protocol`. */
export { SLOT_SENTINEL_PREFIX, SLOT_SENTINEL_SUFFIX } from "../protocol";

function sseData(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

function sseJson(obj: Record<string, unknown>): Uint8Array {
  return sseData(JSON.stringify(obj));
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}

function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export interface SupervisorDeps {
  /** Execute a custom tool via the Bun harness. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Issue a follow-up chat request for the given conversation. */
  continueChat(messages: WireMessage[], signal?: AbortSignal): Promise<Response>;
  /** Observation hook for every parsed event (first + continuations). */
  onEvent?: (ev: SSEEvent) => void;
  /** Whether `name` is one of our custom (harness-executed) tools. */
  isCustomTool?: (name: string) => boolean;
  /** UI hook: a custom tool call is about to run. slotId is the display-only
   *  sentinel id; it matches the marker already emitted into the SSE text. */
  onToolStart?: (call: { id: string; name: string; arguments: Record<string, unknown>; slotId?: string }) => void;
  /** UI hook: a custom tool call finished. */
  onToolEnd?: (call: { id: string; name: string; result: string; error?: string }) => void;
}

export interface SupervisorInput {
  firstResponse: Response;
  /** AbortController for the initial response, allowing early stream termination. */
  firstController?: AbortController;
  /** The prepared conversation that produced `firstResponse` (instructions injected). */
  messages: WireMessage[];
  deps: SupervisorDeps;
  maxLoops?: number;
}

interface RoundOutcome {
  assistantText: string;
  calls: ToolCallEnvelope[];
  assistantShape: Record<string, unknown>;
  done: boolean;
}

/** Parse one upstream response: forward visible text/events, collect calls. */
async function* readRound(
  upstream: Response,
  deps: SupervisorDeps,
  abortController?: AbortController,
): AsyncGenerator<Uint8Array, RoundOutcome, void> {
  const det = new EnvelopeDetector();
  const calls: ToolCallEnvelope[] = [];
  let shape: Record<string, unknown> = { action: "success", role: "assistant", message: "" };
  let done = false;

  const stopUpstream = () => {
    try {
      abortController?.abort();
    } catch {
      /* ignore */
    }
  };

  try {
    for await (const ev of readSSE(upstream.body!)) {
      deps.onEvent?.(ev);

      if (ev.json?.role === "assistant" && typeof ev.json.message === "string") {
        shape = { ...ev.json };
        const text = ev.json.message as string;
        const step = det.push(text);
        if (step.safeText) yield sseJson({ ...ev.json, message: step.safeText });
        // Emit a display-only sentinel per detected call. Goes into the safeText
        // display pipe only -- assistantText (the model context) is untouched.
        // The slot id is persisted in the sidecar so reload can restore position.
        for (let i = 0; i < step.calls.length; i++) {
          const slotId = step.callIds[i]!;
          yield sseJson({ ...ev.json, message: sentinelFor(slotId) });
          calls.push({ ...step.calls[i]!, _slotId: slotId } as ToolCallEnvelope & { _slotId: string });
        }
        if (calls.length > 0) {
          // Tool call detected: halt upstream immediately to prevent hallucinated
          // tokens from bleeding into the conversation before real tool execution.
          stopUpstream();
          break;
        }
        continue;
      }

      // Native tool call for one of OUR tools: capture it and drop the event (we
      // emit our own synthetic call/result events and drive the continuation).
      if (
        ev.json?.role === "tool-invocation" &&
        typeof ev.json.toolName === "string" &&
        deps.isCustomTool?.(ev.json.toolName)
      ) {
        if (ev.json.state === "call") {
          calls.push({
            name: ev.json.toolName,
            arguments: parseToolArguments(ev.json.toolArguments),
            native: true,
            toolCallId: typeof ev.json.toolCallId === "string" ? ev.json.toolCallId : undefined,
          });
          stopUpstream();
          break;
        }
        continue;
      }

      if (ev.special?.startsWith("DONE")) {
        const tail = det.flush();
        if (tail.safeText) yield sseJson({ ...shape, message: tail.safeText });
        done = true;
        // Suppress DONE when tool rounds must follow: it would finalize the
        // message before the continuation is spliced in.
        if (calls.length === 0) yield sseData(ev.data);
        break;
      }

      // Structural event (tool-invocation, ui-component, source, PING, …).
      yield sseData(ev.data);
    }
  } catch (err) {
    if (calls.length === 0) throw err;
  }

  if (!done && calls.length === 0) {
    const tail = det.flush();
    if (tail.safeText) yield sseJson({ ...shape, message: tail.safeText });
  }

  return { assistantText: det.modelText, calls, assistantShape: shape, done };
}

export async function* superviseChat(
  input: SupervisorInput,
): AsyncGenerator<Uint8Array, void, void> {
  const { deps } = input;
  const maxLoops = input.maxLoops ?? DEFAULT_MAX_LOOPS;
  let messages = input.messages;
  let upstream: Response = input.firstResponse;
  let currentController: AbortController | undefined = input.firstController;
  let lastShape: Record<string, unknown> = {
    action: "success",
    role: "assistant",
    message: "",
    created: Date.now(),
  };

  for (let loop = 0; loop < maxLoops; loop++) {
    if (!upstream.body) {
      yield sseJson({ ...lastShape, message: "\n\n[duckai-ext] upstream response had no body." });
      yield sseData("[DONE]");
      return;
    }

    const outcome = yield* readRound(upstream, deps, currentController);
    lastShape = outcome.assistantShape;
    if (outcome.calls.length === 0) return;

    const results: ToolResultRecord[] = [];
    for (const call of outcome.calls) {
      const toolCallId = call.toolCallId ?? randomId(CUSTOM_TOOL_ID_PREFIX);
      const slotId = (call as ToolCallEnvelope & { _slotId?: string })._slotId;
      deps.onToolStart?.({ id: toolCallId, name: call.name, arguments: call.arguments, slotId });
      yield sseJson({
        action: "success",
        created: Date.now(),
        role: "tool-invocation",
        state: "call",
        toolCallId,
        toolName: call.name,
        toolArguments: JSON.stringify(call.arguments),
      });

      let resultStr: string;
      let error: string | undefined;
      try {
        const r = await deps.callTool(call.name, call.arguments);
        resultStr = typeof r === "string" ? r : JSON.stringify(r);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        resultStr = JSON.stringify({ error });
      }
      deps.onToolEnd?.({ id: toolCallId, name: call.name, result: resultStr, ...(error ? { error } : {}) });

      yield sseJson({
        id: randomId(CUSTOM_TOOL_ID_PREFIX),
        action: "success",
        created: Date.now(),
        role: "tool-invocation",
        state: "result",
        toolCallId,
        toolName: call.name,
        result: resultStr,
      });
      results.push({
        toolCallId,
        name: call.name,
        result: resultStr,
        ...(error ? { error } : {}),
        ...(call.native ? { native: true, arguments: call.arguments } : {}),
      });
    }

    messages = buildContinuation(messages, outcome.assistantText, results);

    // Brief breathing room to ensure DuckDuckGo clears the concurrency lock of the previous stream
    await new Promise((resolve) => setTimeout(resolve, 350));

    const nextController = new AbortController();
    let next: Response;
    try {
      next = await deps.continueChat(messages, nextController.signal);
    } catch (e) {
      yield sseJson({
        ...lastShape,
        message: `\n\n[duckai-ext] continuation request failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      yield sseData("[DONE]");
      return;
    }
    if (!next.ok || !next.body) {
      let errDetail = "";
      try {
        errDetail = (await next.clone().text()).slice(0, 300);
      } catch {}
      yield sseJson({
        ...lastShape,
        message: `\n\n[duckai-ext] continuation rejected (HTTP ${next.status}${errDetail ? `: ${errDetail}` : ""}).`,
      });
      yield sseData("[DONE]");
      return;
    }
    upstream = next;
    currentController = nextController;
  }

  yield sseJson({
    ...lastShape,
    message: `\n\n[duckai-ext] stopped after ${maxLoops} tool rounds.`,
  });
  yield sseData("[DONE]");
}

export function createChatStream(input: SupervisorInput): ReadableStream<Uint8Array> {
  const gen = superviseChat(input);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      try {
        await gen.return();
      } catch {
        /* already closed */
      }
    },
  });
}
