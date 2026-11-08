/**
 * Plugin health check.
 *
 * Runs a set of invariant probes against the live duck.ai page so that a
 * front-end change which would break the extension (renamed DOM anchors, a new
 * VQD challenge format, a new native tool, a shifted storage layout) surfaces
 * *immediately* — in the host console — rather than at the next tool call.
 *
 * Every probe returns "ok" | "warn" | "fail" | "skip"; a probe that throws is
 * itself a failure, so the check can never take the page down.
 */
import {
  FENCE_CLOSE,
  KNOWN_NATIVE_TOOLS,
  TOOL_OPEN,
  type ToolManifestEntry,
} from "../protocol";
import {
  healthStatusOf,
  type HealthCheck,
  type HealthReport,
  type HealthStatus,
} from "../health-report";
import { savedConversationIds } from "./chat-store";
import { EnvelopeDetector } from "./envelope";
import { log } from "./log";
import { assistantElements, parseAssistantId, placementAnchor } from "./ui";
import { solveVqdChallenge } from "./vqd";

/** SSE roles we understand / pass through. Anything else is drift. */
export const EXPECTED_SSE_ROLES: ReadonlySet<string> = new Set([
  "assistant",
  "tool-invocation",
  "ui-component",
  "source",
  "reasoning",
  "refusal",
  "generated-image",
]);

// --- cumulative observations (fed from live traffic) -----------------------

const seenRoles = new Set<string>();
const seenNativeTools = new Set<string>();
let feVersion: string | null = null;

/** Record an observed SSE event for the drift checks. */
export function noteEvent(
  ev: { json?: Record<string, unknown> | null; special?: string | null },
  isCustomTool?: (name: string) => boolean,
): void {
  const role = ev.json?.role;
  if (typeof role === "string" && role) seenRoles.add(role);
  if (role === "tool-invocation" && typeof ev.json?.toolName === "string") {
    const name = ev.json.toolName;
    if (!isCustomTool?.(name)) seenNativeTools.add(name);
  }
}

/** Record the front-end build string sent with chat requests. */
export function noteFeVersion(v: string | null | undefined): void {
  if (v) feVersion = v;
}

// --- check helpers ---------------------------------------------------------

function make(
  id: string,
  label: string,
  status: HealthStatus,
  detail?: string,
): HealthCheck {
  return detail === undefined ? { id, label, status } : { id, label, status, detail };
}
const ok = (id: string, label: string, detail?: string) => make(id, label, "ok", detail);
const warn = (id: string, label: string, detail?: string) => make(id, label, "warn", detail);
const fail = (id: string, label: string, detail?: string) => make(id, label, "fail", detail);
const skip = (id: string, label: string, detail?: string) => make(id, label, "skip", detail);

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- probes ----------------------------------------------------------------

async function probeBridge(): Promise<HealthCheck> {
  const id = "bridge";
  const label = "Harness bridge (page ⇄ Bun IPC)";
  if (typeof window.harnessCall !== "function") {
    return fail(id, label, "window.harnessCall missing");
  }
  try {
    const res = await window.harnessCall({ method: "ping" });
    return res?.ok ? ok(id, label, "ping ok") : fail(id, label, res?.error ?? "ping not ok");
  } catch (err) {
    return fail(id, label, messageOf(err));
  }
}

function probeFetchHook(): HealthCheck {
  const id = "fetch-hook";
  const label = "Outbound fetch hook installed";
  const hooked = (window as unknown as { __duckai_ext_hooked?: boolean }).__duckai_ext_hooked;
  return hooked ? ok(id, label) : fail(id, label, "window.__duckai_ext_hooked not set");
}

async function probeTelemetry(): Promise<HealthCheck> {
  const id = "telemetry";
  const label = "Telemetry beacons blocked (204)";
  try {
    const res = await fetch("https://improving.duckduckgo.com/t/duckai_health");
    return res.status === 204 ? ok(id, label) : fail(id, label, `expected 204, got ${res.status}`);
  } catch (err) {
    return fail(id, label, messageOf(err));
  }
}

function probeManifest(getTools?: () => ToolManifestEntry[]): HealthCheck {
  const id = "manifest";
  const label = "Custom tool manifest loaded";
  const tools = getTools?.() ?? [];
  if (tools.length === 0) return warn(id, label, "no custom tools registered");
  return ok(id, label, tools.map((t) => t.name).join(", "));
}

/** Pure: the client tool-call envelope still round-trips. */
export function checkEnvelopeGrammar(): HealthCheck {
  const id = "envelope";
  const label = "Custom tool envelope grammar";
  try {
    const sample = `${TOOL_OPEN}\n{"name":"echo","arguments":{"text":"hi"}}\n${FENCE_CLOSE}`;
    const step = new EnvelopeDetector().push(sample);
    const call = step.calls[0];
    const okRoundTrip =
      step.calls.length === 1 && call?.name === "echo" && call.arguments.text === "hi";
    return okRoundTrip ? ok(id, label) : fail(id, label, "round-trip mismatch");
  } catch (err) {
    return fail(id, label, messageOf(err));
  }
}

function probeChatInput(): HealthCheck {
  const id = "chat-input";
  const label = "duck.ai chat input present";
  // The composer only carries this testid inside a conversation, not on home.
  if (assistantElements().length === 0) return skip(id, label, "home view");
  const el = document.querySelector('[data-testid="duckai-chat-input"]');
  return el ? ok(id, label) : warn(id, label, '[data-testid="duckai-chat-input"] not found');
}

function probeAssistantStructure(): HealthCheck {
  const id = "assistant-anchor";
  const label = "Assistant message structure";
  const els = assistantElements();
  if (els.length === 0) return skip(id, label, "no conversation open");
  const el = els[els.length - 1]!;
  if (!parseAssistantId(el.id)) return fail(id, label, `unexpected message id "${el.id}"`);
  if (!placementAnchor(el)) {
    return fail(id, label, "model-name anchor (id^=heading-) missing");
  }
  if (!el.querySelector("[data-message-actions]")) {
    return warn(id, label, "actions bar missing (cosmetic)");
  }
  return ok(id, label, `${els.length} message(s)`);
}

function probeThemeTokens(): HealthCheck {
  const id = "theme-tokens";
  const label = "duck.ai theme tokens present";
  const cs = getComputedStyle(document.documentElement);
  const probes = [
    "--col-blue-50",
    "--col-green-40",
    "--col-red-50",
    "--theme-col-link",
    "--theme-col-bg-primary",
  ];
  const found = probes.filter((p) => cs.getPropertyValue(p).trim());
  return found.length > 0
    ? ok(id, label, `${found.length}/${probes.length} tokens`)
    : warn(id, label, "no known tokens found");
}

function probeLocalStorage(): HealthCheck {
  const id = "storage-local";
  const label = "localStorage sidecar writable";
  try {
    const key = "duckai-ext:health";
    localStorage.setItem(key, "1");
    const value = localStorage.getItem(key);
    localStorage.removeItem(key);
    return value === "1" ? ok(id, label) : fail(id, label, "round-trip mismatch");
  } catch (err) {
    return fail(id, label, messageOf(err));
  }
}

async function probeIndexedDb(): Promise<HealthCheck> {
  const id = "storage-idb";
  const label = "duck.ai IndexedDB readable";
  try {
    const ids = await savedConversationIds();
    if (!ids) return warn(id, label, "saved-chats store not open yet");
    return ok(id, label, `${ids.size} conversation(s)`);
  } catch (err) {
    return warn(id, label, messageOf(err));
  }
}

async function probeVqd(): Promise<HealthCheck> {
  const id = "vqd";
  const label = "VQD challenge fetch + solve";
  try {
    const res = await fetch("/duckchat/v1/status?x-vqd-accept=1", {
      method: "GET",
      headers: { "x-vqd-accept": "1" },
      credentials: "omit",
    });
    if (!res.ok) return fail(id, label, `status HTTP ${res.status}`);
    const challenge = res.headers.get("x-vqd-hash-1");
    if (!challenge) return fail(id, label, "no x-vqd-hash-1 challenge header");
    const solved = await solveVqdChallenge(challenge);
    return solved ? ok(id, label) : fail(id, label, "challenge solve returned null");
  } catch (err) {
    return fail(id, label, messageOf(err));
  }
}

function probeDrift(): HealthCheck {
  const id = "traffic-drift";
  const label = "SSE roles / native tools drift";
  const unknownRoles = [...seenRoles].filter((r) => !EXPECTED_SSE_ROLES.has(r));
  const unknownTools = [...seenNativeTools].filter((t) => !KNOWN_NATIVE_TOOLS.has(t));
  if (unknownRoles.length === 0 && unknownTools.length === 0) {
    return seenRoles.size === 0 ? skip(id, label, "no traffic observed yet") : ok(id, label);
  }
  const parts: string[] = [];
  if (unknownRoles.length) parts.push(`roles: ${unknownRoles.join(", ")}`);
  if (unknownTools.length) parts.push(`tools: ${unknownTools.join(", ")}`);
  return warn(id, label, `new ${parts.join("; ")}`);
}

function probeFeVersion(): HealthCheck {
  const id = "fe-version";
  const label = "Duck.ai front-end build";
  if (!feVersion) return skip(id, label, "not observed yet");
  const KEY = "duckai-ext:health:fe";
  let baseline: string | null = null;
  try {
    baseline = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  if (!baseline) {
    try {
      localStorage.setItem(KEY, feVersion);
    } catch {
      /* ignore */
    }
    return ok(id, label, `baseline ${feVersion}`);
  }
  return baseline === feVersion
    ? ok(id, label, feVersion)
    : warn(id, label, `changed ${baseline} → ${feVersion}`);
}

// --- runner ----------------------------------------------------------------

export interface HealthOptions {
  /** Include network probes (VQD challenge). Default: false. */
  deep?: boolean;
  /** Current custom-tool manifest. */
  getTools?: () => ToolManifestEntry[];
}

export async function runHealthChecks(opts: HealthOptions = {}): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const add = async (probe: HealthCheck | Promise<HealthCheck>): Promise<void> => {
    try {
      checks.push(await probe);
    } catch (err) {
      checks.push(fail("unknown", "probe crashed", messageOf(err)));
    }
  };

  await add(probeBridge());
  await add(probeFetchHook());
  await add(probeTelemetry());
  await add(probeManifest(opts.getTools));
  await add(checkEnvelopeGrammar());
  await add(probeChatInput());
  await add(probeAssistantStructure());
  await add(probeThemeTokens());
  await add(probeLocalStorage());
  await add(probeIndexedDb());
  await add(probeDrift());
  await add(probeFeVersion());
  if (opts.deep) await add(probeVqd());

  const report: HealthReport = {
    at: Date.now(),
    status: healthStatusOf(checks),
    checks,
    ...(feVersion ? { feVersion } : {}),
  };
  log.debug(`health: ${report.status}`, checks.map((c) => `${c.status}:${c.id}`).join(" "));
  return report;
}
