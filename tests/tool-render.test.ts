import { afterEach, describe, expect, test } from "bun:test";
import {
  callBody,
  callSummary,
  clearToolViews,
  getToolView,
  registerToolView,
  registeredToolViews,
  unregisterToolView,
  type RenderBlock,
} from "../src/injected/tool-render";

afterEach(() => clearToolViews());

describe("tool-render registry", () => {
  test("registers and retrieves a view by tool name", () => {
    const view = { summary: () => "hi" };
    registerToolView("mail_search", view);
    expect(getToolView("mail_search")).toBe(view);
    expect(registeredToolViews()).toContain("mail_search");
  });

  test("unregisters a view", () => {
    registerToolView("x", {});
    unregisterToolView("x");
    expect(getToolView("x")).toBeUndefined();
  });

  test("ignores empty names", () => {
    registerToolView("", { summary: () => "nope" });
    expect(getToolView("")).toBeUndefined();
  });

  test("a later registration overwrites the earlier one", () => {
    registerToolView("t", { summary: () => "first" });
    registerToolView("t", { summary: () => "second" });
    expect(callSummary({ name: "t", args: {}, status: "ok" })).toBe("second");
  });
});

describe("callSummary", () => {
  test("returns undefined when no view is registered", () => {
    expect(callSummary({ name: "nope", args: {}, status: "ok" })).toBeUndefined();
  });

  test("passes the call through to the view", () => {
    registerToolView("t", { summary: (c) => `${c.status}:${(c.args as { n: number }).n}` });
    expect(callSummary({ name: "t", args: { n: 3 }, status: "error" })).toBe("error:3");
  });

  test("a throwing view degrades to undefined", () => {
    registerToolView("t", {
      summary: () => {
        throw new Error("boom");
      },
    });
    expect(callSummary({ name: "t", args: {}, status: "ok" })).toBeUndefined();
  });
});

describe("callBody", () => {
  test("returns blocks from a registered view", () => {
    registerToolView("t", { body: () => [{ kind: "text", text: "hi" }] });
    expect(callBody({ name: "t", args: {}, status: "ok" })).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("undefined when the view returns a non-array", () => {
    registerToolView("t", {
      body: () => "nope" as unknown as RenderBlock[],
    });
    expect(callBody({ name: "t", args: {}, status: "ok" })).toBeUndefined();
  });

  test("a throwing view degrades to undefined", () => {
    registerToolView("t", {
      body: () => {
        throw new Error("boom");
      },
    });
    expect(callBody({ name: "t", args: {}, status: "ok" })).toBeUndefined();
  });
});
