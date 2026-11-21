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
    <select {...rest} class={["ui-select", cls].filter(Boolean).join(" ")}>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
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

export interface ModalProps {
  open: boolean;
  title: string;
  status?: string;
  icon?: ComponentChildren;
  actions?: ComponentChildren;
  footer?: ComponentChildren;
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
  if (width !== undefined) style.width = `${width}px`;

  return (
    <div
      class="ui-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="ui-modal-card" style={style}>
        <div class="ui-modal-head">
          {icon ? <span class="ui-modal-icon">{icon}</span> : null}
          <span class="ui-modal-title">{title}</span>
          {status ? <span class="ui-status">{status}</span> : null}
          {actions}
        </div>
        {children}
        {footer ? <div class="ui-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Re-exported so panels can group sibling nodes without an extra import. */
export { Fragment };
