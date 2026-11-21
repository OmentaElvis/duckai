/**
 * Tool-permission approval prompt (human-in-the-loop).
 *
 * Temporarily replaces the prompt bar while a permission request is pending,
 * keeping the conversation history visible and interactive. The card is a
 * Preact island; the controller below owns the queue and the duck.ai anchor.
 */
import { useEffect, useRef } from "preact/hooks";
import type { PermissionScope } from "../protocol";
import { attachToBody, mountIsland, type Island } from "./ui/mount";
import { Button } from "./ui/components";
import { themeVars, usePageTheme } from "./ui/theme";
import STYLES from "./approval-ui.css";

export type ApprovalAnswer =
  | { action: "once" }
  | { action: "always"; scope?: string }
  | { action: "reject"; reason?: string };

export interface ApprovalUi {
  request(
    name: string,
    args: Record<string, unknown>,
    scopes?: PermissionScope[],
  ): Promise<ApprovalAnswer>;
  destroy(): void;
}

interface Pending {
  name: string;
  args: Record<string, unknown>;
  scopes?: PermissionScope[];
  resolve: (answer: ApprovalAnswer) => void;
}

type Mode = "main" | "scope";

function findPromptBar(): HTMLElement | null {
  const textarea =
    document.querySelector<HTMLTextAreaElement>('textarea[name="user-prompt"]') ||
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label*="Duck.ai"]') ||
    document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="Reply"]');

  if (!textarea) {
    return document.querySelector<HTMLElement>('[data-testid="duckai-chat-input"]');
  }
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
  if (name === "mcp_call") {
    const server = String(args.server ?? "");
    const tool = String(args.tool ?? "");
    const innerArgs = (args.arguments ?? args.args ?? {}) as Record<string, unknown>;
    const innerStr = JSON.stringify(innerArgs);
    return `${server} → ${tool}(${innerStr.length > 80 ? innerStr.slice(0, 80) + "…" : innerStr})`;
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
  const text = JSON.stringify(args);
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

function scopesFor(pending: Pending): PermissionScope[] {
  if (pending.scopes && pending.scopes.length > 0) return pending.scopes;
  return [{ id: pending.name, label: `All ${pending.name} calls`, isDefault: true }];
}


interface ApprovalBarProps {
  pending: Pending | null;
  mode: Mode;
  feedback: string;
  selectedScope: string;
  onFeedback: (value: string) => void;
  onMode: (mode: Mode) => void;
  onScope: (scope: string) => void;
  onAlways: (scope: string) => void;
  onSettle: (answer: ApprovalAnswer) => void;
}

function ApprovalBar(props: ApprovalBarProps) {
  const dark = usePageTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = props.pending;

  useEffect(() => {
    if (!pending || props.mode !== "main") return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [pending, props.mode]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (props.mode === "scope") {
        props.onMode("main");
        return;
      }
      const reason = props.feedback.trim();
      props.onSettle({ action: "reject", ...(reason ? { reason } : {}) });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, props.mode, props.feedback, props.onMode, props.onSettle]);

  if (!pending) return null;

  const scopes = scopesFor(pending);
  const isMcp = pending.name === "mcp_call" && pending.args?.server && pending.args?.tool;
  const badge = isMcp ? `mcp: ${String(pending.args.server)}` : "Permission";
  const tool = isMcp ? String(pending.args.tool) : pending.name;
  const feedback = props.feedback.trim();
  const rejectLabel = feedback ? "Reject with feedback" : "Reject";

  return (
    <div class="card" style={themeVars(dark)}>
      {props.mode === "main" ? (
        <div class="main-panel">
          <div class="header">
            <div class="badge-row">
              <span class="badge">{badge}</span>
              <span class="title">
                Allow <span class="tool-name">{tool}</span> to run?
              </span>
            </div>
          </div>

          <div class="preview">{formatPreview(pending.name, pending.args ?? {})}</div>

          <details>
            <summary>Show full arguments</summary>
            <pre class="full-args">{JSON.stringify(pending.args ?? {}, null, 2)}</pre>
          </details>

          <div class="feedback-box">
            <input
              ref={inputRef}
              type="text"
              class="feedback-input"
              placeholder="Alternative instructions or reason if rejecting (optional)..."
              autocomplete="off"
              value={props.feedback}
              onInput={(event) => props.onFeedback(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && props.feedback.trim()) {
                  event.preventDefault();
                  props.onSettle({ action: "reject", reason: props.feedback.trim() });
                }
              }}
            />
          </div>

          <div class="actions">
            <Button
              variant="danger"
              title={
                feedback
                  ? `Reject tool call and send: "${feedback}"`
                  : "Reject the tool call without instructions"
              }
              onClick={() => {
                props.onSettle({
                  action: "reject",
                  ...(feedback ? { reason: feedback } : {}),
                });
              }}
            >
              {rejectLabel}
            </Button>
            <Button
              onClick={() => {
                const preferred = scopes.find((scope) => scope.isDefault) ?? scopes[0];
                props.onAlways(preferred?.id ?? "");
              }}
            >
              Always allow…
            </Button>
            <Button variant="primary" onClick={() => props.onSettle({ action: "once" })}>
              Allow once
            </Button>
          </div>
        </div>
      ) : (
        <div class="confirm-panel">
          <div class="header">
            <div class="badge-row">
              <span class="badge">Confirm Grant</span>
              <span class="title">Select scope to always allow for this session:</span>
            </div>
          </div>
          <div class="confirm-subtitle">
            Subsequent matching calls will run without prompting.
          </div>
          <div class="scope-list">
            {scopes.map((scope) => (
              <label class="scope-item" key={scope.id}>
                <input
                  type="radio"
                  name="duckai-approval-scope"
                  value={scope.id}
                  checked={props.selectedScope === scope.id}
                  onChange={() => props.onScope(scope.id)}
                />
                <span class="scope-content">
                  <span class="scope-label">{scope.label}</span>
                  {scope.description ? (
                    <span class="scope-desc">{scope.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <div class="actions">
            <Button onClick={() => props.onMode("main")}>Back</Button>
            <Button
              variant="primary"
              onClick={() => props.onSettle({ action: "always", scope: props.selectedScope })}
            >
              Confirm Always Allow
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function mountApprovalUi(): ApprovalUi {
  let pending: Pending | null = null;
  const queue: Pending[] = [];
  let mode: Mode = "main";
  let feedback = "";
  let selectedScope = "";
  let hiddenPromptBar: HTMLElement | null = null;
  let prevPromptDisplayStyle = "";
  let island: Island<ApprovalBarProps>;

  const paint = (): void => {
    island.update({
      pending,
      mode,
      feedback,
      selectedScope,
      onFeedback: (value) => {
        feedback = value;
        paint();
      },
      onMode: (next) => {
        mode = next;
        paint();
      },
      onScope: (scope) => {
        selectedScope = scope;
        paint();
      },
      onAlways: (scope) => {
        selectedScope = scope;
        mode = "scope";
        paint();
      },
      onSettle: settle,
    });
  };

  function show(request: Pending): void {
    pending = request;
    mode = "main";
    feedback = "";
    const scopes = scopesFor(request);
    selectedScope = scopes.find((scope) => scope.isDefault)?.id ?? scopes[0]?.id ?? "";
    attach();
    island.host.style.display = "block";
    paint();
  }

  function hide(): void {
    island.host.style.display = "none";
    if (hiddenPromptBar) {
      hiddenPromptBar.style.display = prevPromptDisplayStyle;
      hiddenPromptBar = null;
    }
    paint();
  }

  function settle(answer: ApprovalAnswer): void {
    if (!pending) return;
    const request = pending;
    pending = null;
    request.resolve(answer);

    const next = queue.shift();
    if (next) show(next);
    else hide();
  }

  function attach(): void {
    const bar = findPromptBar();
    if (bar && bar.parentElement) {
      hiddenPromptBar = bar;
      prevPromptDisplayStyle = bar.style.display;

      const computed = window.getComputedStyle(bar);
      island.host.style.width =
        computed.width && computed.width !== "auto" ? computed.width : "100%";
      island.host.style.maxWidth =
        computed.maxWidth && computed.maxWidth !== "none" ? computed.maxWidth : "800px";
      island.host.style.marginLeft = "auto";
      island.host.style.marginRight = "auto";
      island.host.style.alignSelf = "center";
      island.host.style.boxSizing = "border-box";

      bar.style.display = "none";
      if (
        island.host.parentElement !== bar.parentElement ||
        island.host.nextElementSibling !== bar
      ) {
        bar.parentElement.insertBefore(island.host, bar);
      }
      island.host.removeAttribute("data-floating");
    } else {
      attachToBody(island.host);
      island.host.setAttribute("data-floating", "true");
    }
  }

  island = mountIsland<ApprovalBarProps>({
    marker: "data-duckai-ext-approval-bar",
    component: ApprovalBar,
    props: {
      pending,
      mode,
      feedback,
      selectedScope,
      onFeedback: () => {},
      onMode: () => {},
      onScope: () => {},
      onAlways: () => {},
      onSettle: () => {},
    },
    styles: STYLES,
  });

  return {
    request(name, params, scopes) {
      return new Promise<ApprovalAnswer>((resolve) => {
        const request: Pending = { name, args: params, scopes, resolve };
        if (pending) queue.push(request);
        else show(request);
      });
    },
    destroy(): void {
      if (hiddenPromptBar) {
        hiddenPromptBar.style.display = prevPromptDisplayStyle;
        hiddenPromptBar = null;
      }
      island.destroy();
    },
  };
}
