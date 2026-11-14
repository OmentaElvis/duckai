import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getCurrentConversationId,
  isHarnessEnabled,
  loadDisabledChats,
  resetHarnessState,
  saveDisabledChats,
  setHarnessEnabled,
  toggleHarness,
} from "../src/injected/composer-toggle";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe("composer toggle harness state", () => {
  beforeEach(() => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage =
      new MemoryStorage() as unknown as Storage;
    resetHarnessState();
  });

  afterEach(() => {
    resetHarnessState();
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  test("harness is enabled by default on a fresh chat", () => {
    expect(isHarnessEnabled()).toBe(true);
  });

  test("toggling harness on a fresh chat disables it", () => {
    const state1 = toggleHarness();
    expect(state1).toBe(false);
    expect(isHarnessEnabled()).toBe(false);

    const state2 = toggleHarness();
    expect(state2).toBe(true);
    expect(isHarnessEnabled()).toBe(true);
  });

  test("explicit setHarnessEnabled sets state", () => {
    setHarnessEnabled(false);
    expect(isHarnessEnabled()).toBe(false);

    setHarnessEnabled(true);
    expect(isHarnessEnabled()).toBe(true);
  });

  test("persists disabled conversation IDs in sessionStorage", () => {
    const disabled = new Set(["conv-123", "conv-456"]);
    saveDisabledChats(disabled);

    const reloaded = loadDisabledChats();
    expect(reloaded.has("conv-123")).toBe(true);
    expect(reloaded.has("conv-456")).toBe(true);
    expect(reloaded.has("conv-other")).toBe(false);
  });
});
