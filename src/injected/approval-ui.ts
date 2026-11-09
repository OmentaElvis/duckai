/**
 * Tool-permission approval prompt (human-in-the-loop).
 *
 * Temporarily replaces the prompt bar while a permission request is pending,
 * keeping the conversation history completely visible and interactive.
 *
 * Provides a dedicated feedback input box so the user can reject a tool call
 * with an alternative instruction (e.g. "don't delete, edit instead").
 */

export type ApprovalAnswer =
  | { action: "once" }
  | { action: "always" }
  | { action: "reject"; reason?: string };

export interface ApprovalUi {
  request(name: string, args: Record<string, unknown>): Promise<ApprovalAnswer>;
  destroy(): void;
}

interface Pending {
  name: string;
  args: Record<string, unknown>;
  resolve: (answer: ApprovalAnswer) => void;
}

function luminanceIsDark(): boolean {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (!m) return false;
    const [r = 255, g = 255, b = 255, a = 1] = m[1]!.split(",").map((s) => parseFloat(s));
    if (a === 0) return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  } catch {
    return false;
  }
}

function findPromptBar(): HTMLElement | null {
  const textarea =
    document.querySelector<HTMLTextAreaElement>('textarea[name="user-prompt"]') ||
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label*="Duck.ai"]') ||
    document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="Reply"]');

  if (!textarea) {
    return document.querySelector<HTMLElement>('[data-testid="duckai-chat-input"]');
  }
  // Target the chat-input element or form, falling back to textarea's direct container
  return (
    textarea.closest("form") ||
    textarea.closest('[data-testid="duckai-chat-input"]') ||
    textarea.parentElement
  );
}

function formatPreview(name: string, args: Record<string, unknown>): string {
  if (name === "run_command" && typeof args.command === "string") {
    return `$ ${args.command}`;
  }
  if (
    (name === "write_file" || name === "edit_file" || name === "delete_file" || name === "read_file") &&
    typeof args.path === "string"
  ) {
    return `${args.path}${args.content ? ` (${String(args.content).length} chars)` : ""}`;
  }
  if (name === "notify" && typeof args.message === "string") {
    return `${args.title ? `[${args.title}] ` : ""}${args.message}`;
  }
  const s = JSON.stringify(args);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

const STYLES = `
  :host {
    display: none;
    width: 100%;
    max-width: 800px;
    margin-left: auto !important;
    margin-right: auto !important;
    margin-top: 0;
    margin-bottom: 12px;
    align-self: center !important;
    justify-self: center !important;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.45;
    z-index: 100;
  }
  :host([data-floating="true"]) {
    position: fixed;
    bottom: 24px;
    left: 50% !important;
    right: auto !important;
    transform: translateX(-50%) !important;
    width: min(720px, calc(100vw - 32px)) !important;
    margin: 0 auto !important;
    z-index: 999999;
  }
  .card {
    width: 100%;
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
    box-sizing: border-box;
    padding: 12px 16px;
    border-radius: 12px;
    background: var(--h-bg, #222);
    color: var(--h-fg, #eee);
    border: 1px solid var(--h-border, rgba(255, 255, 255, 0.16));
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.28);
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .badge-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    background: rgba(240, 180, 41, 0.2);
    color: #f0b429;
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .title {
    font-size: 13px;
    font-weight: 600;
  }
  .tool-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: #4387f5;
  }
  .preview {
    margin: 4px 0 8px;
    padding: 7px 11px;
    border-radius: 7px;
    background: var(--h-hover, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--h-border, rgba(255, 255, 255, 0.1));
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
  }
  details {
    margin-bottom: 10px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    opacity: 0.7;
    user-select: none;
    margin-bottom: 4px;
  }
  summary:hover { opacity: 1; }
  .full-args {
    margin: 4px 0 0;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--h-hover, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--h-border, rgba(255, 255, 255, 0.08));
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    max-height: 140px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .feedback-box {
    margin: 6px 0 12px;
  }
  .feedback-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--h-border, rgba(255, 255, 255, 0.18));
    background: var(--h-hover, rgba(255, 255, 255, 0.05));
    color: var(--h-fg, #eee);
    font-family: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s, background 0.15s;
  }
  .feedback-input:focus {
    border-color: #3969ef;
    background: var(--h-bg, #242424);
  }
  .feedback-input::placeholder {
    opacity: 0.55;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  .btn {
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 7px;
    padding: 6px 13px;
    border: 1px solid var(--h-border, rgba(255, 255, 255, 0.18));
    background: transparent;
    color: inherit;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover {
    background: var(--h-hover, rgba(255, 255, 255, 0.1));
  }
  .btn.primary {
    background: #3969ef;
    border-color: #3969ef;
    color: #fff;
    font-weight: 600;
  }
  .btn.primary:hover {
    background: #2b56cc;
    border-color: #2b56cc;
  }
  .btn.danger {
    color: #e05252;
    border-color: rgba(224, 82, 82, 0.35);
  }
  .btn.danger:hover {
    background: rgba(224, 82, 82, 0.15);
    border-color: #e05252;
  }
`;

export function mountApprovalUi(): ApprovalUi {
  const host = document.createElement("div");
  host.setAttribute("data-duckai-ext-approval-bar", "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const card = document.createElement("div");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "header";

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "Permission";
  const title = document.createElement("span");
  title.className = "title";
  badgeRow.append(badge, title);
  header.append(badgeRow);

  const preview = document.createElement("div");
  preview.className = "preview";

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Show full arguments";
  const fullArgs = document.createElement("pre");
  fullArgs.className = "full-args";
  details.append(summary, fullArgs);

  const feedbackBox = document.createElement("div");
  feedbackBox.className = "feedback-box";
  const feedbackInput = document.createElement("input");
  feedbackInput.type = "text";
  feedbackInput.className = "feedback-input";
  feedbackInput.placeholder = "Alternative instructions or reason if rejecting (optional)...";
  feedbackInput.autocomplete = "off";
  feedbackBox.append(feedbackInput);

  const actions = document.createElement("div");
  actions.className = "actions";

  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.className = "btn danger";
  rejectBtn.textContent = "Reject";

  const alwaysBtn = document.createElement("button");
  alwaysBtn.type = "button";
  alwaysBtn.className = "btn";
  alwaysBtn.textContent = "Always allow (session)";

  const onceBtn = document.createElement("button");
  onceBtn.type = "button";
  onceBtn.className = "btn primary";
  onceBtn.textContent = "Allow once";

  actions.append(rejectBtn, alwaysBtn, onceBtn);
  card.append(header, preview, details, feedbackBox, actions);
  shadow.append(style, card);

  let pending: Pending | null = null;
  const queue: Pending[] = [];
  let hiddenPromptBar: HTMLElement | null = null;
  let prevPromptDisplayStyle = "";

  const applyTheme = (): void => {
    const dark = luminanceIsDark();
    host.style.setProperty("--h-bg", dark ? "#242424" : "#ffffff");
    host.style.setProperty("--h-fg", dark ? "#f2f2f2" : "#1a1a1a");
    host.style.setProperty("--h-border", dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.14)");
    host.style.setProperty("--h-hover", dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)");
  };

  const updateRejectBtn = (): void => {
    const text = feedbackInput.value.trim();
    if (text) {
      rejectBtn.textContent = "Reject with feedback";
      rejectBtn.title = `Reject tool call and send: "${text}"`;
    } else {
      rejectBtn.textContent = "Reject";
      rejectBtn.title = "Reject the tool call without instructions";
    }
  };

  feedbackInput.addEventListener("input", updateRejectBtn);
  feedbackInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && feedbackInput.value.trim()) {
      e.preventDefault();
      rejectBtn.click();
    }
  });

  const attach = (): void => {
    const bar = findPromptBar();
    if (bar && bar.parentElement) {
      hiddenPromptBar = bar;
      prevPromptDisplayStyle = bar.style.display;

      // Copy width & centering to match the prompt bar's exact footprint
      const computed = window.getComputedStyle(bar);
      host.style.width = computed.width && computed.width !== "auto" ? computed.width : "100%";
      host.style.maxWidth = computed.maxWidth && computed.maxWidth !== "none" ? computed.maxWidth : "800px";
      host.style.marginLeft = "auto";
      host.style.marginRight = "auto";
      host.style.alignSelf = "center";
      host.style.boxSizing = "border-box";

      bar.style.display = "none";
      if (host.parentElement !== bar.parentElement || host.nextElementSibling !== bar) {
        bar.parentElement.insertBefore(host, bar);
      }
      host.removeAttribute("data-floating");
    } else {
      if (!host.isConnected) document.body?.append(host);
      host.setAttribute("data-floating", "true");
    }
  };

  function show(req: Pending): void {
    pending = req;
    attach();
    applyTheme();

    title.innerHTML = `Allow <span class="tool-name">${req.name}</span> to run?`;
    preview.textContent = formatPreview(req.name, req.args ?? {});
    fullArgs.textContent = JSON.stringify(req.args ?? {}, null, 2);
    details.open = false;

    feedbackInput.value = "";
    updateRejectBtn();

    host.style.display = "block";
    setTimeout(() => {
      feedbackInput.focus();
    }, 50);
  }

  function settle(answer: ApprovalAnswer): void {
    if (!pending) return;
    const req = pending;
    pending = null;
    req.resolve(answer);

    const next = queue.shift();
    if (next) {
      show(next);
    } else {
      host.style.display = "none";
      if (hiddenPromptBar) {
        hiddenPromptBar.style.display = prevPromptDisplayStyle;
        hiddenPromptBar = null;
      }
    }
  }

  onceBtn.addEventListener("click", () => settle({ action: "once" }));
  alwaysBtn.addEventListener("click", () => settle({ action: "always" }));
  rejectBtn.addEventListener("click", () => {
    const reason = feedbackInput.value.trim();
    settle({ action: "reject", ...(reason ? { reason } : {}) });
  });

  const onKeydown = (e: KeyboardEvent): void => {
    if (!pending) return;
    if (e.key === "Escape") {
      e.preventDefault();
      const reason = feedbackInput.value.trim();
      settle({ action: "reject", ...(reason ? { reason } : {}) });
    }
  };
  document.addEventListener("keydown", onKeydown);

  return {
    request(name: string, params: Record<string, unknown>): Promise<ApprovalAnswer> {
      return new Promise<ApprovalAnswer>((resolve) => {
        const req: Pending = { name, args: params, resolve };
        if (pending) queue.push(req);
        else show(req);
      });
    },
    destroy(): void {
      document.removeEventListener("keydown", onKeydown);
      if (hiddenPromptBar) {
        hiddenPromptBar.style.display = prevPromptDisplayStyle;
        hiddenPromptBar = null;
      }
      host.remove();
    },
  };
}
