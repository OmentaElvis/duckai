/**
 * Solver for DuckDuckGo's `x-vqd-hash-1` challenge.
 *
 * The server hands us (response header, base64) a self-contained async IIFE
 * that returns:
 *   { server_hashes: string[], client_hashes: string[], signals: {}, meta: {...} }
 *
 * The request header is that object with each `client_hashes` entry SHA-256'd
 * (then base64), plus `origin`/`stack`/`duration` merged into `meta`, base64'd.
 *
 * We execute the challenge the same way the frontend does — as JS in the page.
 * This is best-effort: on any failure we return null and the caller falls back
 * to reusing the previous request's solution.
 */
import { log as rootLog } from "./log";

const log = rootLog.child("vqd");

function b64decode(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function sha256b64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

interface ChallengeResult {
  server_hashes?: string[];
  client_hashes?: string[];
  signals?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** Execute control: try in-page first, then a hidden sandboxed iframe. */
async function runChallenge(source: string, timeoutMs: number): Promise<ChallengeResult> {
  try {
    const fn = new Function(`return (${source});`) as () => Promise<ChallengeResult>;
    const value = await withTimeout(Promise.resolve(fn()), timeoutMs);
    if (value) return value;
  } catch (err) {
    log.debug("vqd: in-page eval failed, trying iframe", String(err));
  }
  return runInIframe(source, timeoutMs);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("vqd: challenge timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function runInIframe(source: string, timeoutMs: number): Promise<ChallengeResult> {
  return new Promise<ChallengeResult>((resolve, reject) => {
    const token = `duckai_vqd_${Math.random().toString(36).slice(2)}`;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.style.display = "none";

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { token?: string; value?: ChallengeResult; error?: string } | null;
      if (!d || d.token !== token) return;
      cleanup();
      if (d.error) reject(new Error(d.error));
      else if (d.value) resolve(d.value);
      else reject(new Error("vqd: empty iframe result"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("vqd: iframe timed out"));
    }, timeoutMs);

    window.addEventListener("message", onMessage);

    const script = `(async function(){
      try {
        var src = ${JSON.stringify(source)};
        var fn = new Function("return (" + src + ");");
        var value = await fn();
        parent.postMessage({ token: ${JSON.stringify(token)}, value: value }, "*");
      } catch (e) {
        parent.postMessage({ token: ${JSON.stringify(token)}, error: String(e && e.message || e) }, "*");
      }
    })();`;
    iframe.srcdoc = `<script>${script}<\/script>`;
    document.body.appendChild(iframe);
  });
}

/** Solve a base64 challenge into the base64 header value, or null on failure. */
export async function solveVqdChallenge(
  challengeB64: string,
  timeoutMs = 3000,
): Promise<string | null> {
  try {
    const source = b64decode(challengeB64);
    const start = performance.now();
    const value = await runChallenge(source, timeoutMs);
    const duration = String(Math.round(performance.now() - start));
    const client = Array.isArray(value.client_hashes) ? value.client_hashes : [];
    const hashed = await Promise.all(client.map((h) => sha256b64(String(h))));
    const payload = {
      server_hashes: Array.isArray(value.server_hashes) ? value.server_hashes : [],
      client_hashes: hashed,
      signals: value.signals ?? {},
      meta: {
        ...(value.meta ?? {}),
        origin: location.origin,
        stack: new Error().stack ?? "",
        duration,
      },
    };
    return b64encode(JSON.stringify(payload));
  } catch (err) {
    log.warn("vqd: solve failed", String(err));
    return null;
  }
}

/**
 * Request a fresh challenge from the status endpoint and solve it. Used when a
 * reused solution is rejected.
 */
export async function fetchAndSolveVqd(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl("/duckchat/v1/status?x-vqd-accept=1", {
      method: "GET",
      headers: { "x-vqd-accept": "1" },
      credentials: "omit",
    });
    const challenge = res.headers.get("x-vqd-hash-1");
    if (!challenge) {
      log.debug("vqd: status returned no challenge header");
      return null;
    }
    return await solveVqdChallenge(challenge);
  } catch (err) {
    log.warn("vqd: status request failed", String(err));
    return null;
  }
}
