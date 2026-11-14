/**
 * Init-script entry. Runs at document start on every page (duck.ai), before
 * any application script. Exposes `window.__duckai_ext` for debugging in
 * devtools and announces readiness to the Bun host.
 */
import type { ManagedTool, Permission, PermissionScope, ToolManifestEntry } from "../protocol";
import type { HealthReport, HealthStatus } from "../health-report";
import { VERSION } from "../version";
import { callHarness, callHarnessSafe } from "./bridge";
import { installFetchHook } from "./fetch-hook";
import { noteEvent, noteFeVersion, runHealthChecks, type HealthOptions } from "./health";
import { mountApprovalUi, type ApprovalAnswer } from "./approval-ui";
import { mountHealthUi, type HealthUi } from "./health-ui";
import { mountToolsUi, type ToolsUi } from "./tools-ui";
import { mountUpdateBanner } from "./update-banner";
import {
  clearReloadMarker,
  consumeReloadMarker,
  markReloading,
  mountReloadOverlay,
} from "./reload-overlay";
import { mountSettingsEntry } from "./settings-menu";
import { log, type LogEntry } from "./log";
import { onSSEEvent } from "./sse";
import { assistantElements, conversationIdOf, createToolUi, resumeToolHistory } from "./ui";
import { getToolView, registerToolView, unregisterToolView } from "./tool-render";
import { registerBuiltinViews } from "./views";
import { pruneHistory } from "./tool-history";
import { savedConversationIds } from "./chat-store";
import { applyCustomizations } from "./customizations";
import { isHarnessEnabled, mountComposerToggle, toggleHarness } from "./composer-toggle";

type ExtGlobal = {
  version: string;
  ready: boolean;
  log: typeof log;
  callHarness: typeof callHarness;
  sse: { events: number; last: unknown };
  tools: ToolManifestEntry[];
  /**
   * Register a custom summary/body view for a tool name. The stable interface
   * tools use to render rich output without touching duck.ai internals.
   */
  registerToolView: typeof registerToolView;
  unregisterToolView: typeof unregisterToolView;
  /** Plugin health check: probe live invariants and detect duck.ai drift. */
  health: { run: (opts?: HealthOptions) => Promise<HealthReport>; last: HealthReport | null };
  /** Debug/test affordances (e.g. exercising the widget layer from devtools). */
  debug: {
    createToolUi: typeof createToolUi;
    getToolView: typeof getToolView;
    health: typeof runHealthChecks;
    approval?: (name: string, args: Record<string, unknown>) => Promise<ApprovalAnswer>;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    isHarnessEnabled?: () => boolean;
    toggleHarness?: () => boolean;
  };
};

declare global {
  interface Window {
    __duckai_ext?: ExtGlobal;
  }
}

/** Build metadata exposed by Duck.ai on the root <html> element. */
function readPageVersion(): { versionTag?: string; versionSha?: string } {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const versionTag = root?.getAttribute("data-version-tag") ?? undefined;
  const versionSha = root?.getAttribute("data-version-sha") ?? undefined;
  return { versionTag, versionSha };
}

if (!window.__duckai_ext) {
  const sseStats: ExtGlobal["sse"] = { events: 0, last: null };

  const ext: ExtGlobal = {
    version: VERSION,
    ready: false,
    log,
    callHarness,
    sse: sseStats,
    tools: [],
    registerToolView,
    unregisterToolView,
    health: { run: runHealthChecks, last: null },
    debug: { createToolUi, getToolView, health: runHealthChecks },
  };
  window.__duckai_ext = ext;

  // Mirror info/warn/error entries to the host so the terminal shows one
  // unified timeline. Debug stays in the page console only (high volume).
  // Registered before any subsystem starts so early logs are not lost.
  log.onEntry((e: LogEntry) => {
    if (e.level === "debug") return;
    callHarnessSafe("log", { t: e.t, level: e.level, scope: e.scope, msg: e.msg, data: e.data });
  });

  registerBuiltinViews();

  const isCustomTool = (name: string) => ext.tools.some((t) => t.name === name);

  const onEvent = (ev: Parameters<Parameters<typeof onSSEEvent>[0]>[0]) => {
    sseStats.events++;
    sseStats.last = ev.json ?? ev.special ?? ev.data;
    noteEvent(ev, isCustomTool);
    // Assistant text deltas and encrypted reasoning blocks are high-volume and carry
    // no structural signal. Logging them floods both devtools and the host terminal.
    const isIgnored =
      (ev.json?.role === "assistant" && ev.json.message !== "") ||
      ev.json?.role === "reasoning";
    if (!isIgnored) {
      const kind = ev.special ? `[${ev.special}]` : ((ev.json?.role as string) ?? "unknown");
      log.debug(`sse event #${sseStats.events}: ${kind}`, ev.json ?? ev.data);
    }
    if (ev.json?.role !== "reasoning") {
      callHarnessSafe("sseEvent", { json: ev.json, special: ev.special });
    }
  };

  // Human-in-the-loop tool approval: tools whose effective permission is
  // "ask" prompt before running; "Always allow" grants only for this session.
  const approvalUi = mountApprovalUi();
  ext.debug.approval = (name, args) => approvalUi.request(name, args);
  const authorizeAndCall = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    // Pre-flight check: validate required arguments from manifest before prompting user
    const manifest = ext.tools?.find((t) => t.name === name);
    const required =
      manifest?.parameters && typeof manifest.parameters === "object"
        ? (manifest.parameters as { required?: unknown }).required
        : undefined;

    if (Array.isArray(required)) {
      for (const reqKey of required) {
        if (typeof reqKey === "string") {
          const val = args[reqKey];
          if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
            return { error: `Missing required argument "${reqKey}" for tool "${name}".` };
          }
        }
      }
    }

    const decision = (await callHarness("authorize", { name, args })) as {
      level: Permission;
      source: string;
      scopes?: PermissionScope[];
    };
    if (decision.level === "deny") {
      throw new Error(`Permission denied for tool "${name}".`);
    }
    if (decision.level === "ask") {
      const answer = await approvalUi.request(name, args, decision.scopes);
      if (answer.action === "reject") {
        const reasonMsg = answer.reason
          ? ` The user provided this feedback/alternative: "${answer.reason}". Follow the user's instructions.`
          : ` Do not retry without asking.`;
        throw new Error(`The user rejected the "${name}" tool call.${reasonMsg}`);
      }
      if (answer.action === "always") {
        await callHarness("grantSession", { name, scope: answer.scope });
      }
    }
    return callHarness("call", { name, args });
  };
  ext.debug.callTool = authorizeAndCall;
  ext.debug.isHarnessEnabled = isHarnessEnabled;
  ext.debug.toggleHarness = toggleHarness;

  installFetchHook({
    onSSEEvent: onEvent,
    getManifest: () => ext.tools,
    callTool: (name, args) => authorizeAndCall(name, args),
    onChat: (info) => noteFeVersion(info.feVersion),
    isHarnessEnabled,
  });

  // Plugin health check. Runs once after the manifest loads (deep, including a
  // live VQD probe) and again the first time a conversation is open, so the DOM
  // anchors are actually present. The host renders the coloured report.
  let domChecked = false;
  let healthUi: HealthUi | null = null;
  let toolsUi: ToolsUi | null = null;

  const HEALTH_DOT: Record<HealthStatus, string> = {
    ok: "#63c853",
    warn: "#f0b429",
    fail: "#de5833",
    skip: "#9aa0a6",
  };
  const paintHealthDot = (status: HealthStatus): void => {
    const dot = document.querySelector<HTMLElement>(
      "[data-duckai-ext-menu-health] [data-health-dot]",
    );
    if (dot) dot.style.background = HEALTH_DOT[status];
  };

  const runAndReportHealth = async (deep: boolean): Promise<void> => {
    healthUi?.setRunning();
    try {
      const report = await runHealthChecks({ deep, getTools: () => ext.tools });
      ext.health.last = report;
      healthUi?.update(report);
      paintHealthDot(report.status);
      const fails = report.checks.filter((c) => c.status === "fail").length;
      const warns = report.checks.filter((c) => c.status === "warn").length;
      log.info(`health: ${report.status} (${fails} fail, ${warns} warn)`);
      callHarnessSafe("health", { report });
    } catch (err) {
      log.warn("health check failed", String(err));
    }
  };

  healthUi = mountHealthUi({ onRun: () => void runAndReportHealth(true) });
  toolsUi = mountToolsUi({
    load: () => callHarness("tools") as Promise<ManagedTool[]>,
    setEnabled: (name, enabled) =>
      callHarness("setToolEnabled", { name, enabled }) as Promise<ManagedTool[]>,
    setPermission: (name, level) =>
      callHarness("setPermission", { name, level }) as Promise<ManagedTool[]>,
    loadMcp: () => callHarness("mcpServers") as Promise<
      Array<{ name: string; command: string; args: string[]; enabled: boolean; envKeys: string[] }>
    >,
    upsertMcp: (server) =>
      callHarness("mcpUpsert", server) as Promise<
        Array<{ name: string; command: string; args: string[]; enabled: boolean; envKeys: string[] }>
      >,
    deleteMcp: (name) =>
      callHarness("mcpDelete", { name }) as Promise<
        Array<{ name: string; command: string; args: string[]; enabled: boolean; envKeys: string[] }>
      >,
    setMcpEnabled: (name, enabled) =>
      callHarness("mcpSetEnabled", { name, enabled }) as Promise<
        Array<{ name: string; command: string; args: string[]; enabled: boolean; envKeys: string[] }>
      >,
    onChange: (tools) => {
      ext.tools = tools.filter((t) => t.enabled);
    },
  });

  mountSettingsEntry({
    id: "health",
    label: "Plugin health",
    onOpen: () => healthUi?.open(),
    renderIcon: (label) => {
      const dot = document.createElement("span");
      dot.setAttribute("data-health-dot", "");
      dot.style.cssText =
        "width:8px;height:8px;border-radius:50%;flex:none;background:#9aa0a6";
      label.append(dot);
    },
  });
  mountSettingsEntry({
    id: "tools",
    label: "Manage tools",
    onOpen: () => toolsUi?.open(),
  });

  applyCustomizations();
  mountComposerToggle();

  // Restore widget rows for historical tool calls after a reload / when a
  // saved conversation is (re)opened. Debounced: the observer fires a lot.
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleResume = () => {
    if (resumeTimer !== null) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      try {
        resumeToolHistory();
      } catch (err) {
        log.warn("tool history resume failed", String(err));
      }
      if (!domChecked && assistantElements().length > 0) {
        domChecked = true;
        void runAndReportHealth(false);
      }
    }, 250);
  };
  try {
    new MutationObserver(scheduleResume).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (err) {
    log.warn("tool history observer failed", String(err));
  }
  scheduleResume();

  // Keep our sidecar tool history in sync when a chat is deleted: duck.ai keeps
  // conversations in IndexedDB, so we drop history for ids it no longer has
  // (protecting the open conversation, whose DOM we can see).
  const reconcileHistory = () => {
    void savedConversationIds()
      .then((ids) => {
        if (!ids) return; // store unreadable — skip rather than risk pruning
        for (const el of assistantElements()) {
          const c = conversationIdOf(el.id);
          if (c) ids.add(c);
        }
        const removed = pruneHistory(ids);
        if (removed > 0) log.info(`pruned history for ${removed} deleted chat(s)`);
      })
      .catch(() => {
        /* ignore */
      });
  };
  document.addEventListener(
    "click",
    (e) => {
      const el =
        e.target instanceof Element ? e.target.closest("button, [role='menuitem'], a") : null;
      if (!el) return;
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (!/delete\s*chats?/i.test(label)) return;
      // Deletion can be deferred behind a confirm dialog — retry a few times.
      for (const delay of [600, 1600, 3200]) setTimeout(reconcileHistory, delay);
    },
    true,
  );

  ext.ready = true;
  log.info(`extension ready on ${location.host}`);

  // ── Update banner & reload progress ───────────────────────────────────────
  // Only the top frame owns the notice: if the injection also runs inside an
  // iframe it must not consume the reload marker or draw a second banner.
  const isTopFrame = window.top === window;
  const updateBanner = mountUpdateBanner();
  const reloadOverlay = mountReloadOverlay();
  let currentUpdate: { cachedVersion?: string; upstreamVersion?: string } | null = null;
  let reloading = false;
  let updateShown = false;
  let updateDismissed = false;
  let updateAttempts = 0;

  const finishReload = () => {
    if (!reloading) return;
    reloading = false;
    clearReloadMarker();
    reloadOverlay.hide();
  };

  // A reload began in the previous document. Keep a visible progress overlay
  // on screen until this page has actually loaded, so the navigation does not
  // look like a frozen webview.
  const pendingReload = isTopFrame ? consumeReloadMarker() : null;
  if (pendingReload) {
    reloading = true;
    reloadOverlay.show({
      label: pendingReload.label,
      detail: pendingReload.upstreamVersion,
    });
    const hideWhenReady = () => window.setTimeout(finishReload, 350);
    if (document.readyState === "complete") hideWhenReady();
    else window.addEventListener("load", hideWhenReady, { once: true });
    // Safety net: never leave the app covered if `load` is delayed forever.
    window.setTimeout(finishReload, 20_000);
  }

  const triggerReload = async (opts: { label?: string; detail?: string } = {}): Promise<void> => {
    if (reloading) return;
    reloading = true;
    const label = opts.label ?? (currentUpdate?.upstreamVersion ? "Updating Duck.ai…" : "Reloading Duck.ai…");
    const detail = opts.detail ?? currentUpdate?.upstreamVersion;
    const marker = markReloading(detail, location.href, label);
    if (updateShown) updateBanner.setReloading(true);
    reloadOverlay.show({ label, detail: marker.upstreamVersion });
    try {
      await callHarness("reload");
      // The worker replaces the document asynchronously. If that never happens,
      // recover instead of leaving the window covered by the overlay.
      window.setTimeout(() => {
        if (!reloading) return;
        log.warn("webview reload did not start; falling back to location.reload()");
        finishReload();
        if (updateShown) updateBanner.setReloading(false);
        location.reload();
      }, 15_000);
    } catch (err) {
      log.warn("reload failed", String(err));
      finishReload();
      if (updateShown) updateBanner.setReloading(false);
      location.reload();
    }
  };

  // Keyboard reload shortcuts (F5, Ctrl+R, Cmd+R, Ctrl+Shift+R, Ctrl+F5)
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const isF5 = e.key === "F5";
      const isCtrlR = (e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R");
      if (isF5 || isCtrlR) {
        e.preventDefault();
        e.stopPropagation();
        void triggerReload({ label: "Reloading Duck.ai…" });
      }
    },
    true,
  );

  // Mark reload if the page unloads unexpectedly or via other navigation
  window.addEventListener("beforeunload", () => {
    if (!reloading && isTopFrame) {
      markReloading(undefined, location.href, "Reloading Duck.ai…");
    }
  });

  const checkAndShowUpdate = (info: unknown): boolean => {
    const u = (info && typeof info === "object" ? info : {}) as {
      hasUpdate?: boolean;
      cachedVersion?: string;
      upstreamVersion?: string;
    };
    if (!u.hasUpdate || reloading || updateDismissed || !isTopFrame) return false;
    currentUpdate = {
      cachedVersion: u.cachedVersion,
      upstreamVersion: u.upstreamVersion,
    };
    updateShown = true;
    updateBanner.show({
      cachedVersion: u.cachedVersion,
      upstreamVersion: u.upstreamVersion,
      onReload: () =>
        void triggerReload({
          label: "Updating Duck.ai…",
          detail: u.upstreamVersion,
        }),
      onDismiss: () => {
        updateDismissed = true;
      },
    });
    return true;
  };

  // Wait until the root <html> attributes exist before reporting the build
  // version; otherwise the host cannot tell whether a reload actually applied
  // the new cache and the banner would immediately reappear.
  const announcePageReady = () => {
    // Only the top document may clear a pending update: nested frames can be
    // on a different build and would otherwise dismiss the notice too early.
    const version = isTopFrame ? readPageVersion() : {};
    callHarness("pageReady", {
      href: location.href,
      ua: navigator.userAgent,
      ...version,
    })
      .then((r) => {
        log.info("host acknowledged pageReady", r);
        const res = r as { update?: unknown } | undefined;
        if (res?.update) checkAndShowUpdate(res.update);
      })
      .catch((err) => log.warn("host unreachable", String(err)));
  };

  if (document.readyState === "loading" && !readPageVersion().versionTag) {
    document.addEventListener("DOMContentLoaded", announcePageReady, { once: true });
  } else {
    announcePageReady();
  }

  // The host fetches upstream in the background (with an 8s timeout) and may
  // still be running when the page is ready. Poll for a while so an update that
  // lands late is not silently missed.
  const pollForUpdate = async () => {
    updateAttempts++;
    if (!updateShown && !updateDismissed && !reloading) {
      try {
        const res = await callHarness("checkUpdate", isTopFrame ? readPageVersion() : undefined);
        checkAndShowUpdate(res);
      } catch {
        /* host still starting */
      }
    }
    if (!updateShown && !updateDismissed && updateAttempts < 10) {
      window.setTimeout(pollForUpdate, 15_000);
    }
  };

  // Secondary check once host background update fetch completes.
  window.setTimeout(pollForUpdate, 4000);

  // Load the custom-tool manifest; tools stay disabled until it arrives.
  void (async () => {
    try {
      const manifest = (await callHarness("manifest")) as ToolManifestEntry[];
      if (Array.isArray(manifest)) {
        ext.tools = manifest;
        log.info(`tool manifest loaded: ${manifest.map((t) => t.name).join(", ") || "(none)"}`);
      }
    } catch (err) {
      log.warn("manifest load failed", String(err));
    }
  })();

  // Give duck.ai a moment to hydrate the view before probing the DOM.
  setTimeout(() => void runAndReportHealth(true), 1200);
}
