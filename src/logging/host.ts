/**
 * Bun-side logging sink.
 *
 * Writes the shared plain-text prefix (or ANSI colour when stdout is a TTY) to
 * the matching console method. Use `log.child("scope")` in subsystems so the
 * terminal timeline is easy to scan.
 */
import {
  createLogger,
  formatAnsi,
  formatPrefix,
  parseLogLevel,
  type LogEntry,
} from "./core";

/** Whether the terminal can render ANSI escapes (respects NO_COLOR/FORCE_COLOR). */
export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined) return forced !== "" && forced !== "0" && forced !== "false";
  if (process.env.TERM === "dumb") return false;
  return Boolean((process.stdout as { isTTY?: boolean }).isTTY);
}

const color = supportsColor();

function sink(entry: LogEntry): void {
  const prefix = color ? formatAnsi(entry) : formatPrefix(entry);
  const line = `${prefix} | ${entry.msg}`;
  const write = console[entry.level] ?? console.log;
  if (entry.data === undefined) write(line);
  else write(line, entry.data);
}

export const log = createLogger({
  scope: "duckai",
  sink,
  minLevel: parseLogLevel(process.env.DUCKAI_LOG_LEVEL) ?? "info",
});

export type { LogEntry, LogLevel, Logger } from "./core";
