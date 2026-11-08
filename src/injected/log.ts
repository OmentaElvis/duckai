type Level = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: Level;
  msg: string;
  data?: unknown;
}

const HISTORY_MAX = 500;
const history: LogEntry[] = [];
const forward: ((e: LogEntry) => void)[] = [];

function emit(level: Level, msg: string, data?: unknown) {
  const entry: LogEntry = { t: Date.now(), level, msg, data };
  history.push(entry);
  if (history.length > HISTORY_MAX) history.shift();
  const fn = console[level] ?? console.log;
  fn.call(console, `%c[duck-ext] ${msg}`, "color:#d4a017;font-weight:bold", data ?? "");
  for (const f of forward) {
    try {
      f(entry);
    } catch {
      /* forwarders must never break logging */
    }
  }
}

export const log = {
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  error: (msg: string, data?: unknown) => emit("error", msg, data),
  history,
  onEntry(fn: (e: LogEntry) => void) {
    forward.push(fn);
  },
};
