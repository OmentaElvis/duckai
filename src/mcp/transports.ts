import { log } from "../logging/host";
import type { McpServerConfig } from "./client";

// MCP transports.
//
// The harness only needs `initialize`, `tools/list`, `tools/call` and the
// `notifications/tools/list_changed` push. Three wire formats are supported:
//
// - stdio: one long-lived child process, newline-delimited JSON-RPC.
// - http:  the Streamable HTTP transport (single endpoint, POST per message,
//          JSON or SSE responses, optional `Mcp-Session-Id` header). Servers
//          can push notifications over a long-lived GET SSE stream.
// - sse:   the older HTTP+SSE transport (GET stream announces a POST endpoint,
//          responses arrive over the stream).
//
// The JSON-RPC bookkeeping (ids, timeouts, error unwrapping) lives here so the
// client in ./client.ts stays transport-agnostic.

const MAX_ERROR_BODY = 400;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export type NotificationHandler = (message: JsonRpcMessage) => void;

/** Raised when a Streamable HTTP session has expired and must be re-initialized. */
export class McpSessionExpiredError extends Error {
  constructor() {
    super("mcp session expired");
    this.name = "McpSessionExpiredError";
  }
}

export interface McpTransport {
  /** Protocol version offered in the `initialize` request. */
  readonly initialProtocolVersion: string;
  /** How long a `tools/list` response stays valid without a push notification. */
  readonly toolListTtlMs: number;
  /** Resolve once messages can be sent (for SSE: once the POST endpoint is known). */
  start(): Promise<void>;
  request(message: JsonRpcMessage, timeoutMs: number): Promise<unknown>;
  notify(message: JsonRpcMessage, timeoutMs: number): Promise<void>;
  /** Called after `initialize` succeeds with the negotiated protocol version. */
  initialized(version: string): void;
  close(): void;
}

/** Minimal SSE frame reader shared by the HTTP and legacy SSE transports. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let event = "";
  let id: string | undefined;

  const flush = (): { event: string; data: string; id?: string } | null => {
    if (!dataLines.length) {
      event = "";
      id = undefined;
      return null;
    }
    const frame = { event: event || "message", data: dataLines.join("\n"), id };
    dataLines = [];
    event = "";
    id = undefined;
    return frame;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") dataLines.push(value);
        else if (field === "event") event = value;
        else if (field === "id") id = value;
      }
    }
    const frame = flush();
    if (frame) yield frame;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
    reader.releaseLock();
  }
}

function parseJson(text: string, context: string): JsonRpcMessage {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as JsonRpcMessage;
  } catch {
    /* handled below */
  }
  throw new Error(`mcp ${context}: invalid JSON response`);
}

function unwrap(message: JsonRpcMessage): unknown {
  if (message.error) throw new Error(String(message.error.message ?? "mcp error"));
  return message.result;
}

function idMatches(candidate: JsonRpcMessage, id: number | string | undefined): boolean {
  return id !== undefined && candidate.id !== undefined && String(candidate.id) === String(id);
}

function truncateBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_ERROR_BODY ? `${trimmed.slice(0, MAX_ERROR_BODY)}…` : trimmed;
}

/** Turn an unsuccessful HTTP response into a readable error. */
async function httpError(transport: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = truncateBody(await res.text());
  } catch {
    /* body already consumed / unreadable */
  }
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  const hint =
    res.status === 401 || res.status === 403
      ? " (check the server's auth token / headers)"
      : "";
  return new Error(`mcp ${transport} ${status}${hint}${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StdioTransport implements McpTransport {
  readonly initialProtocolVersion = "2024-11-05";
  readonly toolListTtlMs = Number.POSITIVE_INFINITY;

  private proc: ReturnType<typeof Bun.spawn>;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private cfg: McpServerConfig,
    private onNotification: NotificationHandler,
    private onClose: () => void,
  ) {
    this.proc = Bun.spawn([cfg.command, ...cfg.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...cfg.env },
      // GUI executable on Windows: don't open a console for the MCP server.
      windowsHide: true,
    });
    this.drainStderr();
    this.readLoop();
    this.proc.exited.then(() => this.fail(new Error("mcp server exited")));
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose();
  }

  private async drainStderr(): Promise<void> {
    try {
      const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const line = decoder.decode(value, { stream: true }).trim();
        if (line) log.child("mcp").debug("stderr", line.slice(0, 200));
      }
    } catch {
      /* process ended */
    }
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            continue;
          }
          if (typeof message.id === "number" && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            try {
              pending.resolve(unwrap(message));
            } catch (error) {
              pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
          } else if (message.method && message.id === undefined) {
            this.onNotification(message);
          }
        }
      }
    } catch {
      /* process ended */
    }
  }

  private write(message: JsonRpcMessage): void {
    (this.proc.stdin as unknown as { write: (text: string) => void }).write(
      `${JSON.stringify(message)}\n`,
    );
  }

  request(message: JsonRpcMessage, timeoutMs: number): Promise<unknown> {
    const id = Number(message.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("mcp timeout"));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(message: JsonRpcMessage): Promise<void> {
    this.write(message);
  }

  initialized(): void {
    /* stdio servers negotiate the version in the initialize result only */
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("mcp client closed"));
    }
    this.pending.clear();
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP (POST + optional GET SSE listener)
// ---------------------------------------------------------------------------

export class HttpTransport implements McpTransport {
  readonly initialProtocolVersion = "2025-06-18";
  readonly toolListTtlMs = 30_000;

  private sessionId: string | null = null;
  private protocolVersion = "";
  private closed = false;
  private listener: AbortController | null = null;
  private listenerUnsupported = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private cfg: McpServerConfig,
    private onNotification: NotificationHandler,
    private onClose: () => void,
  ) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  initialized(version: string): void {
    this.protocolVersion = version || this.initialProtocolVersion;
    // Servers may push `tools/list_changed` over GET. Best-effort: plenty of
    // deployments only implement POST and answer 405 here.
    void this.openListener();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...this.cfg.headers, ...extra };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return headers;
  }

  private async post(
    message: JsonRpcMessage,
    timeoutMs: number,
    accept: string,
  ): Promise<Response> {
    const hadSession = this.sessionId !== null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await fetch(this.cfg.url, {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/json",
          Accept: accept,
        }),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const session = res.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      if (res.status === 404 && hadSession) {
        this.sessionId = null;
        throw new McpSessionExpiredError();
      }
      if (!res.ok) throw await httpError("http", res);
      return res;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("mcp timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.method && message.id === undefined) {
      this.onNotification(message);
      return;
    }
    if (message.method && message.id !== undefined) {
      // Server-initiated request (sampling, roots, ping…). Tools-only client:
      // ignore it rather than replying with a bogus result.
      log.child("mcp").debug("ignoring server request", message.method);
    }
  }

  async request(message: JsonRpcMessage, timeoutMs: number): Promise<unknown> {
    const res = await this.post(message, timeoutMs, "application/json, text/event-stream");
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.toLowerCase().includes("text/event-stream")) {
      if (!res.body) throw new Error("mcp http: empty response");
      for await (const frame of sseEvents(res.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const messages = Array.isArray(parsed) ? (parsed as JsonRpcMessage[]) : [parsed as JsonRpcMessage];
        for (const candidate of messages) {
          if (!candidate || typeof candidate !== "object") continue;
          if (idMatches(candidate, message.id)) return unwrap(candidate);
          this.dispatch(candidate);
        }
      }
      throw new Error("mcp http: stream ended before the response arrived");
    }

    const text = await res.text();
    const parsed = parseJson(text, "http");
    if (Array.isArray(parsed)) {
      const match = (parsed as unknown as JsonRpcMessage[]).find((candidate) =>
        idMatches(candidate, message.id),
      );
      if (!match) throw new Error("mcp http: response id mismatch");
      return unwrap(match);
    }
    if (!idMatches(parsed, message.id)) throw new Error("mcp http: response id mismatch");
    return unwrap(parsed);
  }

  async notify(message: JsonRpcMessage, timeoutMs: number): Promise<void> {
    const res = await this.post(message, timeoutMs, "application/json, text/event-stream");
    try {
      await res.body?.cancel();
    } catch {
      /* notifications have no useful body */
    }
  }

  private async openListener(): Promise<void> {
    if (this.closed || this.listenerUnsupported || this.listener) return;
    const controller = new AbortController();
    this.listener = controller;
    try {
      const res = await fetch(this.cfg.url, {
        method: "GET",
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: controller.signal,
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.toLowerCase().includes("text/event-stream") || !res.body) {
        this.listenerUnsupported = true;
        log.child("mcp").debug("http server push unavailable", String(res.status));
        return;
      }
      for await (const frame of sseEvents(res.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const messages = Array.isArray(parsed) ? (parsed as JsonRpcMessage[]) : [parsed as JsonRpcMessage];
        for (const message of messages) {
          if (message && typeof message === "object") this.dispatch(message);
        }
      }
    } catch (error) {
      if (!this.closed) log.child("mcp").debug("http push stream closed", String(error));
    } finally {
      if (this.listener === controller) this.listener = null;
      if (!this.closed && !this.listenerUnsupported) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openListener();
    }, 2_000);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listener?.abort();
    this.listener = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sessionId) {
      const headers = this.headers();
      const sessionId = this.sessionId;
      this.sessionId = null;
      headers["Mcp-Session-Id"] = sessionId;
      void fetch(this.cfg.url, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(2_000),
      }).catch(() => {
        /* best-effort session teardown */
      });
    }
    this.onClose();
  }
}

// ---------------------------------------------------------------------------
// Legacy HTTP+SSE
// ---------------------------------------------------------------------------

interface SsePending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SseTransport implements McpTransport {
  readonly initialProtocolVersion = "2024-11-05";
  readonly toolListTtlMs = 30_000;

  private endpoint: string | null = null;
  private pending = new Map<number, SsePending>();
  private controller = new AbortController();
  private closed = false;
  private started = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  constructor(
    private cfg: McpServerConfig,
    private onNotification: NotificationHandler,
    private onClose: () => void,
  ) {
    // A rejected `ready` before start() is always observed by start().
    void this.ready.catch(() => {});
  }

  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      void this.readStream().catch((error) =>
        this.fail(error instanceof Error ? error : new Error(String(error))),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mcp sse connect timeout")), 30_000);
      (timer as { unref?: () => void }).unref?.();
      this.ready.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  initialized(): void {
    /* legacy SSE has no protocol version header */
  }

  private dispatch(message: JsonRpcMessage): void {
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      try {
        pending.resolve(unwrap(message));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (message.method && message.id === undefined) this.onNotification(message);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.controller.abort();
    this.onClose();
  }

  private async readStream(): Promise<void> {
    const res = await fetch(this.cfg.url, {
      method: "GET",
      headers: { ...this.cfg.headers, Accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (!res.ok) throw await httpError("sse", res);
    if (!res.body) throw new Error("mcp sse: empty response");
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      throw new Error(`mcp sse: expected an event stream, got ${contentType || "unknown content type"}`);
    }

    for await (const frame of sseEvents(res.body)) {
      if (frame.event === "endpoint") {
        const endpoint = new URL(frame.data, this.cfg.url).toString();
        this.endpoint = endpoint;
        this.resolveReady();
        continue;
      }
      if (frame.event !== "message") continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(frame.data) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
    throw new Error("mcp sse: event stream ended");
  }

  private async post(message: JsonRpcMessage, timeoutMs: number): Promise<void> {
    if (!this.endpoint) throw new Error("mcp sse: not connected");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { ...this.cfg.headers, "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!res.ok) throw await httpError("sse", res);
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to consume */
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("mcp timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(message: JsonRpcMessage, timeoutMs: number): Promise<unknown> {
    await this.start();
    const id = Number(message.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("mcp timeout"));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      void this.post(message, timeoutMs).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async notify(message: JsonRpcMessage, timeoutMs: number): Promise<void> {
    await this.start();
    await this.post(message, timeoutMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.rejectReady(new Error("mcp sse: closed"));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("mcp sse: closed"));
    }
    this.pending.clear();
  }
}
