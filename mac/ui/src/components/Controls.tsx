/** Form controls: switch, segmented control, search field, labeled field, link. */
import type { ReactNode, InputHTMLAttributes } from "react";
import { navigate, withScope } from "../router.ts";
import { Icon } from "./Icon.tsx";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" /><span className="thumb" />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v || "_"} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export function SearchField({ large, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { large?: boolean }) {
  return (
    <span className={`searchfield${large ? " lg" : ""}${className ? ` ${className}` : ""}`}>
      <Icon name="search" size={large ? 18 : 14} />
      <input type="search" className={`input${large ? " input-lg" : ""}`} {...rest} />
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/** In-app link: pushState navigation, cmd/ctrl-click keeps the browser behaviour. */
export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a href={withScope(to)} className={className} {...rest}
      onClick={(e) => { rest.onClick?.(e); if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}
