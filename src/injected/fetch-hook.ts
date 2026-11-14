/**
 * window.fetch hook — installed at document start, before any page script.
 *
 * Responsibilities:
 *  - block telemetry beacons (improving.duckduckgo.com) with a synthetic 204
 *  - for duck.ai chat requests: inject tool instructions, fold our custom
 *    tool-invocation parts back into text, and supervise the SSE response so
 *    model-emitted `<tool_call>` envelopes are executed on the Bun harness and
 *    auto-continued transparently.
 *
 * Requests that are not duck.ai chat POSTs (or that we cannot safely rewrite)
 * fall back to pure observation.
 */
import { renderToolInstructions, type ToolManifestEntry } from "../protocol";
import { createChatStream, type SupervisorDeps } from "./chat-supervisor";
import { log as rootLog } from "./log";
import { prepareMessages, sanitizeMessages, type WireMessage } from "./messages";
import { createObservingStream, onSSEEvent, type SSEEventHook } from "./sse";
import { createToolUi } from "./ui";
import { fetchAndSolveVqd, solveVqdChallenge } from "./vqd";

const log = rootLog.child("fetch");

const CHAT_URL_RE = /\/duckchat\/v1\/chat(?:\?|$)/;
const TELEMETRY_RE = /^https?:\/\/(improving\.duckduckgo\.com)(?=\/|$)/i;

export interface FetchHookOptions {
  /** Called for every parsed SSE event (observation; used on the fallback path). */
  onSSEEvent?: SSEEventHook;
  /** Returns the current custom-tool manifest (empty/absent disables tool mode). */
  getManifest?: () => ToolManifestEntry[];
  /** Executes a custom tool on the Bun side. */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Called for each duck.ai chat request with headers tracked for drift. */
  onChat?: (info: { feVersion?: string }) => void;
  /** Whether the DuckAI harness is active for this chat session (defaults to true). */
  isHarnessEnabled?: () => boolean;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  // Header names are case-insensitive; normalise to lowercase so that later
  // `set`-style overrides don't accidentally create duplicate headers.
  const out: Record<string, string> = {};
  const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const k of Object.keys(h)) out[k.toLowerCase()] = String((h as Record<string, string>)[k]);
  }
  return out;
}

function bodyStringOf(init?: RequestInit): string | null {
  const b = init?.body;
  return typeof b === "string" ? b : null;
}

function newUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

function observeResponse(res: Response): Response {
  if (!res.ok || !res.body) return res;
  const observed = res.body.pipeThrough(createObservingStream());
  return new Response(observed, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export function installFetchHook(opts: FetchHookOptions = {}): void {
  const w = window as Window & { __duckai_ext_hooked?: boolean };
  if (w.__duckai_ext_hooked) return;
  w.__duckai_ext_hooked = true;

  if (opts.onSSEEvent) onSSEEvent(opts.onSSEEvent);
  const origFetch = window.fetch.bind(window);

  window.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input);

    // 1) Telemetry: short-circuit with an empty success response.
    if (TELEMETRY_RE.test(url)) {
      log.debug(`blocked telemetry: ${url.split("?")[0]}`);
      return new Response(null, { status: 204 });
    }

    const isChat = CHAT_URL_RE.test(url);
    const bodyText = bodyStringOf(init);
    if (isChat) opts.onChat?.({ feVersion: headersOf(input, init)["x-fe-version"] });
    if (!isChat || bodyText === null) {
      return origFetch(input, init);
    }

    // 2) Parse the outbound chat body.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch (err) {
      log.warn("chat request body not JSON", String(err));
      return origFetch(input, init);
    }
    const rawMessages = Array.isArray(parsed.messages)
      ? (parsed.messages as WireMessage[])
      : null;
    if (!rawMessages) return origFetch(input, init);

    const harnessActive = opts.isHarnessEnabled ? opts.isHarnessEnabled() : true;
    const manifest = opts.getManifest?.() ?? [];
    const toolsEnabled = harnessActive && manifest.length > 0 && typeof opts.callTool === "function";

    log.info(
      `chat request → model=${String(parsed.model)} messages=${rawMessages.length} tools=${manifest.length} harness=${harnessActive ? "on" : "off"} greeting=${String(parsed.canShowGreeting)}`,
    );

    if (!toolsEnabled) {
      const res = await origFetch(input, init);
      if (isChat) {
        log.info(
          `chat response ← status=${res.status} streaming (observe) [harness=${harnessActive ? "on" : "off"}]`,
        );
      }
      return observeResponse(res);
    }

    // 3) Rewrite the outbound conversation: fold custom parts, inject tools,
    // and advertise our tools through the request's own `tools` field so the
    // model can call them via its native function-calling channel.
    const requestHeaders = headersOf(input, init);
    const instructions = renderToolInstructions(manifest);
    let messages = sanitizeMessages(rawMessages);
    messages = prepareMessages(messages, instructions);

    const effectiveParsed = { ...parsed, canUseTools: true };
    const outBody = JSON.stringify({ ...effectiveParsed, messages });
    const outInit: RequestInit = {
      ...init,
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: outBody,
    };

    const requestVqd = requestHeaders["x-vqd-hash-1"] ?? requestHeaders["X-Vqd-Hash-1"];
    const firstController = new AbortController();
    const upstream = await origFetch(url, { ...outInit, signal: firstController.signal });

    // 4) Supervise the SSE response (execute custom tool calls + continue).
    if (!upstream.ok || !upstream.body) {
      let detail = "";
      try {
        detail = (await upstream.clone().text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      log.warn(`chat response ← status=${upstream.status} (not streamed) ${detail}`);
      return upstream;
    }
    log.info(`chat response ← status=${upstream.status} streaming (supervised)`);

    let currentChallenge = upstream.headers.get("x-vqd-hash-1");
    let currentVqd = requestVqd;
    const baseHeaders = outInit.headers as Record<string, string>;

    // Custom widget layer: renders our tool calls inside this turn's assistant
    // message (the duck.ai reducer ignores tool names it doesn't know).
    const ui = createToolUi();

    const deps: SupervisorDeps = {
      callTool: (name, args) => opts.callTool!(name, args),
      continueChat: async (msgs, signal) => {
        const built = await buildContinuationRequest(
          baseHeaders,
          effectiveParsed,
          msgs,
          currentVqd,
          currentChallenge,
          origFetch,
          signal,
        );
        const nextChallenge = built.headers.get("x-vqd-hash-1");
        if (nextChallenge) {
          currentChallenge = nextChallenge;
        }
        return built;
      },
      onEvent: opts.onSSEEvent,
      isCustomTool: (name) => manifest.some((t) => t.name === name),
      onToolStart: ({ id, name, arguments: args, slotId }) => ui.start(id, name, args, slotId),
      onToolEnd: ({ id, name, result, error }) => ui.finish(id, name, result, error),
    };

    const stream = createChatStream({
      firstResponse: upstream,
      firstController,
      messages,
      deps,
    });
    return new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }) as typeof window.fetch;

  log.info("fetch hook installed");
}

async function buildContinuationRequest(
  baseHeaders: Record<string, string>,
  parsed: Record<string, unknown>,
  messages: WireMessage[],
  requestVqd: string | undefined,
  freshChallenge: string | null,
  origFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  // Prefer a freshly solved challenge; fall back to the original solution.
  let vqd: string | undefined = requestVqd;
  if (freshChallenge) {
    const solved = await solveVqdChallenge(freshChallenge);
    if (solved) vqd = solved;
  }

  const makeHeaders = (token: string | undefined): Record<string, string> => ({
    ...baseHeaders,
    "x-duckai-response-id": newUuid(),
    ...(token ? { "x-vqd-hash-1": token } : {}),
  });

  // A continuation is a new assistant turn: give its durable stream a new id.
  let nextBody: Record<string, unknown> = { ...parsed, messages };
  const durable = parsed.durableStream;
  if (durable && typeof durable === "object") {
    nextBody = {
      ...nextBody,
      durableStream: { ...(durable as Record<string, unknown>), messageId: newUuid() },
    };
  }
  const body = JSON.stringify(nextBody);
  const doFetch = (token: string | undefined): Promise<Response> =>
    origFetch("/duckchat/v1/chat", { method: "POST", headers: makeHeaders(token), body, signal });

  let res = await doFetch(vqd);
  if (res.ok) return res;

  let errDetail = "";
  try {
    errDetail = await res.clone().text();
  } catch {}
  log.warn(`continuation HTTP ${res.status}: ${errDetail.slice(0, 300)}; refreshing vqd challenge`);

  // Wait a short moment to clear concurrency/rate-limit before querying /status
  await new Promise((resolve) => setTimeout(resolve, 800));

  const refreshed = await fetchAndSolveVqd(origFetch);
  if (refreshed) {
    res = await doFetch(refreshed);
  }
  return res;
}


