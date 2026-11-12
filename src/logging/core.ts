/**
 * Environment-agnostic logging core shared by the Bun host and the injected
 * page script.
 *
 * This module must stay free of Node and DOM APIs so it can be bundled into
 * both runtimes. Environment-specific sinks live in:
 *   - ./host.ts        (Bun host: ANSI colour when the terminal supports it)
 *   - ../injected/log.ts (page: plain text for the devtools/WebKit console)
 *
 * Every entry carries a scope ("duckai:mcp", "page:fetch", …) so the two sides
 * render a single, consistent timeline.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  /** Epoch milliseconds when the entry was created. */
  t: number;
  level: LogLevel;
  /** Source of the entry, e.g. "duckai:mcp" or "page:fetch". */
  scope: string;
  msg: string;
  data?: unknown;
}

export type LogSink = (entry: LogEntry) => void;
export type LogForwarder = (entry: LogEntry) => void;

export interface Logger {
  readonly scope: string;
  /** Minimum level currently emitted. */
  readonly level: LogLevel;
  /** Recent entries (newest last), shared by this logger and its children. */
  readonly history: readonly LogEntry[];
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Derive a logger whose scope is `scope:child`. */
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
  /** Subscribe to every accepted entry. Returns an unsubscribe function. */
  onEntry(fn: LogForwarder): () => void;
  /** Write an already-formed entry (e.g. forwarded from the other runtime). */
  ingest(entry: LogEntry): void;
}

export interface LoggerOptions {
  scope: string;
  sink: LogSink;
  minLevel?: LogLevel;
  historyMax?: number;
}

interface Shared {
  sink: LogSink;
  minLevel: LogLevel;
  history: LogEntry[];
  historyMax: number;
  forwarders: Set<LogForwarder>;
}

function record(shared: Shared, entry: LogEntry): void {
  shared.history.push(entry);
  if (shared.history.length > shared.historyMax) {
    shared.history.splice(0, shared.history.length - shared.historyMax);
  }
}

function dispatch(shared: Shared, entry: LogEntry): void {
  if (WEIGHT[entry.level] < WEIGHT[shared.minLevel]) return;
  record(shared, entry);
  try {
    shared.sink(entry);
  } catch {
    /* a broken sink must never break logging */
  }
  for (const fn of shared.forwarders) {
    try {
      fn(entry);
    } catch {
      /* a broken forwarder must never break logging */
    }
  }
}

function make(shared: Shared, scope: string): Logger {
  const emit = (level: LogLevel, msg: string, data?: unknown): void => {
    const entry: LogEntry = { t: Date.now(), level, scope, msg };
    if (data !== undefined) entry.data = data;
    dispatch(shared, entry);
  };

  return {
    scope,
    get level() {
      return shared.minLevel;
    },
    get history() {
      return shared.history;
    },
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    child: (sub) => make(shared, sub ? `${scope}:${sub}` : scope),
    setLevel: (level) => {
      shared.minLevel = level;
    },
    onEntry(fn) {
      shared.forwarders.add(fn);
      return () => shared.forwarders.delete(fn);
    },
    ingest(entry) {
      dispatch(shared, entry);
    },
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const shared: Shared = {
    sink: options.sink,
    minLevel: options.minLevel ?? "info",
    history: [],
    historyMax: options.historyMax ?? 500,
    forwarders: new Set(),
  };
  return make(shared, options.scope);
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const v = value?.trim().toLowerCase();
  return isLogLevel(v) ? v : undefined;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local wall-clock time as `HH:MM:SS.mmm`. */
export function formatTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Plain-text prefix used by both runtimes: `HH:MM:SS.mmm LEVEL scope`. */
export function formatPrefix(entry: LogEntry): string {
  return `${formatTime(entry.t)} ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}`;
}

const ANSI_LEVEL: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const ANSI_DIM = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

/** ANSI-coloured prefix for terminals that support it. */
export function formatAnsi(entry: LogEntry): string {
  const level = `${ANSI_LEVEL[entry.level]}${entry.level.toUpperCase().padEnd(5)}${ANSI_RESET}`;
  return `${ANSI_DIM}${formatTime(entry.t)}${ANSI_RESET} ${level} ${ANSI_DIM}${entry.scope}${ANSI_RESET}`;
}
