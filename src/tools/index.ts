import type { Tool } from "../harness";
import { execTools } from "./exec";
import { fsTools } from "./fs";
import { searchTools } from "./search";
import { systemTools } from "./system";
import { todoTools } from "./todo";

export const coreTools: Tool[] = [
  ...fsTools,
  ...searchTools,
  ...execTools,
  ...systemTools,
  ...todoTools,
];

export { execTools, fsTools, searchTools, systemTools, todoTools };
