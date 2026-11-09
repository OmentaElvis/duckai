import { afterEach, describe, expect, test } from "bun:test";
import {
  assistantElements,
  blocksFor,
  conversationIdOf,
  formatArgs,
  formatResult,
  parseAssistantId,
  parseSentinels,
  placementAnchor,
  summaryFor,
} from "../src/injected/ui";
import { sentinelFor, stripSlotSentinels } from "../src/protocol";
import { clearToolViews, registerToolView } from "../src/injected/tool-render";

/** Minimal ParentNode stub: routes by selector substring. */
function mockRoot(ids: string[], active: string[] = []): ParentNode {
  const mk = (id: string) => ({ id }) as unknown as HTMLElement;
  return {
    querySelectorAll(selector: string) {
      if (selector.includes("data-activeresponse")) return active.map(mk);
      return ids.map(mk);
    },
  } as unknown as ParentNode;
}

describe("assistantElements", () => {
  test("matches wrappers but not the nested heading- ids", () => {
    const root = mockRoot([
      "conv-assistant-message-0-1",
      "heading-conv-assistant-message-0-1",
      "conv-assistant-message-1-1",
      "heading-conv-assistant-message-1-1",
    ]);
    expect(assistantElements(root).map((el) => el.id)).toEqual([
      "conv-assistant-message-0-1",
      "conv-assistant-message-1-1",
    ]);
  });

  test("falls back to [data-activeresponse] when no wrapper ids exist", () => {
    const root = mockRoot([], ["a", "b"]);
    expect(assistantElements(root).map((el) => el.id)).toEqual(["a", "b"]);
  });
});

describe("placementAnchor", () => {
  test("returns the direct child of the message containing the heading marker", () => {
    const target = { querySelector: () => marker } as unknown as HTMLElement;
    const modelHeader = {} as HTMLElement;
    (modelHeader as unknown as { parentElement: HTMLElement }).parentElement = target;
    const marker = {} as HTMLElement;
    (marker as unknown as { parentElement: HTMLElement }).parentElement = modelHeader;

    expect(placementAnchor(target)).toBe(modelHeader);
  });

  test("returns null when there is no heading marker", () => {
    const target = { querySelector: () => null } as unknown as HTMLElement;
    expect(placementAnchor(target)).toBeNull();
  });
});

describe("parseAssistantId", () => {
  test("extracts turn and part from a response wrapper id", () => {
    expect(parseAssistantId("b24ead63-26d1-4b91-be2a-7da4a7987904-assistant-message-0-1")).toEqual({
      turn: 0,
      part: 1,
    });
    expect(parseAssistantId("x-assistant-message-12-3")).toEqual({ turn: 12, part: 3 });
  });

  test("returns null for unrelated ids", () => {
    expect(parseAssistantId("user-message")).toBeNull();
    expect(parseAssistantId("b24e-assistant-message")).toBeNull();
  });
});

describe("conversationIdOf", () => {
  test("extracts the conversation prefix from a wrapper id", () => {
    expect(conversationIdOf("b24ead63-26d1-4b91-be2a-7da4a7987904-assistant-message-0-1")).toBe(
      "b24ead63-26d1-4b91-be2a-7da4a7987904",
    );
  });

  test("returns null for ids without a turn/part suffix", () => {
    expect(conversationIdOf("heading-b24e-assistant-message-0-1")).toBe("heading-b24e");
    expect(conversationIdOf("user-message")).toBeNull();
    expect(conversationIdOf("-assistant-message-0-1")).toBeNull();
  });
});

describe("formatArgs", () => {
  test("pretty-prints objects", () => {
    expect(formatArgs({ text: "buy milk" })).toBe('{\n  "text": "buy milk"\n}');
  });

  test("empty for undefined", () => {
    expect(formatArgs(undefined)).toBe("");
  });

  test("clamps oversized output", () => {
    const big = "x".repeat(5000);
    const out = formatArgs({ big });
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("truncated");
  });
});

describe("formatResult", () => {
  test("indents JSON results", () => {
    expect(formatResult('{"ok":true,"n":2}')).toBe('{\n  "ok": true,\n  "n": 2\n}');
  });

  test("passes through non-JSON text", () => {
    expect(formatResult("hello world")).toBe("hello world");
  });

  test("keeps JSON scalars verbatim", () => {
    expect(formatResult("42")).toBe("42");
  });
});

describe("parseSentinels (inline placement markers)", () => {
  test("extracts slot ids in document order", () => {
    const text = `before ${sentinelFor("abc12345")} middle ${sentinelFor("def67890")} after`;
    expect(parseSentinels(text).map((m) => m.slotId)).toEqual(["abc12345", "def67890"]);
  });

  test("tolerates stripped PUA delimiters (markdown sanitizer)", () => {
    expect(parseSentinels("duckai-slot:abc12345").map((m) => m.slotId)).toEqual(["abc12345"]);
    expect(stripSlotSentinels("a duckai-slot:abc12345 b")).toBe("a  b");
  });

  test("no sentinel → empty", () => {
    expect(parseSentinels("hello world")).toEqual([]);
  });
});

describe("blocksFor / summaryFor (render interface)", () => {
  afterEach(() => clearToolViews());

  test("default summary is the inline args", () => {
    expect(summaryFor({ name: "x", args: { a: 1 }, status: "ok" })).toBe('{"a":1}');
  });

  test("a registered summary wins", () => {
    registerToolView("t", { summary: () => "custom" });
    expect(summaryFor({ name: "t", args: { a: 1 }, status: "ok" })).toBe("custom");
  });

  test("default body shows arguments and result", () => {
    expect(blocksFor({ name: "x", args: { a: 1 }, status: "ok", result: '{"b":2}' })).toEqual([
      { kind: "code", label: "Arguments", text: '{\n  "a": 1\n}' },
      { kind: "code", label: "Result", text: '{\n  "b": 2\n}' },
    ]);
  });

  test("a running call's default body has only arguments", () => {
    const blocks = blocksFor({ name: "x", args: { a: 1 }, status: "running" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", label: "Arguments" });
  });

  test("default body reports errors under an Error label", () => {
    const blocks = blocksFor({ name: "x", args: {}, status: "error", error: "kaboom" });
    expect(blocks.at(-1)).toEqual({ kind: "code", label: "Error", text: "kaboom" });
  });

  test("a registered body wins", () => {
    registerToolView("t", { body: () => [{ kind: "text", text: "hi" }] });
    expect(blocksFor({ name: "t", args: {}, status: "ok" })).toEqual([
      { kind: "text", text: "hi" },
    ]);
  });
});
