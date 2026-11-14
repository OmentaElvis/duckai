import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  RELOAD_MARKER_MAX_AGE_MS,
  clearReloadMarker,
  consumeReloadMarker,
  markReloading,
} from "../src/injected/reload-overlay";

/** Minimal sessionStorage stand-in for the DOM-free test environment. */
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

describe("reload marker", () => {
  beforeEach(() => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage =
      new MemoryStorage() as unknown as Storage;
  });

  afterEach(() => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  test("round-trips the upstream version and is consumed once", () => {
    markReloading("serp_v2");
    const marker = consumeReloadMarker();
    expect(marker?.upstreamVersion).toBe("serp_v2");
    expect(marker?.at).toBeGreaterThan(0);
    // Second read: the marker must not leak into another page load.
    expect(consumeReloadMarker()).toBeNull();
  });

  test("ignores stale markers left behind by an interrupted reload", () => {
    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    storage.setItem(
      "duckai-ext:reload-marker",
      JSON.stringify({ at: Date.now() - RELOAD_MARKER_MAX_AGE_MS - 1 }),
    );
    expect(consumeReloadMarker()).toBeNull();
  });

  test("clearReloadMarker removes a pending marker", () => {
    markReloading("serp_v2");
    clearReloadMarker();
    expect(consumeReloadMarker()).toBeNull();
  });
});