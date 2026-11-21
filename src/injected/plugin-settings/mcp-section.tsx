/**
 * MCP section for the Plugin settings dialog.
 *
 * Lists configured servers and provides an inline add/edit form. Secret values
 * never travel to the page: the host only sends key names, and editing keeps
 * existing env/header values unless the user retypes them.
 */
import { useEffect, useState } from "preact/hooks";
import {
  Button,
  Footer,
  Row,
  Select,
  Switch,
  TextArea,
  TextInput,
  type SelectOption,
} from "../ui/components";
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
} from "../tools-model";
import type { McpSettingsOptions } from "./types";

const TRANSPORTS: SelectOption[] = [
  { value: "stdio", label: "stdio (local command)" },
  { value: "http", label: "http (Streamable HTTP)" },
  { value: "sse", label: "sse (legacy HTTP+SSE)" },
];

export interface McpSectionProps {
  options: McpSettingsOptions;
}

export function McpSection({ options }: McpSectionProps) {
  const [servers, setServers] = useState<McpServerUi[] | null>(null);
  const [listStatus, setListStatus] = useState("loading…");
  const [formStatus, setFormStatus] = useState("");
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormState>(emptyMcpForm);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setListStatus("loading…");
    void (async () => {
      try {
        const list = await options.load();
        if (cancelled) return;
        setServers(list);
        setListStatus(mcpStatus(list));
      } catch {
        if (cancelled) return;
        setServers([]);
        setListStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [options, reloadToken]);

  const resetForm = (): void => {
    setEditing(null);
    setForm(emptyMcpForm());
    setFormStatus("");
  };

  const updateServer = async (
    name: string,
    patch: Partial<McpServerUi>,
    request: () => Promise<McpServerUi[]>,
  ): Promise<void> => {
    setServers((prev) =>
      prev ? prev.map((server) => (server.name === name ? { ...server, ...patch } : server)) : prev,
    );
    setPending((prev) => new Set(prev).add(name));
    try {
      const updated = await request();
      setServers(updated);
      setListStatus(mcpStatus(updated));
    } catch {
      setListStatus("update failed");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const beginEdit = (server: McpServerUi): void => {
    setEditing(server.name);
    setForm(formFromServer(server));
    setFormStatus(`Editing ${server.name}. Secrets are preserved unless retyped.`);
  };

  const saveServer = async (): Promise<void> => {
    const name = form.name.trim();
    const command = form.command.trim();
    const url = form.url.trim();
    if (!name) {
      setFormStatus("name required");
      return;
    }
    if (form.type === "stdio" && !command) {
      setFormStatus("command required");
      return;
    }
    if (form.type !== "stdio" && !url) {
      setFormStatus("URL required");
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
    setFormStatus("saving…");
    try {
      const updated = await options.upsert(payload);
      setServers(updated);
      setListStatus(mcpStatus(updated));
      resetForm();
    } catch {
      setFormStatus("save failed");
    } finally {
      setSaving(false);
    }
  };

  const deleteServer = async (server: McpServerUi): Promise<void> => {
    setPending((prev) => new Set(prev).add(server.name));
    try {
      const updated = await options.remove(server.name);
      setServers(updated);
      setListStatus(mcpStatus(updated));
      if (editing === server.name) resetForm();
    } catch {
      setListStatus("delete failed");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(server.name);
        return next;
      });
    }
  };

  const serverRow = (server: McpServerUi) => {
    const isPending = pending.has(server.name);
    const secretKeys = [...server.envKeys, ...server.headerKeys];
    const detail =
      server.type === "stdio" ? [server.command, ...server.args].join(" ") : server.url;
    return (
      <Row key={server.name} class={server.enabled ? "ps-tool-row" : "ps-tool-row off"}>
        <Switch
          checked={server.enabled}
          disabled={isPending}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            void updateServer(server.name, { enabled }, () =>
              options.setEnabled(server.name, enabled),
            );
          }}
        />
        <div class="ps-tool-info">
          <div class="ps-tool-name">{server.name}</div>
          <div class="ps-tool-desc">
            {server.type} · {detail}
            {secretKeys.length ? `  · secrets: ${secretKeys.join(", ")}` : ""}
          </div>
        </div>
        <Button onClick={() => beginEdit(server)}>Edit</Button>
        <Button variant="danger" onClick={() => void deleteServer(server)} disabled={isPending}>
          Delete
        </Button>
      </Row>
    );
  };

  return (
    <>
      <div class="ps-pane-head">
        <div class="ps-pane-heading">
          <div class="ps-pane-title">MCP servers</div>
          <div class="ps-pane-desc">
            Connect local stdio processes or remote HTTP/SSE services.
          </div>
        </div>
        <span class="ps-pane-status">{listStatus}</span>
        <Button onClick={() => setReloadToken((token) => token + 1)}>Refresh</Button>
      </div>

      <div class="ps-scroll">
        {servers === null ? (
          <div class="ps-empty">Loading…</div>
        ) : servers.length === 0 ? (
          <div class="ps-empty">No MCP servers configured.</div>
        ) : (
          <div class="ui-list">{servers.map(serverRow)}</div>
        )}

        <div class="ps-form-head">
          <span class="ps-form-title">{editing ? `Edit ${editing}` : "Add server"}</span>
          {formStatus ? <span class="ps-form-status">{formStatus}</span> : null}
        </div>

        <div class="ps-mcp-form">
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
            <div class="ps-mcp-fields">
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
            <div class="ps-mcp-fields">
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
          <div class="ps-mcp-actions">
            <Switch
              label="enabled"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })}
            />
            <Button variant="primary" onClick={() => void saveServer()} disabled={saving}>
              Save
            </Button>
            <Button onClick={resetForm} disabled={saving}>
              {editing ? "Cancel" : "Clear"}
            </Button>
          </div>
        </div>
      </div>

      <Footer>
        stdio servers run as local processes with your privileges; http/sse servers are contacted
        over the network with the headers you provide. Only add servers you trust. Secret values
        are stored locally and never shown here.
      </Footer>
    </>
  );
}
