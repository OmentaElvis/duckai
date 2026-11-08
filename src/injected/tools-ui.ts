/**
 * Tool management UI.
 *
 * A modal panel (see ./modal.ts) listing every registered custom tool with:
 * - a checkbox to enable/disable it, and
 * - a permission selector (Allow / Ask / Deny).
 *
 * Enabling/disabling and the explicit permission selector persist on the Bun
 * host (global). In-conversation "Always allow" grants are session-scoped and
 * surface here as a read-only, session-sourced permission.
 */
import type { ManagedTool, Permission } from "../protocol";
import { createModal } from "./modal";

export interface ToolsUi {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  refresh(): void;
  destroy(): void;
}

export interface ToolsUiOptions {
  load: () => Promise<ManagedTool[]>;
  /** Persist and return the refreshed list. */
  setEnabled: (name: string, enabled: boolean) => Promise<ManagedTool[]>;
  /** Persist an explicit (global) permission and return the refreshed list. */
  setPermission: (name: string, level: Permission) => Promise<ManagedTool[]>;
  /** Called with the refreshed list after a successful change. */
  onChange?: (tools: ManagedTool[]) => void;
}

const LEVELS: Permission[] = ["ask", "allow", "deny"];
const SOURCE_LABEL: Record<string, string> = {
  session: "allowed for this session",
  policy: "set by you",
  default: "tool default",
};

export function mountToolsUi(opts: ToolsUiOptions): ToolsUi {
  const modal = createModal("tools");
  modal.addStyles(`
    .tool select {
      font: inherit; padding: 2px 6px; border-radius: 6px; flex: none;
      border: 1px solid var(--h-border); background: transparent; color: inherit;
    }
    .tool select:disabled { opacity: .5; }
    .tag { font-size: 11px; opacity: .5; margin-top: 3px; }
  `);

  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = "Tools";
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = "loading…";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "btn";
  refreshBtn.textContent = "Refresh";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  head.append(title, status, refreshBtn, closeBtn);

  const list = document.createElement("div");
  list.className = "list";

  const footer = document.createElement("div");
  footer.className = "footer";
  footer.textContent =
    "Disabled tools are not offered to the agent. Permission changes here are global; the in-chat prompt only grants the current session.";

  modal.card.append(head, list, footer);

  let busy = false;

  const message = (text: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "footer";
    el.textContent = text;
    return el;
  };

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const run = (fn: () => Promise<ManagedTool[]>): void => {
    void (async () => {
      try {
        const updated = await fn();
        render(updated);
        opts.onChange?.(updated);
      } catch {
        setStatus("update failed");
      }
    })();
  };

  const rowFor = (tool: ManagedTool): HTMLElement => {
    const row = document.createElement("div");
    row.className = tool.enabled ? "tool" : "tool off";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = tool.enabled;
    input.title = tool.enabled ? "Disable" : "Enable";
    input.addEventListener("change", () => {
      input.disabled = true;
      run(() => opts.setEnabled(tool.name, input.checked));
    });

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = tool.name;
    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = tool.description;
    info.append(name, desc);
    if (tool.permissionSource === "session") {
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = SOURCE_LABEL.session!;
      info.append(tag);
    }

    const select = document.createElement("select");
    for (const level of LEVELS) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = level;
      select.append(opt);
    }
    select.value = tool.permission;
    select.title = `Permission (${SOURCE_LABEL[tool.permissionSource] ?? tool.permissionSource})`;
    // A session grant can't be overridden from here.
    select.disabled = tool.permissionSource === "session";
    select.addEventListener("change", () => {
      select.disabled = true;
      run(() => opts.setPermission(tool.name, select.value as Permission));
    });

    row.append(input, info, select);
    return row;
  };

  const render = (tools: ManagedTool[]): void => {
    const enabled = tools.filter((t) => t.enabled).length;
    setStatus(`${enabled}/${tools.length} enabled`);
    if (tools.length === 0) {
      list.replaceChildren(message("No custom tools registered."));
      return;
    }
    list.replaceChildren(...tools.map(rowFor));
  };

  const load = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    setStatus("loading…");
    try {
      render(await opts.load());
    } catch {
      setStatus("error");
      list.replaceChildren(message("Could not load tools."));
    } finally {
      busy = false;
    }
  };

  refreshBtn.addEventListener("click", () => void load());
  closeBtn.addEventListener("click", modal.close);

  return {
    open(): void {
      modal.open();
      void load();
    },
    close: modal.close,
    toggle: modal.toggle,
    isOpen: modal.isOpen,
    refresh: () => void load(),
    destroy: modal.destroy,
  };
}
