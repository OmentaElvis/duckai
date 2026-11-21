/**
 * Tools section for the Plugin settings dialog.
 *
 * Enabling/disabling and the explicit permission selector persist on the Bun
 * host (global). In-conversation "Always allow" grants are session-scoped and
 * surface here as a read-only, session-sourced permission.
 */
import { useEffect, useState } from "preact/hooks";
import type { ManagedTool, Permission } from "../../protocol";
import { Button, Footer, Row, Select, Switch } from "../ui/components";
import { toolStatus } from "../tools-model";
import type { ToolsSettingsOptions } from "./types";

const LEVELS: Permission[] = ["ask", "allow", "deny"];
const SOURCE_LABEL: Record<string, string> = {
  session: "allowed for this session",
  policy: "set by you",
  default: "tool default",
};

export interface ToolsSectionProps {
  options: ToolsSettingsOptions;
}

export function ToolsSection({ options }: ToolsSectionProps) {
  const [tools, setTools] = useState<ManagedTool[] | null>(null);
  const [status, setStatus] = useState("loading…");
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading…");
    void (async () => {
      try {
        const list = await options.load();
        if (cancelled) return;
        setTools(list);
        setStatus(toolStatus(list));
      } catch {
        if (cancelled) return;
        setTools([]);
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [options, reloadToken]);

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
    setPending((prev) => new Set(prev).add(name));
    try {
      const updated = await request();
      setTools(updated);
      setStatus(toolStatus(updated));
      options.onChange?.(updated);
    } catch {
      setStatus("update failed");
      try {
        const current = await options.load();
        setTools(current);
        setStatus(toolStatus(current));
      } catch {
        /* keep the optimistic view */
      }
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const toolRow = (tool: ManagedTool) => {
    const isPending = pending.has(tool.name);
    return (
      <Row key={tool.name} class={tool.enabled ? "ps-tool-row" : "ps-tool-row off"}>
        <Switch
          checked={tool.enabled}
          disabled={isPending}
          title={tool.enabled ? "Disable" : "Enable"}
          aria-label={`${tool.enabled ? "Disable" : "Enable"} ${tool.name}`}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            void updateTool(tool.name, { enabled }, () => options.setEnabled(tool.name, enabled));
          }}
        />
        <div class="ps-tool-info">
          <div class="ps-tool-name">{tool.name}</div>
          <div class="ps-tool-desc">{tool.description}</div>
          {tool.permissionSource === "session" ? (
            <div class="ps-tool-tag">{SOURCE_LABEL.session}</div>
          ) : null}
        </div>
        <Select
          value={tool.permission}
          disabled={isPending || tool.permissionSource === "session"}
          title={`Permission (${SOURCE_LABEL[tool.permissionSource] ?? tool.permissionSource})`}
          options={LEVELS.map((level) => ({ value: level, label: level }))}
          onChange={(event) => {
            const level = event.currentTarget.value as Permission;
            void updateTool(tool.name, { permission: level }, () =>
              options.setPermission(tool.name, level),
            );
          }}
        />
      </Row>
    );
  };

  return (
    <>
      <div class="ps-pane-head">
        <div class="ps-pane-heading">
          <div class="ps-pane-title">Tools</div>
          <div class="ps-pane-desc">Enable tools and set their global permission level.</div>
        </div>
        <span class="ps-pane-status">{status}</span>
        <Button onClick={() => setReloadToken((token) => token + 1)}>Refresh</Button>
      </div>

      <div class="ps-scroll">
        {tools === null ? (
          <div class="ps-empty">Loading…</div>
        ) : tools.length === 0 ? (
          <div class="ps-empty">No custom tools registered.</div>
        ) : (
          <div class="ui-list">{tools.map(toolRow)}</div>
        )}
      </div>

      <Footer>
        Disabled tools are not offered to the agent. Permission changes here are global; the
        in-chat prompt only grants the current session.
      </Footer>
    </>
  );
}
