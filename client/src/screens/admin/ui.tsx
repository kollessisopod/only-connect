/**
 * Small presentational primitives shared by the admin pages (buttons, panels, fields, inline confirm).
 * Styles live in admin.css under the `adm-` prefix.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { TeamId } from '@only-connect/shared';

export type ButtonTone = 'default' | 'primary' | 'good' | 'bad' | 'warn' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  block?: boolean;
  /** Keyboard shortcut hint rendered as a small key cap. */
  hotkey?: string;
  busy?: boolean;
}

export function Button({
  tone = 'default',
  size = 'md',
  block = false,
  hotkey,
  busy = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'adm-btn',
    tone !== 'default' ? `adm-btn--${tone}` : '',
    size !== 'md' ? `adm-btn--${size}` : '',
    block ? 'adm-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {hotkey && <span className="adm-btn__key" aria-hidden="true">{hotkey}</span>}
      {children}
      {busy && <span aria-hidden="true">…</span>}
    </button>
  );
}

export interface PanelProps {
  title: ReactNode;
  tools?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** When set the header toggles the body. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  dim?: boolean;
}

export function Panel({ title, tools, children, className, collapsible = false, defaultCollapsed = false, dim = false }: PanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();
  const classes = ['adm-panel', collapsed ? 'is-collapsed' : '', dim ? 'is-dim' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <section className={classes}>
      <header className="adm-panel__head">
        <h2>{title}</h2>
        <div className="adm-panel__tools">
          {tools}
          {collapsible && (
            <Button size="sm" tone="ghost" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? 'Expand ▾' : 'Collapse ▴'}
            </Button>
          )}
        </div>
      </header>
      {!collapsed && (
        <div className="adm-panel__body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

export function Field({ label, hint, error, children, className, htmlFor }: FieldProps) {
  return (
    <div className={`adm-field${className ? ` ${className}` : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div className="adm-field__error">{error}</div> : hint ? <div className="adm-field__hint">{hint}</div> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  small?: boolean;
}

export function Input({ invalid = false, small = false, className, ...rest }: InputProps) {
  const classes = ['adm-input', small ? 'adm-input--sm' : '', invalid ? 'is-invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <input className={classes} aria-invalid={invalid || undefined} {...rest} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  small?: boolean;
}

export function Select({ invalid = false, small = false, className, children, ...rest }: SelectProps) {
  const classes = ['adm-select', small ? 'adm-select--sm' : '', invalid ? 'is-invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <select className={classes} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid = false, className, ...rest }: TextareaProps) {
  const classes = ['adm-textarea', invalid ? 'is-invalid' : '', className ?? ''].filter(Boolean).join(' ');
  return <textarea className={classes} aria-invalid={invalid || undefined} {...rest} />;
}

/** A team id is a tone too (`adm-chip--<team>`): the chip takes the team's colour, for any of the four teams. */
export type ChipTone = 'default' | 'good' | 'bad' | 'warn' | 'muted' | TeamId;

export function Chip({ tone = 'default', children, title }: { tone?: ChipTone; children: ReactNode; title?: string }) {
  return (
    <span className={`adm-chip${tone !== 'default' ? ` adm-chip--${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ tone = 'default', children }: { tone?: 'default' | 'bad' | 'warn' | 'good'; children: ReactNode }) {
  return <div className={`adm-notice${tone !== 'default' ? ` adm-notice--${tone}` : ''}`}>{children}</div>;
}

export interface InlineConfirmProps {
  text: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** `data-testid` of the confirm button, so a test can find the one confirm among several open panels. */
  confirmTestId?: string;
}

/** Danger-styled inline confirmation (the viewer may block window.confirm, so we never use it). */
export function InlineConfirm({ text, confirmLabel = 'Confirm', onConfirm, onCancel, busy = false, confirmTestId }: InlineConfirmProps) {
  return (
    <div className="adm-confirm" role="alertdialog" aria-live="assertive">
      <span className="adm-confirm__text">{text}</span>
      <Button tone="bad" size="sm" onClick={onConfirm} busy={busy} autoFocus data-testid={confirmTestId}>
        {confirmLabel}
      </Button>
      <Button tone="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

export interface ToastProps {
  message: string | null;
  tone?: 'bad' | 'good';
  onClose: () => void;
  /** Auto-hide after this many ms (0 = never). */
  ttlMs?: number;
}

export function Toast({ message, tone = 'bad', onClose, ttlMs = 6000 }: ToastProps) {
  // Callers often pass a fresh arrow each render; keep it in a ref so the hide timer is not restarted by re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!message || ttlMs <= 0) return;
    const id = window.setTimeout(() => onCloseRef.current(), ttlMs);
    return () => window.clearTimeout(id);
  }, [message, ttlMs]);
  if (!message) return null;
  return (
    <div className={`adm-toast${tone === 'good' ? ' adm-toast--good' : ''}`} role="alert">
      <span>{message}</span>
      <button type="button" className="adm-toast__close" onClick={onClose} aria-label="dismiss">
        ×
      </button>
    </div>
  );
}

/** Format a ms timestamp as HH:MM:SS (local time). */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** m:ss for a number of seconds. */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/** RFC 4122 v4 id that also works on insecure origins (crypto.randomUUID needs a secure context). */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
