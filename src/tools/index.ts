import type { Tool } from "../harness";
import { execTools } from "./exec";
import { fsTools } from "./fs";
import { mcpTools } from "./mcp";
import { memoryTools } from "./memory";
import { resultTools } from "./results";
import { searchTools } from "./search";
import { systemTools } from "./system";
import { todoTools } from "./todo";

export const coreTools: Tool[] = [
  ...fsTools,
  ...searchTools,
  ...execTools,
  ...systemTools,
  ...todoTools,
  ...memoryTools,
  ...mcpTools,
  ...resultTools,
];

export { execTools, fsTools, mcpTools, memoryTools, resultTools, searchTools, systemTools, todoTools };
