import {
  Fragment,
  type ButtonHTMLAttributes,
  type ComponentChildren,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "preact";
import { useEffect } from "preact/hooks";
import { themeVars, usePageTheme } from "./theme";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger";
}

export function Button({
  variant = "default",
  class: cls,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = ["ui-btn", variant === "default" ? "" : variant, cls]
    .filter(Boolean)
    .join(" ");
  return <button type={type} class={classes} {...rest} />;
}

export function TextInput({ class: cls, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} class={["ui-input", cls].filter(Boolean).join(" ")} />;
}

export function TextArea({ class: cls, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} class={["ui-textarea", cls].filter(Boolean).join(" ")} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  options: SelectOption[];
};

export function Select({ options, class: cls, ...rest }: SelectProps) {
  return (
    <span class="ui-select-wrap">
      <select {...rest} class={["ui-select", cls].filter(Boolean).join(" ")}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        class="ui-select-chevron"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 4.5l3 3 3-3" />
      </svg>
    </span>
  );
}

export interface FieldProps {
  label?: string;
  hint?: string;
  children: ComponentChildren;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label class="ui-field">
      {label ? <span class="ui-label">{label}</span> : null}
      {children}
      {hint ? <span class="ui-hint">{hint}</span> : null}
    </label>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role"> & {
  label: ComponentChildren;
};

export function Checkbox({ label, class: cls, ...rest }: CheckboxProps) {
  return (
    <label class={["ui-check", cls].filter(Boolean).join(" ")}>
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role"> & {
  label?: ComponentChildren;
};

/** Duck.ai-style round toggle. The native input stays focusable/accessible. */
export function Switch({ label, class: cls, title, ...rest }: SwitchProps) {
  return (
    <label class={["ui-switch-field", cls].filter(Boolean).join(" ")} title={title}>
      <span class="ui-switch-control">
        <input type="checkbox" role="switch" {...rest} />
        <span class="ui-switch-track">
          <span class="ui-switch-thumb" />
        </span>
      </span>
      {label ? <span class="ui-switch-label">{label}</span> : null}
    </label>
  );
}

export function Row({ class: cls, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} class={["ui-row", cls].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function Footer({ children }: { children: ComponentChildren }) {
  return <div class="ui-footer">{children}</div>;
}

export function SectionHead({
  title,
  status,
  children,
}: {
  title: string;
  status?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="ui-section-head">
      <span class="ui-section-title">{title}</span>
      {status ? <span class="ui-status">{status}</span> : null}
      {children}
    </div>
  );
}

export interface CloseButtonProps {
  onClick: () => void;
  label?: string;
}

/** Icon-only close control used in the dialog header. */
export function CloseButton({ onClick, label = "Close dialog" }: CloseButtonProps) {
  return (
    <button type="button" class="ui-close" aria-label={label} onClick={onClick}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M4.5 4.5l11 11M15.5 4.5l-11 11" />
      </svg>
    </button>
  );
}

export interface ModalProps {
  open: boolean;
  title: string;
  status?: string;
  icon?: ComponentChildren;
  actions?: ComponentChildren;
  footer?: ComponentChildren;
  /** When present, renders the duck.ai-style sidebar + content split. */
  sidebar?: ComponentChildren;
  children: ComponentChildren;
  onClose: () => void;
  width?: number;
}

/**
 * Shared modal chassis. Renders nothing when closed; the host element can stay
 * attached to the page, so opening a panel never rebuilds the whole tree.
 */
export function Modal({
  open,
  title,
  status,
  icon,
  actions,
  footer,
  sidebar,
  children,
  onClose,
  width,
}: ModalProps) {
  const dark = usePageTheme();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const style: CSSProperties = { ...themeVars(dark) };
  if (width !== undefined) style.width = `min(${width}px, 98vw)`;

  return (
    <div
      class="ui-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="ui-modal-card" style={style} role="dialog" aria-modal="true" aria-label={title}>
        {sidebar ? (
          <div class="ui-modal-split">
            <aside class="ui-modal-sidebar">
              <div class="ui-modal-sidebar-head">
                {icon ? <span class="ui-modal-icon">{icon}</span> : null}
                <h2 class="ui-modal-title">{title}</h2>
                {status ? <span class="ui-status">{status}</span> : null}
              </div>
              <div class="ui-modal-sidebar-body">{sidebar}</div>
            </aside>
            <section class="ui-modal-main">
              {actions ? <div class="ui-modal-head">{actions}</div> : null}
              <div class="ui-modal-body">{children}</div>
              {footer ? <div class="ui-footer">{footer}</div> : null}
            </section>
          </div>
        ) : (
          <>
            <div class="ui-modal-head">
              {icon ? <span class="ui-modal-icon">{icon}</span> : null}
              <h2 class="ui-modal-title">{title}</h2>
              {status ? <span class="ui-status">{status}</span> : null}
              {actions}
            </div>
            <div class="ui-modal-body">{children}</div>
            {footer ? <div class="ui-footer">{footer}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Re-exported so panels can group sibling nodes without an extra import. */
export { Fragment };
