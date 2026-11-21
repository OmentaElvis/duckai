/**
 * Shared styles for Preact islands.
 *
 * Every island is rendered inside its own shadow root, so these class names
 * never leak into duck.ai and duck.ai's CSS never leaks in. Panels append their
 * own rules via `mountIsland({ styles })`.
 *
 * Naming convention: kit primitives are `ui-*`. Panel-specific classes stay in
 * the panel file so they are easy to find and change.
 */
export const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }

  :host {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.45;
    color: var(--h-fg, inherit);
  }

  button, input, select, textarea { font: inherit; color: inherit; }

  .ui-btn {
    font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
    border-radius: 7px; padding: 5px 12px;
    border: 1px solid var(--h-border, rgba(127,127,127,.3));
    background: transparent; color: inherit;
    transition: background .15s, border-color .15s;
  }
  .ui-btn:hover:not(:disabled) { background: var(--h-hover, rgba(127,127,127,.1)); }
  .ui-btn:disabled { opacity: .5; cursor: default; }
  .ui-btn.primary {
    background: #3969ef; border-color: #3969ef; color: #fff; font-weight: 600;
  }
  .ui-btn.primary:hover:not(:disabled) { background: #2b56cc; border-color: #2b56cc; }
  .ui-btn.danger { color: #e05252; border-color: rgba(224,82,82,.35); }
  .ui-btn.danger:hover:not(:disabled) {
    background: rgba(224,82,82,.15); border-color: #e05252;
  }

  .ui-input, .ui-textarea, .ui-select {
    font: inherit; padding: 5px 8px; border-radius: 7px;
    border: 1px solid var(--h-border, rgba(127,127,127,.3));
    background: transparent; color: inherit;
  }
  .ui-textarea { min-height: 44px; resize: vertical; }
  .ui-input:disabled, .ui-textarea:disabled, .ui-select:disabled { opacity: .55; }

  .ui-field { display: flex; flex-direction: column; gap: 4px; }
  .ui-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .5;
  }
  .ui-hint { font-size: 11px; opacity: .5; }

  .ui-check {
    display: flex; gap: 6px; align-items: center; cursor: pointer; user-select: none;
  }
  .ui-check input[type=checkbox] {
    width: 16px; height: 16px; margin: 0; flex: none;
    accent-color: #3969ef; cursor: pointer;
  }

  .ui-row {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 8px 6px; border-radius: 8px;
  }
  .ui-row:hover { background: var(--h-hover, rgba(127,127,127,.08)); }

  .ui-list { display: flex; flex-direction: column; }
  .ui-footer { margin-top: 10px; opacity: .45; font-size: 11px; }
  .ui-status {
    opacity: .6; text-transform: uppercase; font-size: 11px; letter-spacing: .05em;
  }
  .ui-actions { display: flex; gap: 6px; align-items: center; }

  .ui-modal-backdrop {
    position: fixed; inset: 0; z-index: 2147483646;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.35); backdrop-filter: blur(2px);
  }
  .ui-modal-card {
    width: 440px; max-width: calc(100vw - 32px); max-height: 72vh; overflow: auto;
    border-radius: 12px; padding: 12px 14px;
    border: 1px solid var(--h-border);
    background: var(--h-bg); color: var(--h-fg);
    box-shadow: 0 20px 60px rgba(0,0,0,.4);
  }
  .ui-modal-head { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
  .ui-modal-icon { display: inline-flex; align-items: center; flex: none; }
  .ui-modal-title { font-weight: 600; flex: 1 1 auto; }

  .ui-section-head { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; }
  .ui-section-title { font-weight: 600; flex: 1 1 auto; }
`;
