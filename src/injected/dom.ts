/**
 * DOM timing helper for the injected script.
 *
 * WebView2 runs document-created scripts (AddScriptToExecuteOnDocumentCreated)
 * before the document element exists, while WebKitGTK exposes <html> by then.
 * Anything that touches `document.documentElement` / `document.body` must wait:
 * `MutationObserver.observe(null)` throws "parameter 1 is not of type 'Node'",
 * and mounting UI into a missing body silently does nothing.
 */
export function whenDomReady(callback: () => void): void {
  if (typeof document === "undefined") return;
  if (document.documentElement) {
    callback();
    return;
  }

  let done = false;
  const run = (): void => {
    if (done || !document.documentElement) return;
    done = true;
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", run);
    callback();
  };

  // The <html> element is appended to the Document node while parsing starts.
  const observer = new MutationObserver(run);
  observer.observe(document, { childList: true });
  document.addEventListener("DOMContentLoaded", run, { once: true });
}
