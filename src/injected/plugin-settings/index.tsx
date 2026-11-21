/**
 * Plugin settings dialog.
 *
 * One Preact island with a sidebar and a pane per concern (health, tools, MCP).
 * New settings belong here as another section: add an id, a nav entry and a
 * pane, instead of mounting another top-level dialog and menu item.
 */
import type { ComponentChildren } from "preact";
import type { HealthReport } from "../../health-report";
import { attachToBody, mountIsland, type Island } from "../ui/mount";
import { CloseButton, Modal } from "../ui/components";
import { HealthDot, HealthSection } from "./health-section";
import { ToolsSection } from "./tools-section";
import { McpSection } from "./mcp-section";
import SETTINGS_STYLES from "./plugin-settings.css";
import type { PluginSettingsOptions, SettingsSectionId } from "./types";

export type {
  McpSettingsOptions,
  PluginSettingsOptions,
  SettingsSectionId,
  ToolsSettingsOptions,
} from "./types";

export interface PluginSettingsUi {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Replace the health report (also clears the running state). */
  updateHealth(report: HealthReport): void;
  /** Show the health section as busy while probes run. */
  setHealthRunning(): void;
  destroy(): void;
}

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: ComponentChildren;
  render: () => ComponentChildren;
}

function HealthIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 8h2.2l1.5-4 2.6 8 1.6-4h3.1" />
    </svg>
  );
}

function ToolsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </svg>
  );
}

function McpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2v3.5M10 2v3.5M4 5.5h8v2a4 4 0 0 1-8 0v-2zM8 11.5V14" />
    </svg>
  );
}

interface PanelProps {
  open: boolean;
  active: SettingsSectionId;
  report: HealthReport | null;
  running: boolean;
  opts: PluginSettingsOptions;
  onSelect: (id: SettingsSectionId) => void;
  onRunHealth: () => void;
  onClose: () => void;
}

function PluginSettingsPanel({
  open,
  active,
  report,
  running,
  opts,
  onSelect,
  onRunHealth,
  onClose,
}: PanelProps) {
  const mcp = opts.mcp;
  const sections: SectionDef[] = [
    {
      id: "health",
      label: "Health check",
      icon: <HealthIcon />,
      render: () => <HealthSection report={report} running={running} onRun={onRunHealth} />,
    },
    {
      id: "tools",
      label: "Tools",
      icon: <ToolsIcon />,
      render: () => <ToolsSection options={opts.tools} />,
    },
    ...(mcp
      ? [
          {
            id: "mcp" as const,
            label: "MCP servers",
            icon: <McpIcon />,
            render: () => <McpSection options={mcp} />,
          },
        ]
      : []),
  ];

  return (
    <Modal
      open={open}
      title="Plugin settings"
      onClose={onClose}
      actions={<CloseButton onClick={onClose} />}
      sidebar={
        <nav class="ps-nav" aria-label="Plugin settings sections">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              class={active === section.id ? "ps-nav-item active" : "ps-nav-item"}
              aria-current={active === section.id ? "page" : undefined}
              onClick={() => onSelect(section.id)}
            >
              <span class="ps-nav-icon">{section.icon}</span>
              <span class="ps-nav-label">{section.label}</span>
              {section.id === "health" && report ? (
                <span class="ps-nav-dot">
                  <HealthDot status={report.status} />
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      }
    >
      <div class="ps-body">
        {sections.map((section) => (
          <div key={section.id} class="ps-pane" hidden={active !== section.id}>
            {section.render()}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function mountPluginSettings(opts: PluginSettingsOptions): PluginSettingsUi {
  let open = false;
  let active: SettingsSectionId = "health";
  let report: HealthReport | null = null;
  let running = false;
  let island: Island<PanelProps>;

  const onSelect = (id: SettingsSectionId): void => {
    active = id;
    paint();
  };

  const close = (): void => {
    open = false;
    paint();
  };

  const paint = (): void => {
    island.update({
      open,
      active,
      report,
      running,
      opts,
      onSelect,
      onRunHealth: opts.onRunHealth,
      onClose: close,
    });
  };

  const openPanel = (): void => {
    // The host config can change between opens; never leave the dialog on a
    // section that is no longer available.
    if (active === "mcp" && !opts.mcp) active = "health";
    open = true;
    attachToBody(island.host);
    paint();
  };

  const toggle = (): void => {
    if (open) close();
    else openPanel();
  };

  island = mountIsland<PanelProps>({
    marker: "data-duckai-ext-modal-settings",
    component: PluginSettingsPanel,
    props: {
      open,
      active,
      report,
      running,
      opts,
      onSelect,
      onRunHealth: opts.onRunHealth,
      onClose: close,
    },
    styles: SETTINGS_STYLES,
  });

  return {
    open: openPanel,
    close,
    toggle,
    isOpen: () => open,
    updateHealth(next) {
      report = next;
      running = false;
      paint();
    },
    setHealthRunning() {
      running = true;
      paint();
    },
    destroy: () => island.destroy(),
  };
}
