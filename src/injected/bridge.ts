/**
 * Page → Bun bridge over webview-bun's `bindRaw()`ed `__harnessNativeCall` global.
 *
 * The bound function is registered natively before navigation, but we look it
 * up lazily at call time to be independent of user-script ordering.
 */
import { log } from "./log";

type HarnessRequest = { method: string; params?: unknown };
type HarnessResponse = { ok: boolean; result?: unknown; error?: string };

declare global {
  interface Window {
    __harnessNativeCall?: (req: HarnessRequest) => Promise<HarnessResponse>;
  }
}

function waitFor<T>(get: () => T | undefined, timeoutMs = 5000, intervalMs = 25): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = get();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error("harness bridge not available"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Call a harness method on the Bun side. Rejects with a descriptive Error. */
export async function callHarness(method: string, params?: unknown): Promise<unknown> {
  const call = await waitFor(() => window.__harnessNativeCall);
  const res = await call({ method, params });
  if (!res || typeof res !== "object") throw new Error(`harness: malformed response for ${method}`);
  if (!res.ok) throw new Error(res.error ?? `harness: ${method} failed`);
  return res.result;
}

/** Fire-and-forget variant that never throws; logs failures. */
export function callHarnessSafe(method: string, params?: unknown): void {
  callHarness(method, params).catch((err) => log.debug(`harness safe call failed: ${method}`, String(err)));
}
