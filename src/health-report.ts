/**
 * Shared health-report contract + formatting.
 *
 * Bundled into BOTH the Bun harness and the injected page script (no runtime
 * coupling), so the exact same shape and rendering is used wherever a report is
 * produced or shown.
 */

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthCheck {
  /** Stable machine id, e.g. "bridge". */
  id: string;
  /** Human label shown in the report. */
  label: string;
  status: HealthStatus;
  /** Optional short explanation (URL, counts, error message…). */
  detail?: string;
}

export interface HealthReport {
  /** Epoch ms the report was produced. */
  at: number;
  /** Worst status across all checks. */
  status: HealthStatus;
  checks: HealthCheck[];
  /** Duck.ai front-end build string, when observed. */
  feVersion?: string;
}

/** Aggregate status: any fail → fail; else any warn → warn; else ok. */
export function healthStatusOf(checks: HealthCheck[]): HealthStatus {
  let status: HealthStatus = "ok";
  for (const c of checks) {
    if (c.status === "fail") return "fail";
    if (c.status === "warn") status = "warn";
  }
  return status;
}

export function healthCounts(checks: HealthCheck[]): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] += 1;
  return counts;
}

const SYMBOL: Record<HealthStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "·" };

const COLOR: Record<HealthStatus, string> = {
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  fail: "\x1b[31m",
  skip: "\x1b[90m",
};
const RESET = "\x1b[0m";

/**
 * Render a report as a compact multi-line block suitable for a terminal.
 * Pure — safe to unit test and to call from either bundle.
 */
export function summarizeHealth(report: HealthReport, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? false;
  const counts = healthCounts(report.checks);
  const head = report.status.toUpperCase();
  const header =
    `duckai health: ${color ? `${COLOR[report.status]}${head}${RESET}` : head} ` +
    `(${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip)` +
    (report.feVersion ? `  fe=${report.feVersion}` : "");

  const lines = [header];
  for (const c of report.checks) {
    const mark = color ? `${COLOR[c.status]}${SYMBOL[c.status]}${RESET}` : SYMBOL[c.status];
    const detail = c.detail ? ` — ${c.detail}` : "";
    lines.push(`  ${mark} ${c.label}${detail}`);
  }
  return lines.join("\n");
}
