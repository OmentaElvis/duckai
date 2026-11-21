# Injected UI kit

Interactive panels are Preact islands rendered into a shadow root. duck.ai sees
one host element per panel; everything inside belongs to us.

This directory is the shared layer:

| File | Purpose |
| --- | --- |
| `mount.ts` | `mountIsland`, `attachToBody`, `Island<P>` |
| `components.tsx` | `Button`, `TextInput`, `TextArea`, `Select`, `Field`, `Checkbox`, `Row`, `Footer`, `SectionHead`, `Modal` |
| `theme.ts` | `usePageTheme()`, `themeVars(dark)` |
| `styles.ts` | `BASE_STYLES` and the `ui-*` class primitives |
| `tool-body.tsx` | `paintToolBody` / `clearToolBody` used by tool cards |

## When to use Preact

Use a Preact island when **we own the DOM**: panels, modals, banners, overlays,
tool-card bodies. Keep duck.ai-owned elements imperative (`settings-menu.ts`,
`composer-toggle.ts`) those modules add a menu item or toggle a native button,
and rewriting them in Preact would only add indirection.

## Mounting a panel

```tsx
import { attachToBody, mountIsland, type Island } from "./ui/mount";
import { Button, Modal } from "./ui/components";

interface PanelProps {
  open: boolean;
  onClose: () => void;
}

function Panel({ open, onClose }: PanelProps) {
  return (
    <Modal
      open={open}
      title="Example"
      onClose={onClose}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <p>Panel content</p>
    </Modal>
  );
}

const island: Island<PanelProps> = mountIsland({
  marker: "data-duckai-ext-example",
  component: Panel,
  props: { open: false, onClose: () => close() },
  styles: `.example-row { display: flex; gap: 8px; }`,
});

// Later: open it.
attachToBody(island.host);
island.update({ open: true, onClose: close });
```

Rules of thumb:

- Keep **all mutable panel state in the component** (`useState`), not in nullable
  module refs. The controller outside Preact should only own things that must
  survive a render, such as the island handle and a queue of pending promises.
- `island.update(nextProps)` replaces props and re-renders. Preact preserves
  component state between updates, so form input and scroll position survive.
- Call `island.destroy()` when tearing down; it unmounts Preact and removes the
  host.
- Panels that must exist immediately can stay attached and render `null` while
  closed (see `Modal`). That keeps opening/closing cheap.
- Put panel-specific CSS in `styles`; the kit prefixes `BASE_STYLES` for you.
  Keep shared primitives in `styles.ts` and one-off classes in the panel file so
  they are easy to find.

## Theme

`usePageTheme()` returns `true` when duck.ai is dark. It watches the media query
and `<html>` class/style changes, so it updates live.

`themeVars(dark)` returns the CSS custom properties used by the kit:

```tsx
<div class="card" style={themeVars(dark)}>…</div>
```

The variables are `--h-bg`, `--h-fg`, `--h-border`, `--h-hover`, and
`--h-accent`. The kit's CSS already falls back to sensible values, so a panel
only needs `themeVars` when it paints its own surfaces.

## Custom tool cards

A tool can register a TSX body instead of `RenderBlock[]`:

```tsx
import { registerToolView, type ToolCallView } from "./tool-render";
import { Button } from "./ui/components";

function MailResults({ call }: { call: ToolCallView }) {
  // `result` is undefined while the call is still running.
  const result = call.result ? JSON.parse(call.result) : null;
  if (!result?.messages) return <p class="ui-hint">Searching…</p>;

  return (
    <div class="mail-list">
      {result.messages.map((message: { id: string; subject: string }) => (
        <div class="mail-row" key={message.id}>
          <span>{message.subject}</span>
          <Button onClick={() => openMessage(message.id)}>Open</Button>
        </div>
      ))}
    </div>
  );
}

registerToolView("mail_search", {
  summary: (call) => `${count(call)} emails`,
  component: MailResults,
  styles: `.mail-row { display: flex; justify-content: space-between; }`,
});
```

- `component` replaces `body` for the expanded card. It receives the live
  `ToolCallView`, including `result` once the call finishes.
- `styles` is injected **once per shadow root**, so the same view can be used in
  several messages without duplicating CSS. Scope selectors to classes used by
  the view; `:host` is the tool-card host, not the component root.
- A throwing component falls back to the normal block view; it never breaks the
  surrounding message.
- Offloaded large results (the `ref`/`preview` stub) always use the block view,
  even when a component is registered.
- If you need interactive state, use hooks inside the component. The card body is
  re-rendered with fresh `call` data on every status change.
- Keep pure parsing/formatting in a separate module (like `tools-model.ts`) so it
  is easy to unit test without a DOM.

## Testing

- Preact modules are side-effect-free at import time; tests can import helpers
  without a browser.
- Pure state/form helpers belong outside `.tsx` files (`tools-model.ts` is the
  pattern). Test those directly.
- Registry helpers such as `callCustomView()` are covered in
  `tests/tool-render.test.ts`.
- For DOM behavior, mock the few globals a panel touches; avoid asserting on
  Preact internals.
