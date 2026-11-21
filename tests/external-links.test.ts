import { describe, expect, test } from "bun:test";
import { isExternalUrl } from "../src/injected/external-links";

describe("isExternalUrl", () => {
  const origin = "https://duck.ai";

  test("classifies different domains as external", () => {
    expect(isExternalUrl("https://duckduckgo.com/privacy", null, origin)).toBe(true);
    expect(isExternalUrl("https://en.wikipedia.org/wiki/Duck", null, origin)).toBe(true);
    expect(isExternalUrl("https://github.com", null, origin)).toBe(true);
  });

  test("classifies target=_blank links as external", () => {
    expect(isExternalUrl("https://duck.ai/terms", "_blank", origin)).toBe(true);
    expect(isExternalUrl("/terms", "_blank", origin)).toBe(true);
  });

  test("classifies mailto links as external", () => {
    expect(isExternalUrl("mailto:support@duck.ai", null, origin)).toBe(true);
  });

  test("keeps internal in-app navigation within webview", () => {
    expect(isExternalUrl("/chat", null, origin)).toBe(false);
    expect(isExternalUrl("https://duck.ai/chat/abc-123", null, origin)).toBe(false);
    expect(isExternalUrl("https://duck.ai/", null, origin)).toBe(false);
  });

  test("ignores in-page anchors and javascript urls", () => {
    expect(isExternalUrl("#section-1", null, origin)).toBe(false);
    expect(isExternalUrl("javascript:void(0)", null, origin)).toBe(false);
    expect(isExternalUrl("", null, origin)).toBe(false);
  });
});
