/**
 * Visible health UI.
 *
 * A Preact island opened from a "Plugin health" entry in duck.ai's Settings &
 * More menu (see ./settings-menu.ts).
 */
import type { HealthCheck, HealthReport, HealthStatus } from "../health-report";
import { attachToBody, mountIsland, type Island } from "./ui/mount";
import { Button, Modal } from "./ui/components";

const SYMBOL: Record<HealthStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "·" };
const DOT: Record<HealthStatus, string> = {
  ok: "#63c853",
  warn: "#f0b429",
  fail: "#de5833",
  skip: "#9aa0a6",
};

const STYLES = `
  .health-dot { width: 9px; height: 9px; border-radius: 50%; }
  .health-list { display: flex; flex-direction: column; }
  .health-row {
    display: flex; gap: 8px; padding: 4px 6px; border-radius: 7px;
    align-items: baseline;
  }
  .health-row:hover { background: var(--h-hover); }
  .health-sym { flex: none; width: 13px; text-align: center; }
  .health-sym.ok { color: #63c853; }
  .health-sym.warn { color: #f0b429; }
  .health-sym.fail { color: #de5833; }
  .health-sym.skip { color: #9aa0a6; }
  .health-label { flex: none; }
  .health-detail { opacity: .55; font-size: 12px; word-break: break-word; }
`;

export interface HealthUi {
  update(report: HealthReport): void;
  setRunning(): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface HealthUiOptions {
  /** Invoked when the user clicks "Run". */
  onRun?: () => void;
}

interface HealthPanelProps {
  open: boolean;
  report: HealthReport | null;
  running: boolean;
  onRun: () => void;
  onClose: () => void;
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

function HealthPanel({ open, report, running, onRun, onClose }: HealthPanelProps) {
  const status = running ? "checking…" : (report?.status ?? "no report");
  const dot = running ? DOT.skip : report ? DOT[report.status] : DOT.skip;

  return (
    <Modal
      open={open}
      title="Plugin health"
      status={status}
      icon={<span class="health-dot" style={{ background: dot }} />}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onRun}>Run</Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div class="health-list">
        {report ? (
          report.checks.map((check) => <HealthRow key={check.id} check={check} />)
        ) : (
          <div class="ui-footer">No report yet — click Run.</div>
        )}
      </div>
    </Modal>
  );
}

export function mountHealthUi(opts: HealthUiOptions = {}): HealthUi {
  let open = false;
  let report: HealthReport | null = null;
  let running = false;
  let island: Island<HealthPanelProps>;

  const close = (): void => {
    open = false;
    paint();
  };
  const paint = (): void => {
    island.update({
      open,
      report,
      running,
      onRun: () => opts.onRun?.(),
      onClose: close,
    });
  };
  const openPanel = (): void => {
    open = true;
    attachToBody(island.host);
    paint();
  };

  island = mountIsland<HealthPanelProps>({
    marker: "data-duckai-ext-modal-health",
    component: HealthPanel,
    props: {
      open,
      report,
      running,
      onRun: () => opts.onRun?.(),
      onClose: close,
    },
    styles: STYLES,
  });

  return {
    update(next) {
      report = next;
      running = false;
      paint();
    },
    setRunning() {
      running = true;
      paint();
    },
    open: openPanel,
    close,
    toggle() {
      if (open) close();
      else openPanel();
    },
    isOpen: () => open,
    destroy: () => island.destroy(),
  };
}
