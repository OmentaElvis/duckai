import { describe, expect, test } from "bun:test";
import { EnvelopeDetector, parseToolCallSegment } from "../src/injected/envelope";
import { TOOL_OPEN, FENCE_CLOSE } from "../src/protocol";

function feed(chunks: string[]): { text: string; calls: { name: string; arguments: Record<string, unknown> }[] } {
  const det = new EnvelopeDetector();
  let text = "";
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  for (const c of chunks) {
    const step = det.push(c);
    text += step.safeText;
    calls.push(...step.calls);
  }
  const tail = det.flush();
  text += tail.safeText;
  calls.push(...tail.calls);
  return { text, calls };
}

const CALL = `${TOOL_OPEN}\n{"name":"echo","arguments":{"text":"hi"}}\n${FENCE_CLOSE}`;

describe("EnvelopeDetector", () => {
  test("plain text passes through untouched", () => {
    const { text, calls } = feed(["Hello ", "there, ", "friend!"]);
    expect(text).toBe("Hello there, friend!");
    expect(calls).toHaveLength(0);
  });

  test("detects a lone call and strips it", () => {
    const { text, calls } = feed([CALL]);
    expect(text).toBe("");
    expect(calls).toEqual([{ name: "echo", arguments: { text: "hi" } }]);
  });

  test("strips a call embedded in prose", () => {
    const { text, calls } = feed([`Let me check. ${CALL} Done.`]);
    expect(text).toBe("Let me check.  Done.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("echo");
  });

  test("byte-splitting resilience: one char at a time", () => {
    const { text, calls } = feed([`Before ${CALL} after`].flatMap((s) => [...s]));
    expect(text).toBe("Before  after");
    expect(calls).toEqual([{ name: "echo", arguments: { text: "hi" } }]);
  });

  test("holds back a partial opening fence mid-stream", () => {
    const det = new EnvelopeDetector();
    const a = det.push("hello ```duck");
    expect(a.safeText).toBe("hello ");
    expect(a.calls).toHaveLength(0);
    const b = det.push(CALL.slice("```duck".length));
    expect(b.calls).toEqual([{ name: "echo", arguments: { text: "hi" } }]);
  });

  test("flush releases held-back non-call text losslessly", () => {
    const det = new EnvelopeDetector();
    const a = det.push("value ```");
    expect(a.safeText).toBe("value ");
    const f = det.flush();
    expect(f.safeText).toBe("```");
    expect(f.calls).toHaveLength(0);
  });

  test("normal (non-duckai) fenced blocks are left as text", () => {
    const block = "```json\n{\"name\":\"echo\"}\n```";
    const { text, calls } = feed([block]);
    expect(text).toBe(block);
    expect(calls).toHaveLength(0);
  });

  test("tolerates an inner nested fence-free JSON body", () => {
    expect(parseToolCallSegment('\n{"name":"echo","arguments":{"text":"x"}}\n')).toEqual({
      name: "echo",
      arguments: { text: "x" },
    });
  });

  test("missing arguments defaults to empty object", () => {
    expect(parseToolCallSegment('{"name":"echo"}')).toEqual({ name: "echo", arguments: {} });
  });

  test("invalid body is preserved as text", () => {
    const bad = `${TOOL_OPEN}\nnot json\n${FENCE_CLOSE}`;
    const { text, calls } = feed([bad]);
    expect(text).toBe(bad);
    expect(calls).toHaveLength(0);
  });

  test("multiple calls in one chunk", () => {
    const two = `${CALL}${TOOL_OPEN}\n{"name":"echo","arguments":{"text":"two"}}\n${FENCE_CLOSE}`;
    const { calls } = feed([two]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.arguments).toEqual({ text: "two" });
  });
});
