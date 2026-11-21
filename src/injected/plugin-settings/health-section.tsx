/**
 * Health section for the Plugin settings dialog.
 *
 * The report itself is produced by ./health.ts (in the page) and handed in by
 * the controller, so this component is a pure renderer with a single action.
 */
import type { HealthCheck, HealthReport, HealthStatus } from "../../health-report";
import { healthCounts } from "../../health-report";
import { Button, Footer } from "../ui/components";

const SYMBOL: Record<HealthStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "·" };

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  ok: "healthy",
  warn: "warning",
  fail: "failing",
  skip: "not checked",
};

export function HealthDot({ status }: { status: HealthStatus }) {
  return <span class={`health-dot ${status}`} />;
}

function HealthRow({ check }: { check: HealthCheck }) {
  return (
    <div class="health-row">
      <span class={`health-sym ${check.status}`}>{SYMBOL[check.status]}</span>
      <span class="health-label">{check.label}</span>
      {check.detail ? <span class="health-detail">{check.detail}</span> : null}
    </div>
  );
}

export interface HealthSectionProps {
  report: HealthReport | null;
  running: boolean;
  onRun: () => void;
}

export function HealthSection({ report, running, onRun }: HealthSectionProps) {
  const status: HealthStatus = running ? "skip" : (report?.status ?? "skip");
  const statusText = running ? "checking…" : report ? HEALTH_LABEL[report.status] : "no report";
  const counts = report ? healthCounts(report.checks) : null;

  return (
    <>
      <div class="ps-pane-head">
        <div class="ps-pane-heading">
          <div class="ps-pane-title">Health check</div>
          <div class="ps-pane-desc">
            Probe the live page for drift in the bridge, DOM anchors and storage.
          </div>
        </div>
        <span class={`ps-pane-status ${status}`}>{statusText}</span>
        <Button onClick={onRun} disabled={running}>
          {running ? "Running…" : "Run"}
        </Button>
      </div>

      <div class="ps-scroll">
        {report ? (
          <>
            <div class="ps-summary">
              {counts ? (
                <>
                  <span class="ok">{counts.ok} ok</span>
                  <span class="warn">{counts.warn} warn</span>
                  <span class="fail">{counts.fail} fail</span>
                  <span class="skip">{counts.skip} skipped</span>
                </>
              ) : null}
              <span class="ps-summary-time">
                {report.feVersion ? `fe ${report.feVersion} · ` : ""}
                {new Date(report.at).toLocaleTimeString()}
              </span>
            </div>
            <div class="health-list">
              {report.checks.map((check) => (
                <HealthRow key={check.id} check={check} />
              ))}
            </div>
          </>
        ) : (
          <div class="ps-empty">No report yet. Run the checks to probe the live page.</div>
        )}
      </div>

      <Footer>
        Covers the IPC bridge, fetch hook, tool manifest, envelope grammar, duck.ai selectors,
        storage and live traffic.
      </Footer>
    </>
  );
}
