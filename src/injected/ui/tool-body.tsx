import { Component, Fragment, render, type ComponentChildren } from "preact";
import type { CustomToolView, RenderBlock, ToolCallView } from "../tool-render";
import { log as rootLog } from "../log";

const log = rootLog.child("tool-body");

/** Shadow roots that already received a given custom stylesheet. */
const injected = new WeakMap<ShadowRoot, Set<string>>();

function ensureStyles(container: HTMLElement, css?: string): void {
  if (!css) return;
  const root = container.getRootNode();
  if (typeof ShadowRoot === "undefined" || !(root instanceof ShadowRoot)) return;

  let seen = injected.get(root);
  if (!seen) {
    seen = new Set();
    injected.set(root, seen);
  }
  if (seen.has(css)) return;
  seen.add(css);

  const style = document.createElement("style");
  style.setAttribute("data-duckai-tool-style", "");
  style.textContent = css;
  root.append(style);
}

function BlockView({ block }: { block: RenderBlock }) {
  return (
    <div class="block">
      {block.label ? <div class="label">{block.label}</div> : null}
      {block.kind === "code" ? (
        <pre data-language={block.language || undefined}>{block.text}</pre>
      ) : null}
      {block.kind === "text" ? <p class="text">{block.text}</p> : null}
      {block.kind === "fields" ? (
        <div class="fields">
          {block.fields.map((field, index) => (
            <Fragment key={index}>
              <div class="k">{field.label}</div>
              <div class="v">{field.value}</div>
            </Fragment>
          ))}
        </div>
      ) : null}
      {block.kind === "list" ? (
        <ul class="list">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
      {block.kind === "link" ? (
        <a href={block.href} target="_blank" rel="noopener noreferrer">
          {block.text}
        </a>
      ) : null}
    </div>
  );
}

function Blocks({ blocks }: { blocks: RenderBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

/**
 * A throwing custom view must not take the whole message down. The fallback is
 * the same neutral block view used when no custom component is registered.
 */
class BodyBoundary extends Component<
  { fallback: RenderBlock[]; children: ComponentChildren },
  { failed: boolean }
> {
  state = { failed: false };

  componentDidCatch(error: unknown): void {
    log.warn("custom tool view failed; using block fallback", String(error));
    this.setState({ failed: true });
  }

  render() {
    if (this.state.failed) return <Blocks blocks={this.props.fallback} />;
    return this.props.children;
  }
}

/** Render a card body (blocks or a custom TSX component) into `container`. */
export function paintToolBody(
  container: HTMLElement,
  call: ToolCallView,
  blocks: RenderBlock[],
  custom?: CustomToolView,
): void {
  ensureStyles(container, custom?.styles);

  const Custom = custom?.component;
  const content = Custom ? (
    <BodyBoundary fallback={blocks}>
      <Custom call={call} />
    </BodyBoundary>
  ) : (
    <Blocks blocks={blocks} />
  );

  render(content, container);
}

/** Unmount a card body (call before the card element is discarded). */
export function clearToolBody(container: HTMLElement): void {
  render(null, container);
}
