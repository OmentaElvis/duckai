import { describe, expect, test } from "bun:test";
import {
  healthCounts,
  healthStatusOf,
  summarizeHealth,
  type HealthCheck,
} from "../src/health-report";
import { checkEnvelopeGrammar } from "../src/injected/health";

const check = (id: string, status: HealthCheck["status"], detail?: string): HealthCheck => ({
  id,
  label: `label ${id}`,
  status,
  ...(detail ? { detail } : {}),
});

describe("health status aggregation", () => {
  test("fail dominates warn and ok", () => {
    expect(healthStatusOf([check("a", "ok"), check("b", "warn"), check("c", "fail")])).toBe("fail");
  });

  test("warn dominates ok", () => {
    expect(healthStatusOf([check("a", "ok"), check("b", "warn")])).toBe("warn");
  });

  test("all ok stays ok; skips are ignored", () => {
    expect(healthStatusOf([check("a", "ok"), check("b", "skip")])).toBe("ok");
  });

  test("counts every status", () => {
    expect(
      healthCounts([check("a", "ok"), check("b", "ok"), check("c", "warn"), check("d", "fail")]),
    ).toEqual({ ok: 2, warn: 1, fail: 1, skip: 0 });
  });
});

describe("summarizeHealth", () => {
  const report = {
    at: 1,
    status: "warn" as const,
    feVersion: "1.2.3",
    checks: [check("bridge", "ok", "ping ok"), check("vqd", "fail", "status HTTP 500")],
  };

  test("renders a header with counts and the fe version", () => {
    const text = summarizeHealth(report);
    expect(text).toContain("WARN");
    expect(text).toContain("1 ok, 0 warn, 1 fail, 0 skip");
    expect(text).toContain("fe=1.2.3");
  });

  test("lists every check with its detail", () => {
    const text = summarizeHealth(report);
    expect(text).toContain("label bridge");
    expect(text).toContain("ping ok");
    expect(text).toContain("status HTTP 500");
  });

  test("emits ANSI when colour is requested", () => {
    expect(summarizeHealth(report, { color: true })).toContain("\x1b[33m");
    expect(summarizeHealth(report)).not.toContain("\x1b[");
  });
});

describe("envelope grammar probe", () => {
  test("round-trips a well-formed call", () => {
    expect(checkEnvelopeGrammar().status).toBe("ok");
  });
});
