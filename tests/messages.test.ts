import { describe, expect, test } from "bun:test";
import { INSTRUCTION_MARKER, renderToolInstructions } from "../src/protocol";
import {
  buildContinuation,
  prepareMessages,
  sanitizeMessages,
  type WireMessage,
} from "../src/injected/messages";

const manifest = [
  {
    name: "echo",
    description: "Echo text.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  },
];

describe("prepareMessages", () => {
  test("injects instructions into the first user message", () => {
    const messages: WireMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "", parts: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ];
    const out = prepareMessages(messages, renderToolInstructions(manifest));
    const first = out[0]!.content as { type: string; text: string }[];
    // instructions are merged into the existing single text part
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain(INSTRUCTION_MARKER);
    expect(first[0]!.text.endsWith("hi")).toBe(true);
    // second user message untouched
    const third = out[2]!.content as { type: string; text: string }[];
    expect(third).toHaveLength(1);
    expect(third[0]!.text).toBe("again");
  });

  test("is idempotent (marker present)", () => {
    const instructions = renderToolInstructions(manifest);
    const once = prepareMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }], instructions);
    const twice = prepareMessages(once, instructions);
    expect(twice).toBe(once);
  });

  test("no user message → unchanged", () => {
    const messages: WireMessage[] = [{ role: "assistant", content: "", parts: [] }];
    expect(prepareMessages(messages, "X")).toBe(messages);
  });

  test("empty instructions → unchanged", () => {
    const messages: WireMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(prepareMessages(messages, "  ")).toBe(messages);
  });
});

describe("sanitizeMessages", () => {
  test("folds custom tool-invocation parts into text, keeps native ones", () => {
    const messages: WireMessage[] = [
      {
        role: "assistant",
        content: "",
        parts: [
          { type: "text", text: "thinking" },
          {
            type: "tool-invocation",
            state: "call",
            toolCallId: "duckai_ext_call_abc",
            toolName: "echo",
            toolArguments: '{"text":"hi"}',
          },
          {
            type: "tool-invocation",
            state: "result",
            toolCallId: "duckai_ext_call_abc",
            result: '{"echoed":"hi"}',
          },
          {
            type: "tool-invocation",
            state: "call",
            toolCallId: "toolu_native",
            toolName: "WebSearch",
            toolArguments: '{"query":"x"}',
          },
        ],
      },
    ];
    const out = sanitizeMessages(messages);
    const parts = out[0]!.parts as Record<string, unknown>[];
    expect(parts[0]!.type).toBe("text");
    expect(parts[1]!.type).toBe("text");
    expect(String(parts[1]!.text)).toContain("```duckai-tool");
    expect(String(parts[1]!.text)).toContain('"name":"echo"');
    expect(parts[2]!.type).toBe("text");
    expect(String(parts[2]!.text)).toContain("[duckai-ext:tool-result:start]");
    expect(String(parts[2]!.text)).toContain("echo");
    // native tool part preserved
    expect(parts[3]!.type).toBe("tool-invocation");
    expect(parts[3]!.toolName).toBe("WebSearch");
  });

  test("leaves purely native assistant messages untouched (same reference)", () => {
    const messages: WireMessage[] = [
      {
        role: "assistant",
        content: "",
        parts: [
          { type: "tool-invocation", state: "call", toolCallId: "toolu_1", toolName: "WebSearch", toolArguments: "{}" },
        ],
      },
    ];
    const out = sanitizeMessages(messages);
    expect(out[0]).toBe(messages[0]!);
  });

  test("resolves result names from the matching call id", () => {
    const messages: WireMessage[] = [
      {
        role: "assistant",
        content: "",
        parts: [
          { type: "tool-invocation", state: "call", toolCallId: "duckai_ext_call_z", toolName: "echo", toolArguments: "{}" },
          { type: "tool-invocation", state: "result", toolCallId: "duckai_ext_call_z", result: "42" },
        ],
      },
    ];
    const parts = sanitizeMessages(messages)[0]!.parts as Record<string, unknown>[];
    expect(String(parts[1]!.text)).toContain("[duckai-ext:tool-result:start]");
    expect(String(parts[1]!.text)).toContain("echo -> 42");
  });
});

describe("buildContinuation", () => {
  test("appends assistant text and a user tool-result turn", () => {
    const base: WireMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const out = buildContinuation(base, '<tool_call name="echo">{"text":"hi"}</tool_call>', [
      { toolCallId: "duckai_ext_call_1", name: "echo", result: '{"echoed":"hi"}' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[1]!.role).toBe("assistant");
    expect(out[2]!.role).toBe("user");
    const text = (out[2]!.content as { text: string }[])[0]!.text;
    expect(text).toContain("echo");
    expect(text).toContain('{"echoed":"hi"}');
  });

  test("marks errored results", () => {
    const out = buildContinuation([], "x", [
      { toolCallId: "duckai_ext_call_1", name: "boom", result: '{"error":"nope"}', error: "nope" },
    ]);
    const text = (out[1]!.content as { text: string }[])[0]!.text;
    expect(text).toContain("ERROR");
  });
});
