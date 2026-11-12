/**
 * Page-side logger.
 *
 * Deliberately plain text: no `%c` styling or CSS strings, because the WebKit
 * console can forward these verbatim to the app's terminal. Entries use the
 * same `HH:MM:SS.mmm LEVEL scope` prefix as the Bun host; index.ts forwards
 * info/warn/error entries over the bridge so both runtimes share one timeline.
 */
import { createLogger, formatPrefix, type LogEntry } from "../logging/core";

export type { LogEntry } from "../logging/core";

function sink(entry: LogEntry): void {
  const line = `${formatPrefix(entry)} | ${entry.msg}`;
  const write = console[entry.level] ?? console.log;
  if (entry.data === undefined) write(line);
  else write(line, entry.data);
}

export const log = createLogger({
  scope: "page",
  sink,
  minLevel: "debug",
});
