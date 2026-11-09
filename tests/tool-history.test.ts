import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearHistory,
  listHistoryConversationIds,
  loadHistory,
  pruneHistory,
  recordEnd,
  recordStart,
} from "../src/injected/tool-history";

class MemStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const CONV = "b24ead63-26d1-4b91-be2a-7da4a7987904";

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { localStorage: new MemStorage() };
});

describe("tool-history", () => {
  test("records a started call as running", () => {
    recordStart(CONV, 1, { id: "c1", name: "todo_add", args: { text: "buy milk" } });
    const history = loadHistory(CONV);
    expect(history["1"]).toHaveLength(1);
    expect(history["1"]![0]).toMatchObject({
      id: "c1",
      name: "todo_add",
      args: { text: "buy milk" },
      status: "running",
    });
  });

  test("does not duplicate a call with the same id", () => {
    recordStart(CONV, 1, { id: "c1", name: "todo_add", args: {} });
    recordStart(CONV, 1, { id: "c1", name: "todo_add", args: {} });
    expect(loadHistory(CONV)["1"]).toHaveLength(1);
  });

  test("finishing updates status and result in place", () => {
    recordStart(CONV, 1, { id: "c1", name: "todo_add", args: {} });
    recordEnd(CONV, 1, { id: "c1", name: "todo_add", result: '{"ok":true}' });
    const call = loadHistory(CONV)["1"]![0]!;
    expect(call.status).toBe("ok");
    expect(call.result).toBe('{"ok":true}');
  });

  test("finishing an unknown call appends it as done", () => {
    recordEnd(CONV, 2, { id: "cx", name: "echo", result: "hi" });
    const call = loadHistory(CONV)["2"]![0]!;
    expect(call).toMatchObject({ id: "cx", name: "echo", status: "ok", result: "hi" });
  });

  test("errors are recorded as error status", () => {
    recordStart(CONV, 1, { id: "c1", name: "boom", args: {} });
    recordEnd(CONV, 1, { id: "c1", name: "boom", error: "kaboom" });
    expect(loadHistory(CONV)["1"]![0]!.status).toBe("error");
    expect(loadHistory(CONV)["1"]![0]!.error).toBe("kaboom");
  });

  test("isolates conversations and clears on demand", () => {
    recordStart(CONV, 1, { id: "c1", name: "a", args: {} });
    recordStart("other", 1, { id: "c2", name: "b", args: {} });
    expect(Object.keys(loadHistory(CONV))).toEqual(["1"]);
    clearHistory(CONV);
    expect(loadHistory(CONV)).toEqual({});
    expect(loadHistory("other")["1"]).toHaveLength(1);
  });

  test("ignores corrupt stored data", () => {
    const store = (globalThis as unknown as { window: { localStorage: MemStorage } }).window
      .localStorage;
    store.setItem(`duckai-ext:history:${CONV}`, "{not json");
    expect(loadHistory(CONV)).toEqual({});
  });

  test("lists conversation ids it holds history for", () => {
    recordStart(CONV, 1, { id: "c1", name: "a", args: {} });
    recordStart("other", 1, { id: "c2", name: "b", args: {} });
    expect(listHistoryConversationIds().sort()).toEqual([CONV, "other"].sort());
  });

  test("prunes history for conversations not kept", () => {
    recordStart(CONV, 1, { id: "c1", name: "a", args: {} });
    recordStart("other", 1, { id: "c2", name: "b", args: {} });
    recordStart("third", 1, { id: "c3", name: "c", args: {} });
    const removed = pruneHistory([CONV]);
    expect(removed).toBe(2);
    expect(listHistoryConversationIds()).toEqual([CONV]);
    expect(loadHistory("other")).toEqual({});
  });

  test("pruning with everything kept is a no-op", () => {
    recordStart(CONV, 1, { id: "c1", name: "a", args: {} });
    expect(pruneHistory(listHistoryConversationIds())).toBe(0);
    expect(loadHistory(CONV)["1"]).toHaveLength(1);
  });

  test("persists slotId so inline placement survives reload", () => {
    recordStart(CONV, 1, { id: "c1", name: "echo", args: {}, slotId: "slotabc1" });
    recordEnd(CONV, 1, { id: "c1", name: "echo", result: "hi" });
    const call = loadHistory(CONV)["1"]![0]!;
    expect(call.slotId).toBe("slotabc1");
    expect(call.status).toBe("ok");
  });

  test("backfills slotId on a duplicate start", () => {
    recordStart(CONV, 1, { id: "c1", name: "echo", args: {} });
    recordStart(CONV, 1, { id: "c1", name: "echo", args: {}, slotId: "latest01" });
    expect(loadHistory(CONV)["1"]).toHaveLength(1);
    expect(loadHistory(CONV)["1"]![0]!.slotId).toBe("latest01");
  });
});
