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

export interface McpServerUi {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  envKeys: string[];
}

export interface McpUpsert {
  name: string;
  command: string;
  args: string[];
  /** Omit to preserve existing env values. */
  env?: Record<string, string>;
  enabled: boolean;
}

export interface ToolsUiOptions {
  load: () => Promise<ManagedTool[]>;
  /** Persist and return the refreshed list. */
  setEnabled: (name: string, enabled: boolean) => Promise<ManagedTool[]>;
  /** Persist an explicit (global) permission and return the refreshed list. */
  setPermission: (name: string, level: Permission) => Promise<ManagedTool[]>;
  /** MCP server management (optional; section hidden when absent). */
  loadMcp?: () => Promise<McpServerUi[]>;
  upsertMcp?: (server: McpUpsert) => Promise<McpServerUi[]>;
  deleteMcp?: (name: string) => Promise<McpServerUi[]>;
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<McpServerUi[]>;
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
    .mcp-head { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; }
    .mcp-head .title { font-weight: 600; flex: 1 1 auto; }
    .mcp-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .mcp-form input[type=text], .mcp-form textarea {
      font: inherit; padding: 4px 8px; border-radius: 7px; width: 100%; box-sizing: border-box;
      border: 1px solid var(--h-border); background: transparent; color: inherit;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    }
    .mcp-form textarea { min-height: 44px; resize: vertical; }
    .mcp-form .mcp-actions { display: flex; gap: 6px; align-items: center; }
    .mcp-form .mcp-actions label { display: flex; gap: 5px; align-items: center; flex: 1 1 auto; }
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

  modal.card.append(head, list);

  // --- MCP servers (config-only plugin surface) ---
  const hasMcp = Boolean(opts.loadMcp && opts.upsertMcp && opts.deleteMcp && opts.setMcpEnabled);
  let mcpListEl: HTMLElement | null = null;
  let mcpStatus: HTMLElement | null = null;
  let editing: string | null = null;
  let nameInput: HTMLInputElement | null = null;
  let cmdInput: HTMLInputElement | null = null;
  let argsInput: HTMLInputElement | null = null;
  let envInput: HTMLTextAreaElement | null = null;
  let enabledInput: HTMLInputElement | null = null;

  const clearMcpForm = (): void => {
    editing = null;
    if (nameInput) { nameInput.value = ""; nameInput.disabled = false; }
    if (cmdInput) cmdInput.value = "";
    if (argsInput) argsInput.value = "";
    if (envInput) envInput.value = "";
    if (enabledInput) enabledInput.checked = true;
  };

  if (hasMcp) {
    const mcpHead = document.createElement("div");
    mcpHead.className = "mcp-head";
    const mcpTitle = document.createElement("span");
    mcpTitle.className = "title";
    mcpTitle.textContent = "MCP servers";
    mcpStatus = document.createElement("span");
    mcpStatus.className = "status";
    mcpHead.append(mcpTitle, mcpStatus);

    mcpListEl = document.createElement("div");
    mcpListEl.className = "list";

    const form = document.createElement("div");
    form.className = "mcp-form";
    nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "name (e.g. gmail)";
    cmdInput = document.createElement("input");
    cmdInput.type = "text";
    cmdInput.placeholder = "command (e.g. uvx)";
    argsInput = document.createElement("input");
    argsInput.type = "text";
    argsInput.placeholder = "args, space-separated (e.g. mcp-server-gmail)";
    envInput = document.createElement("textarea");
    envInput.placeholder = "env, one KEY=VALUE per line (optional)";
    const actions = document.createElement("div");
    actions.className = "mcp-actions";
    const enabledWrap = document.createElement("label");
    enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = true;
    enabledWrap.append(enabledInput, document.createTextNode("enabled"));
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn";
    saveBtn.textContent = "Save";
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "btn";
    newBtn.textContent = "New";
    actions.append(enabledWrap, saveBtn, newBtn);
    form.append(nameInput, cmdInput, argsInput, envInput, actions);

    const mcpFooter = document.createElement("div");
    mcpFooter.className = "footer";
    mcpFooter.textContent =
      "MCP servers run as local processes with your privileges — only add commands you trust. Env values are stored locally and never shown here.";

    modal.card.append(mcpHead, mcpListEl, form, mcpFooter);

    const setMcpStatus = (t: string): void => {
      if (mcpStatus) mcpStatus.textContent = t;
    };

    const parseArgs = (s: string): string[] =>
      s.trim() ? s.trim().split(/\s+/) : [];

    const parseEnv = (s: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const line of s.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const idx = t.indexOf("=");
        if (idx <= 0) continue;
        out[t.slice(0, idx).trim()] = t.slice(idx + 1);
      }
      return out;
    };

    const renderMcp = (servers: McpServerUi[]): void => {
      if (!mcpListEl) return;
      setMcpStatus(`${servers.filter((s) => s.enabled).length}/${servers.length} enabled`);
      if (servers.length === 0) {
        mcpListEl.replaceChildren(message("No MCP servers configured."));
        return;
      }
      mcpListEl.replaceChildren(...servers.map((srv) => {
        const row = document.createElement("div");
        row.className = srv.enabled ? "tool" : "tool off";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = srv.enabled;
        input.addEventListener("change", () => {
          input.disabled = true;
          void opts.setMcpEnabled?.(srv.name, input.checked)
            .then(renderMcp)
            .catch(() => setMcpStatus("update failed"));
        });
        const info = document.createElement("div");
        info.className = "info";
        const nm = document.createElement("div");
        nm.className = "name";
        nm.textContent = srv.name;
        const desc = document.createElement("div");
        desc.className = "desc";
        desc.textContent = [srv.command, ...srv.args].join(" ") +
          (srv.envKeys.length ? `  · env: ${srv.envKeys.join(", ")}` : "");
        info.append(nm, desc);
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
          editing = srv.name;
          if (nameInput) { nameInput.value = srv.name; nameInput.disabled = true; }
          if (cmdInput) cmdInput.value = srv.command;
          if (argsInput) argsInput.value = srv.args.join(" ");
          // Leave env blank on edit to preserve stored secrets.
          if (envInput) envInput.value = "";
          if (enabledInput) enabledInput.checked = srv.enabled;
          setMcpStatus(`editing ${srv.name} (env preserved unless retyped)`);
        });
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => {
          void opts.deleteMcp?.(srv.name)
            .then((updated) => { renderMcp(updated); clearMcpForm(); })
            .catch(() => setMcpStatus("delete failed"));
        });
        row.append(input, info, editBtn, delBtn);
        return row;
      }));
    };

    const loadMcp = async (): Promise<void> => {
      if (!opts.loadMcp || !mcpListEl) return;
      setMcpStatus("loading…");
      try {
        renderMcp(await opts.loadMcp());
      } catch {
        setMcpStatus("error");
        mcpListEl.replaceChildren(message("Could not load MCP servers."));
      }
    };

    saveBtn.addEventListener("click", () => {
      const name = nameInput?.value.trim() ?? "";
      const command = cmdInput?.value.trim() ?? "";
      if (!name || !command) { setMcpStatus("name and command required"); return; }
      const envText = envInput?.value ?? "";
      const env = envText.trim() ? parseEnv(envText) : undefined;
      void opts.upsertMcp?.({
        name, command, args: parseArgs(argsInput?.value ?? ""), env,
        enabled: enabledInput?.checked ?? true,
      }).then((updated) => { renderMcp(updated); clearMcpForm(); })
        .catch(() => setMcpStatus("save failed"));
    });
    newBtn.addEventListener("click", () => { clearMcpForm(); setMcpStatus(""); });

    // Stash loader on a property for open()/refresh() below.
    (modal as unknown as { __loadMcp?: () => Promise<void> }).__loadMcp = loadMcp;
  }

  modal.card.append(footer);

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

  const loadAll = (): void => {
    void load();
    void (modal as unknown as { __loadMcp?: () => Promise<void> }).__loadMcp?.();
  };

  refreshBtn.addEventListener("click", loadAll);
  closeBtn.addEventListener("click", modal.close);

  return {
    open(): void {
      modal.open();
      loadAll();
    },
    close: modal.close,
    toggle: modal.toggle,
    isOpen: modal.isOpen,
    refresh: loadAll,
    destroy: modal.destroy,
  };
}
