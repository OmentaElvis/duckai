import type { Tool, ToolManifestEntry } from "../harness";

/**
 * Factory that creates the `tool_help` meta-tool.
 *
 * A factory is used instead of a bare export so the tool can close over the
 * live manifest at registration time — the manifest is only fully assembled
 * after all tools have been registered, so we pass a getter rather than a
 * snapshot.
 *
 * Usage:
 *   registerTool(makeToolHelpTool(() => listManifest()));
 */
export function makeToolHelpTool(getManifest: () => ToolManifestEntry[]): Tool {
  return {
    name: "tool_help",
    permission: "allow",
    description:
      "Return the full parameter schema for a named tool, or list all available tool names. Call this before using any tool you're unsure about.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tool name to inspect. Omit to list all available tool names.",
        },
      },
      required: [],
    },
    execute: (args) => {
      const manifest = getManifest();
      const toolName = typeof args.name === "string" ? args.name.trim() : "";

      if (!toolName) {
        // No name → return the compact name list as a refresher
        return { tools: manifest.map((t) => t.name) };
      }

      const entry = manifest.find((t) => t.name === toolName);
      if (!entry) {
        const available = manifest.map((t) => t.name).join(", ");
        return {
          error: `Unknown tool: "${toolName}". Available tools: ${available}`,
        };
      }

      return {
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
      };
    },
  };
}
