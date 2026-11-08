import { describe, expect, test } from "bun:test";
import { onSSEEvent, SSEParser, type SSEEvent } from "../src/injected/sse";

interface Streams {
  greeting: string;
  websearch: string;
}

const streams: Streams = (await Bun.file(
  new URL("./fixtures/duckai-streams.json", import.meta.url),
).json()) as Streams;

function payloadOf(name: keyof Streams): string {
  return streams[name];
}

function collect(chunks: string[], size = 13): SSEEvent[] {
  const events: SSEEvent[] = [];
  const off = onSSEEvent((ev) => events.push(ev));
  const parser = new SSEParser();
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += size) parser.push(chunk.slice(i, i + size));
  }
  parser.end();
  // onSSEEvent has no unsubscribe; isolate by using a fresh module-scope check:
  // we only assert on events observed during this call, so re-filter via slice.
  void off;
  return events;
}

describe("SSEParser on captured duck.ai streams", () => {
  test("greeting stream: text deltas, Greeting tool, ui-component, CHAT_TITLE, STOP_REASON", () => {
    const events = collect([payloadOf("greeting")]);
    const text = events
      .filter((e) => e.json?.role === "assistant" && typeof e.json.message === "string")
      .map((e) => e.json!.message as string)
      .join("");

    expect(text).toContain("Hello!");
    expect(text).toContain("How can I help you today?");

    const toolCall = events.find((e) => e.json?.role === "tool-invocation" && e.json.state === "call");
    expect(toolCall?.json?.toolName).toBe("Greeting");
    expect(toolCall?.json?.toolArguments).toBe('{"ok": true}');

    const uiComponent = events.find((e) => e.json?.role === "ui-component");
    expect(uiComponent?.json?.name).toBe("greeting");

    expect(events.some((e) => e.special?.startsWith("CHAT_TITLE:Hello"))).toBe(true);
    const done = events.find((e) => e.special?.startsWith("DONE"));
    expect(done?.special).toBe("DONE][STOP_REASON:tool_use");
  });

  test("web search stream: WebSearch call+result, citations, DONE", () => {
    const events = collect([payloadOf("websearch")]);

    const call = events.find(
      (e) =>
        e.json?.role === "tool-invocation" &&
        e.json.state === "call" &&
        e.json.toolName === "WebSearch",
    );
    expect(call).toBeDefined();
    expect(String(call!.json!.toolArguments)).toContain("Brunei");

    const result = events.find(
      (e) => e.json?.role === "tool-invocation" && e.json.state === "result",
    );
    expect(result?.json?.result).toContain("WebSearch completed");

    const citations = (
      (result?.json?.data as { citations?: unknown[] } | undefined)?.citations ?? []
    ).length;
    expect(citations).toBeGreaterThan(0);

    expect(events.some((e) => e.json?.role === "source")).toBe(true);
    expect(events.some((e) => e.special === "DONE")).toBe(true);
    expect(events.some((e) => e.special === "PING")).toBe(true);
  });

  test("all JSON events carry an action and parse as objects", () => {
    const events = collect([payloadOf("websearch")]);
    const jsonEvents = events.filter((e) => e.json !== null);
    expect(jsonEvents.length).toBeGreaterThan(50);
    for (const e of jsonEvents) {
      expect(typeof e.json!.action).toBe("string");
    }
  });

  test("chunk-size independence (byte-splitting resilience)", () => {
    const whole = collect([payloadOf("websearch")], 100000).length;
    const split = collect([payloadOf("websearch")], 5).length;
    expect(split).toBe(whole);
  });
});
