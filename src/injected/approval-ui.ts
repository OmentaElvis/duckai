/**
 * Tool-permission approval prompt (human-in-the-loop).
 *
 * Shown when a tool's effective permission is `"ask"`. The user can allow the
 * call once, allow it for the rest of this app session, or reject it. "Always
 * allow" is deliberately session-scoped (in-memory on the Bun host) — a global,
 * persisted permission only changes via the explicit tool-management UI.
 *
 * Requests are serialized: overlapping prompts queue up and show one at a time.
 */
import { createModal } from "./modal";

export type ApprovalAnswer = "once" | "always" | "reject";

export interface ApprovalUi {
  request(name: string, args: Record<string, unknown>): Promise<ApprovalAnswer>;
  destroy(): void;
}

interface Pending {
  name: string;
  args: Record<string, unknown>;
  resolve: (answer: ApprovalAnswer) => void;
}

export function mountApprovalUi(): ApprovalUi {
  const modal = createModal("approval", {
    onClose: () => {
      // Escape / backdrop / programmatic close = reject.
      if (pending) settle("reject");
    },
  });
  modal.addStyles(`
    .q { margin: 0 0 8px; font-weight: 600; }
    .args {
      margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; max-height: 40vh; overflow: auto;
      background: var(--h-hover); border: 1px solid var(--h-border);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      white-space: pre-wrap; word-break: break-word;
    }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .actions .btn.primary { background: #3969ef; border-color: #3969ef; color: #fff; }
    .actions .btn.primary:hover { background: #2f59cc; }
  `);

  const q = document.createElement("div");
  q.className = "q";
  const args = document.createElement("pre");
  args.className = "args";
  const actions = document.createElement("div");
  actions.className = "actions";

  const button = (text: string, primary = false): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "btn primary" : "btn";
    b.textContent = text;
    return b;
  };
  const onceBtn = button("Allow once", true);
  const alwaysBtn = button("Always allow (session)");
  const rejectBtn = button("Reject");
  actions.append(rejectBtn, alwaysBtn, onceBtn);

  modal.card.append(q, args, actions);

  let pending: Pending | null = null;
  const queue: Pending[] = [];

  function show(req: Pending): void {
    pending = req;
    q.textContent = `Allow “${req.name}” to run?`;
    args.textContent = JSON.stringify(req.args ?? {}, null, 2);
    modal.open();
  }

  function settle(answer: ApprovalAnswer): void {
    if (!pending) return;
    const req = pending;
    pending = null;
    req.resolve(answer);
    const next = queue.shift();
    if (next) show(next);
    else modal.close();
  }

  onceBtn.addEventListener("click", () => settle("once"));
  alwaysBtn.addEventListener("click", () => settle("always"));
  rejectBtn.addEventListener("click", () => settle("reject"));

  return {
    request(name: string, params: Record<string, unknown>): Promise<ApprovalAnswer> {
      return new Promise<ApprovalAnswer>((resolve) => {
        const req: Pending = { name, args: params, resolve };
        if (pending) queue.push(req);
        else show(req);
      });
    },
    destroy(): void {
      modal.destroy();
    },
  };
}
