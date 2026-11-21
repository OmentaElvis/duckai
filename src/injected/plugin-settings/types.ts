import type { ManagedTool, Permission } from "../../protocol";
import type { McpServerUi, McpUpsert } from "../tools-model";

/** Stable ids for the sections shown in the settings sidebar. */
export type SettingsSectionId = "health" | "tools" | "mcp";

export interface ToolsSettingsOptions {
  load: () => Promise<ManagedTool[]>;
  /** Persist an enabled/disabled state and return the refreshed list. */
  setEnabled: (name: string, enabled: boolean) => Promise<ManagedTool[]>;
  /** Persist an explicit (global) permission and return the refreshed list. */
  setPermission: (name: string, level: Permission) => Promise<ManagedTool[]>;
  /** Called with the refreshed list after a successful change. */
  onChange?: (tools: ManagedTool[]) => void;
}

export interface McpSettingsOptions {
  load: () => Promise<McpServerUi[]>;
  upsert: (server: McpUpsert) => Promise<McpServerUi[]>;
  remove: (name: string) => Promise<McpServerUi[]>;
  setEnabled: (name: string, enabled: boolean) => Promise<McpServerUi[]>;
}

export interface PluginSettingsOptions {
  /** Invoked when the user clicks "Run" in the health section. */
  onRunHealth: () => void;
  tools: ToolsSettingsOptions;
  /** Omit to hide the MCP section entirely. */
  mcp?: McpSettingsOptions;
}
