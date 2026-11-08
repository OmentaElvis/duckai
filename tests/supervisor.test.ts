import { describe, expect, test } from "bun:test";
import { createChatStream, type SupervisorDeps } from "../src/injected/chat-supervisor";
import { readSSE, type SSEEvent } from "../src/injected/sse";
import { FENCE_CLOSE, TOOL_OPEN } from "../src/protocol";

const enc = new TextEncoder();

/** Build a `duckai-tool` fenced envelope for a call. */
function toolCall(name: string, args: Record<string, unknown> = {}): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, arguments: args })}\n${FENCE_CLOSE}`;
}

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${e}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function assistant(message: string): string {
  return JSON.stringify({ role: "assistant", message, created: 1, action: "success" });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const ev of readSSE(stream)) out.push(ev);
  return out;
}

function assistantText(events: SSEEvent[]): string {
  return events
    .filter((e) => e.json?.role === "assistant")
    .map((e) => String(e.json!.message ?? ""))
    .join("");
}

describe("chat supervisor", () => {
  test("passes a normal response through and forwards DONE", async () => {
    const first = sseResponse([assistant("Hello"), assistant(" world"), "[DONE]"]);
    let continued = false;
    const deps: SupervisorDeps = {
      callTool: async () => ({}),
      continueChat: async () => {
        continued = true;
        return sseResponse(["[DONE]"]);
      },
    };
    const out = await drain(createChatStream({ firstResponse: first, messages: [], deps }));
    expect(assistantText(out)).toBe("Hello world");
    expect(out.some((e) => e.special === "DONE")).toBe(true);
    expect(continued).toBe(false);
  });

  test("executes a tool call, emits synthetic events, and continues", async () => {
    const first = sseResponse([
      assistant("Let me check. "),
      assistant(toolCall("echo", { text: "hi" })),
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];
    let continuationMessages: unknown[] = [];
    const deps: SupervisorDeps = {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { echoed: "hi" };
      },
      continueChat: async (messages) => {
        continuationMessages = messages;
        return sseResponse([assistant("Your text was: hi"), "[DONE]"]);
      },
    };

    const out = await drain(createChatStream({ firstResponse: first, messages: [{ role: "user", content: [{ type: "text", text: "echo hi" }] }], deps }));

    // Tool executed once with parsed args.
    expect(calls).toEqual([{ name: "echo", args: { text: "hi" } }]);

    // Envelope stripped from rendered text; continuation text spliced in.
    const text = assistantText(out);
    expect(text).toBe("Let me check. Your text was: hi");
    expect(text).not.toContain("duckai-tool");

    // Synthetic call + result events present.
    const call = out.find((e) => e.json?.role === "tool-invocation" && e.json.state === "call");
    expect(call?.json?.toolName).toBe("echo");
    const result = out.find((e) => e.json?.role === "tool-invocation" && e.json.state === "result");
    expect(result?.json?.result).toBe('{"echoed":"hi"}');
    expect(String(result?.json?.toolCallId)).toStartWith("duckai_ext_call_");

    // Continuation conversation carries assistant envelope + user result.
    expect(continuationMessages).toHaveLength(3);
    const last = continuationMessages[2] as { role: string; content: { text: string }[] };
    expect(last.role).toBe("user");
    expect(last.content[0]!.text).toContain('{"echoed":"hi"}');

    // Exactly one DONE, at the end.
    expect(out.filter((e) => e.special === "DONE")).toHaveLength(1);
  });

  test("handles envelope split across deltas", async () => {
    const first = sseResponse([
      assistant("prefix "),
      assistant(TOOL_OPEN),
      assistant('\n{"name":"echo","arguments":{"text":"x"}}\n'),
      assistant(FENCE_CLOSE),
      assistant("suffix"),
    ]);
    const deps: SupervisorDeps = {
      callTool: async () => ({ ok: true }),
      continueChat: async () => sseResponse([assistant("done"), "[DONE]"]),
    };
    const out = await drain(createChatStream({ firstResponse: first, messages: [], deps }));
    expect(assistantText(out)).toBe("prefix suffixdone");
  });

  test("surfaces tool errors and still continues", async () => {
    const first = sseResponse([assistant(toolCall("boom"))]);
    let sawError: string | undefined;
    const deps: SupervisorDeps = {
      callTool: async () => {
        throw new Error("kaboom");
      },
      continueChat: async () => sseResponse([assistant("recovered"), "[DONE]"]),
    };
    const out = await drain(createChatStream({ firstResponse: first, messages: [], deps }));
    const result = out.find((e) => e.json?.state === "result");
    expect(String(result?.json?.result)).toContain("kaboom");
    sawError = String(result?.json?.result);
    expect(sawError).toBeDefined();
    expect(assistantText(out)).toContain("recovered");
  });

  test("emits an error and closes when continuation is rejected", async () => {
    const first = sseResponse([assistant(toolCall("echo"))]);
    const deps: SupervisorDeps = {
      callTool: async () => ({}),
      continueChat: async () => new Response("nope", { status: 418 }),
    };
    const out = await drain(createChatStream({ firstResponse: first, messages: [], deps }));
    expect(assistantText(out)).toContain("continuation rejected");
    expect(out.some((e) => e.special === "DONE")).toBe(true);
  });

  test("supports multiple tool rounds up to the budget", async () => {
    let round = 0;
    const deps: SupervisorDeps = {
      callTool: async () => ({ round: round++ }),
      continueChat: async () =>
        // Always emit a call again — exercises the MAX_LOOPS guard (maxLoops=2).
        sseResponse([assistant(toolCall("echo"))]),
    };
    const first = sseResponse([assistant(toolCall("echo"))]);
    const out = await drain(
      createChatStream({ firstResponse: first, messages: [], deps, maxLoops: 2 }),
    );
    expect(assistantText(out)).toContain("stopped after 2 tool rounds");
    expect(round).toBe(2);
  });
});
