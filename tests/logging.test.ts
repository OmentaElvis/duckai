import { describe, expect, test } from "bun:test";
import {
  createLogger,
  formatAnsi,
  formatPrefix,
  isLogLevel,
  parseLogLevel,
} from "../src/logging/core";

describe("logging core", () => {
  test("emits only entries at or above the minimum level", () => {
    const seen: string[] = [];
    const log = createLogger({
      scope: "duckai",
      sink: (e) => seen.push(`${e.level}:${e.msg}`),
      minLevel: "info",
    });

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(seen).toEqual(["info:i", "warn:w", "error:e"]);
  });

  test("child loggers extend the scope and share history/forwarders", () => {
    const log = createLogger({ scope: "page", sink: () => {}, minLevel: "debug" });
    const child = log.child("fetch");
    const forwarded: string[] = [];
    log.onEntry((e) => forwarded.push(e.scope));

    child.info("hi");

    expect(child.scope).toBe("page:fetch");
    expect(forwarded).toEqual(["page:fetch"]);
    expect(log.history.map((e) => e.msg)).toEqual(["hi"]);
  });

  test("history is bounded", () => {
    const log = createLogger({
      scope: "x",
      sink: () => {},
      minLevel: "debug",
      historyMax: 2,
    });

    log.info("1");
    log.info("2");
    log.info("3");

    expect(log.history.map((e) => e.msg)).toEqual(["2", "3"]);
  });

  test("ingest preserves forwarded entries and respects the level", () => {
    const seen: string[] = [];
    const log = createLogger({
      scope: "duckai",
      sink: (e) => seen.push(`${e.scope}:${e.msg}`),
      minLevel: "info",
    });

    log.ingest({ t: Date.now(), level: "warn", scope: "page:fetch", msg: "careful" });
    log.ingest({ t: Date.now(), level: "debug", scope: "page:fetch", msg: "ignored" });

    expect(seen).toEqual(["page:fetch:careful"]);
  });

  test("formatting is plain by default and coloured on request", () => {
    const entry = {
      t: new Date(2024, 0, 1, 12, 34, 56, 789).getTime(),
      level: "warn" as const,
      scope: "duckai",
      msg: "hi",
    };

    expect(formatPrefix(entry)).toBe("12:34:56.789 WARN  duckai");
    expect(formatPrefix(entry)).not.toContain("\x1b[");
    expect(formatAnsi(entry)).toContain("\x1b[33m");
    expect(formatAnsi(entry)).toContain("duckai");
  });

  test("level parsing is case-insensitive and rejects junk", () => {
    expect(isLogLevel("debug")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(parseLogLevel(" WARN ")).toBe("warn");
    expect(parseLogLevel("nope")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});
