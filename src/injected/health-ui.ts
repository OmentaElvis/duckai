/**
 * Visible health UI.
 *
 * A modal panel (see ./modal.ts) listing the latest plugin health report. It is
 * opened from a "Plugin health" entry injected into duck.ai's *Settings & More*
 * menu (see ./settings-menu.ts), rather than floating over the page.
 */
import type { HealthCheck, HealthReport, HealthStatus } from "../health-report";
import { createModal } from "./modal";

const SYMBOL: Record<HealthStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "·" };
const DOT: Record<HealthStatus, string> = {
  ok: "#63c853",
  warn: "#f0b429",
  fail: "#de5833",
  skip: "#9aa0a6",
};

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

function rowFor(check: HealthCheck): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  const sym = document.createElement("span");
  sym.className = `sym ${check.status}`;
  sym.textContent = SYMBOL[check.status];
  const label = document.createElement("span");
  label.className = "lbl";
  label.textContent = check.label;
  row.append(sym, label);
  if (check.detail) {
    const detail = document.createElement("span");
    detail.className = "det";
    detail.textContent = check.detail;
    row.append(detail);
  }
  return row;
}

export function mountHealthUi(opts: HealthUiOptions = {}): HealthUi {
  const modal = createModal("health");

  const head = document.createElement("div");
  head.className = "head";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = DOT.skip;
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = "Plugin health";
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = "no report";
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "btn";
  runBtn.textContent = "Run";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  head.append(dot, title, status, runBtn, closeBtn);

  const list = document.createElement("div");
  list.className = "list";
  const empty = document.createElement("div");
  empty.className = "footer";
  empty.textContent = "No report yet — click Run.";
  list.append(empty);

  modal.card.append(head, list);

  closeBtn.addEventListener("click", modal.close);
  runBtn.addEventListener("click", () => opts.onRun?.());

  return {
    update(report: HealthReport): void {
      dot.style.background = DOT[report.status];
      status.textContent = report.status;
      list.replaceChildren(...report.checks.map(rowFor));
    },
    setRunning(): void {
      dot.style.background = DOT.skip;
      status.textContent = "checking…";
    },
    open: modal.open,
    close: modal.close,
    toggle: modal.toggle,
    isOpen: modal.isOpen,
    destroy: modal.destroy,
  };
}
