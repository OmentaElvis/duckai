/**
 * Tool management UI.
 *
 * A Preact island rendered inside a shadow root (see ./ui/mount.ts). The
 * component owns its state; adding a field is a JSX edit, not another nullable
 * DOM ref and a manual show/hide pass.
 *
 * Enabling/disabling and the explicit permission selector persist on the Bun
 * host (global). In-conversation "Always allow" grants are session-scoped and
 * surface here as a read-only, session-sourced permission.
 */
import { useEffect, useState } from "preact/hooks";
import type { ManagedTool, Permission } from "../protocol";
import {
  attachToBody,
  mountIsland,
  type Island,
} from "./ui/mount";
import {
  Button,
  Checkbox,
  Footer,
  Modal,
  Row,
  SectionHead,
  Select,
  TextArea,
  TextInput,
  type SelectOption,
} from "./ui/components";
import {
  emptyMcpForm,
  formFromServer,
  mcpStatus,
  parseArgs,
  parseEnv,
  parseHeaders,
  type McpFormState,
  type McpServerUi,
  type McpTransportKind,
  type McpUpsert,
} from "./tools-model";

export type { McpServerUi, McpTransportKind, McpUpsert } from "./tools-model";

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
const TRANSPORTS: SelectOption[] = [
  { value: "stdio", label: "stdio (local command)" },
  { value: "http", label: "http (Streamable HTTP)" },
  { value: "sse", label: "sse (legacy HTTP+SSE)" },
];

/** Panel-specific CSS; the shared kit primitives come from ./ui/styles.ts. */
const STYLES = `
  .ui-tool-row { gap: 10px; align-items: flex-start; }
  .ui-tool-row > input[type=checkbox] {
    width: 16px; height: 16px; margin: 3px 0 0; flex: none;
    accent-color: #3969ef; cursor: pointer;
  }
  .ui-tool-row .ui-select { flex: none; padding: 2px 6px; }
  .ui-tool-info { flex: 1 1 auto; min-width: 0; }
  .ui-tool-name {
    font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ui-tool-desc { opacity: .6; font-size: 12px; margin-top: 2px; }
  .ui-tool-row.off .ui-tool-name, .ui-tool-row.off .ui-tool-desc { opacity: .45; }
  .ui-tag { font-size: 11px; opacity: .5; margin-top: 3px; }

  .ui-mcp-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .ui-mcp-fields { display: flex; flex-direction: column; gap: 6px; }
  .ui-mcp-form .ui-input,
  .ui-mcp-form .ui-textarea,
  .ui-mcp-form .ui-select {
    width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .ui-mcp-actions { display: flex; gap: 6px; align-items: center; }
  .ui-mcp-actions .ui-check { flex: 1 1 auto; }
`;

function toolStatus(tools: ManagedTool[]): string {
  const enabled = tools.filter((tool) => tool.enabled).length;
  return `${enabled}/${tools.length} enabled`;
}

interface ToolsPanelProps {
  open: boolean;
  refreshToken: number;
  onClose: () => void;
  onRefresh: () => void;
  opts: ToolsUiOptions;
}

function ToolsPanel({ open, refreshToken, onClose, onRefresh, opts }: ToolsPanelProps) {
  const [tools, setTools] = useState<ManagedTool[] | null>(null);
  const [servers, setServers] = useState<McpServerUi[] | null>(null);
  const [toolsStatus, setToolsStatus] = useState("loading…");
  const [mcpStatusText, setMcpStatusText] = useState("");
  const [pendingTools, setPendingTools] = useState<Set<string>>(() => new Set());
  const [pendingServers, setPendingServers] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormState>(emptyMcpForm);

  const hasMcp = Boolean(opts.loadMcp && opts.upsertMcp && opts.deleteMcp && opts.setMcpEnabled);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setToolsStatus("loading…");
    void (async () => {
      try {
        const list = await opts.load();
        if (cancelled) return;
        setTools(list);
        setToolsStatus(toolStatus(list));
      } catch {
        if (cancelled) return;
        setTools([]);
        setToolsStatus("error");
      }
    })();

    if (hasMcp) {
      setMcpStatusText("loading…");
      void (async () => {
        try {
          const list = await opts.loadMcp!();
          if (cancelled) return;
          setServers(list);
          setMcpStatusText(mcpStatus(list));
        } catch {
          if (cancelled) return;
          setServers([]);
          setMcpStatusText("error");
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [open, refreshToken, hasMcp, opts]);

  const resetForm = (): void => {
    setEditing(null);
    setForm(emptyMcpForm());
  };

  const patchTool = (name: string, patch: Partial<ManagedTool>): void => {
    setTools((prev) =>
      prev ? prev.map((tool) => (tool.name === name ? { ...tool, ...patch } : tool)) : prev,
    );
  };

  const updateTool = async (
    name: string,
    patch: Partial<ManagedTool>,
    request: () => Promise<ManagedTool[]>,
  ): Promise<void> => {
    patchTool(name, patch);
    setPendingTools((prev) => new Set(prev).add(name));
    try {
      const updated = await request();
      setTools(updated);
      setToolsStatus(toolStatus(updated));
      opts.onChange?.(updated);
    } catch {
      setToolsStatus("update failed");
      try {
        const current = await opts.load();
        setTools(current);
        setToolsStatus(toolStatus(current));
      } catch {
        /* keep the optimistic view */
      }
    } finally {
      setPendingTools((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const updateServer = async (
    name: string,
    patch: Partial<McpServerUi>,
    request: () => Promise<McpServerUi[] | undefined>,
  ): Promise<void> => {
    setServers((prev) =>
      prev ? prev.map((server) => (server.name === name ? { ...server, ...patch } : server)) : prev,
    );
    setPendingServers((prev) => new Set(prev).add(name));
    try {
      const updated = await request();
      if (updated) {
        setServers(updated);
        setMcpStatusText(mcpStatus(updated));
      }
    } catch {
      setMcpStatusText("update failed");
    } finally {
      setPendingServers((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const beginEdit = (server: McpServerUi): void => {
    setEditing(server.name);
    setForm(formFromServer(server));
    setMcpStatusText(`editing ${server.name} (secrets preserved unless retyped)`);
  };

  const saveServer = async (): Promise<void> => {
    const name = form.name.trim();
    const command = form.command.trim();
    const url = form.url.trim();
    if (!name) {
      setMcpStatusText("name required");
      return;
    }
    if (form.type === "stdio" && !command) {
      setMcpStatusText("command required");
      return;
    }
    if (form.type !== "stdio" && !url) {
      setMcpStatusText("URL required");
      return;
    }

    const env = form.env.trim() ? parseEnv(form.env) : undefined;
    const headers = form.headers.trim() ? parseHeaders(form.headers) : undefined;
    const payload: McpUpsert = {
      name,
      type: form.type,
      command,
      args: parseArgs(form.args),
      env,
      url,
      headers,
      enabled: form.enabled,
    };

    setSaving(true);
    setMcpStatusText("saving…");
    try {
      const updated = await opts.upsertMcp!(payload);
      setServers(updated);
      setMcpStatusText(mcpStatus(updated));
      resetForm();
    } catch {
      setMcpStatusText("save failed");
    } finally {
      setSaving(false);
    }
  };

  const deleteServer = async (server: McpServerUi): Promise<void> => {
    setPendingServers((prev) => new Set(prev).add(server.name));
    try {
      const updated = await opts.deleteMcp!(server.name);
      setServers(updated);
      setMcpStatusText(mcpStatus(updated));
      if (editing === server.name) resetForm();
    } catch {
      setMcpStatusText("delete failed");
    } finally {
      setPendingServers((prev) => {
        const next = new Set(prev);
        next.delete(server.name);
        return next;
      });
    }
  };

  const toolRow = (tool: ManagedTool) => {
    const pending = pendingTools.has(tool.name);
    return (
      <Row key={tool.name} class={tool.enabled ? "ui-tool-row" : "ui-tool-row off"}>
        <input
          type="checkbox"
          checked={tool.enabled}
          disabled={pending}
          title={tool.enabled ? "Disable" : "Enable"}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            void updateTool(tool.name, { enabled }, () => opts.setEnabled(tool.name, enabled));
          }}
        />
        <div class="ui-tool-info">
          <div class="ui-tool-name">{tool.name}</div>
          <div class="ui-tool-desc">{tool.description}</div>
          {tool.permissionSource === "session" ? (
            <div class="ui-tag">{SOURCE_LABEL.session}</div>
          ) : null}
        </div>
        <Select
          value={tool.permission}
          disabled={pending || tool.permissionSource === "session"}
          title={`Permission (${SOURCE_LABEL[tool.permissionSource] ?? tool.permissionSource})`}
          options={LEVELS.map((level) => ({ value: level, label: level }))}
          onChange={(event) => {
            const level = event.currentTarget.value as Permission;
            void updateTool(tool.name, { permission: level }, () =>
              opts.setPermission(tool.name, level),
            );
          }}
        />
      </Row>
    );
  };

  const serverRow = (server: McpServerUi) => {
    const pending = pendingServers.has(server.name);
    const secretKeys = [...server.envKeys, ...server.headerKeys];
    const detail =
      server.type === "stdio" ? [server.command, ...server.args].join(" ") : server.url;
    return (
      <Row key={server.name} class={server.enabled ? "ui-tool-row" : "ui-tool-row off"}>
        <input
          type="checkbox"
          checked={server.enabled}
          disabled={pending}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            void updateServer(server.name, { enabled }, () =>
              opts.setMcpEnabled!(server.name, enabled),
            );
          }}
        />
        <div class="ui-tool-info">
          <div class="ui-tool-name">{server.name}</div>
          <div class="ui-tool-desc">
            {server.type} · {detail}
            {secretKeys.length ? `  · secrets: ${secretKeys.join(", ")}` : ""}
          </div>
        </div>
        <Button onClick={() => beginEdit(server)}>Edit</Button>
        <Button onClick={() => void deleteServer(server)} disabled={pending}>
          Delete
        </Button>
      </Row>
    );
  };

  return (
    <Modal
      open={open}
      title="Tools"
      status={toolsStatus}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onRefresh}>Refresh</Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
      footer="Disabled tools are not offered to the agent. Permission changes here are global; the in-chat prompt only grants the current session."
    >
      <div class="ui-list">
        {tools === null ? (
          <Footer>Loading…</Footer>
        ) : tools.length === 0 ? (
          <Footer>No custom tools registered.</Footer>
        ) : (
          tools.map(toolRow)
        )}
      </div>

      {hasMcp ? (
        <>
          <SectionHead title="MCP servers" status={mcpStatusText} />
          <div class="ui-list">
            {servers === null ? (
              <Footer>Loading…</Footer>
            ) : servers.length === 0 ? (
              <Footer>No MCP servers configured.</Footer>
            ) : (
              servers.map(serverRow)
            )}
          </div>

          <div class="ui-mcp-form">
            <TextInput
              value={form.name}
              disabled={editing !== null}
              placeholder="name (e.g. gmail)"
              onInput={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
            <Select
              value={form.type}
              options={TRANSPORTS}
              onChange={(event) =>
                setForm({ ...form, type: event.currentTarget.value as McpTransportKind })
              }
            />
            {form.type === "stdio" ? (
              <div class="ui-mcp-fields">
                <TextInput
                  value={form.command}
                  placeholder="command (e.g. uvx)"
                  onInput={(event) => setForm({ ...form, command: event.currentTarget.value })}
                />
                <TextInput
                  value={form.args}
                  placeholder="args, space-separated (e.g. mcp-server-gmail)"
                  onInput={(event) => setForm({ ...form, args: event.currentTarget.value })}
                />
                <TextArea
                  value={form.env}
                  placeholder="env, one KEY=VALUE per line (optional)"
                  onInput={(event) => setForm({ ...form, env: event.currentTarget.value })}
                />
              </div>
            ) : (
              <div class="ui-mcp-fields">
                <TextInput
                  value={form.url}
                  placeholder="URL (e.g. http://127.0.0.1:3000/mcp)"
                  onInput={(event) => setForm({ ...form, url: event.currentTarget.value })}
                />
                <TextArea
                  value={form.headers}
                  placeholder={
                    "headers, one Name: Value per line (optional)\ne.g. Authorization: Bearer YOUR_TOKEN"
                  }
                  onInput={(event) => setForm({ ...form, headers: event.currentTarget.value })}
                />
              </div>
            )}
            <div class="ui-mcp-actions">
              <Checkbox
                label="enabled"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })}
              />
              <Button onClick={() => void saveServer()} disabled={saving}>
                Save
              </Button>
              <Button
                onClick={() => {
                  resetForm();
                  setMcpStatusText("");
                }}
              >
                New
              </Button>
            </div>
          </div>

          <Footer>
            stdio servers run as local processes with your privileges; http/sse servers are
            contacted over the network with the headers you provide. Only add servers you trust.
            Secret values are stored locally and never shown here.
          </Footer>
        </>
      ) : null}
    </Modal>
  );
}

export function mountToolsUi(opts: ToolsUiOptions): ToolsUi {
  let open = false;
  let refreshToken = 0;
  let island: Island<ToolsPanelProps>;

  const close = (): void => {
    open = false;
    paint();
  };
  const refresh = (): void => {
    refreshToken += 1;
    paint();
  };
  const paint = (): void => {
    island.update({ open, refreshToken, onClose: close, onRefresh: refresh, opts });
  };
  const openPanel = (): void => {
    open = true;
    refreshToken += 1;
    attachToBody(island.host);
    paint();
  };
  const toggle = (): void => {
    if (open) close();
    else openPanel();
  };

  island = mountIsland<ToolsPanelProps>({
    marker: "data-duckai-ext-modal-tools",
    component: ToolsPanel,
    props: { open, refreshToken, onClose: close, onRefresh: refresh, opts },
    styles: STYLES,
  });

  return {
    open: openPanel,
    close,
    toggle,
    isOpen: () => open,
    refresh,
    destroy: () => island.destroy(),
  };
}
