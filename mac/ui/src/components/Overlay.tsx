/** Sheet (centered modal) and slide-over (right panel). Esc closes; focus moves in and returns. */
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not([data-close])") ?? el;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), textarea, select, [tabindex]:not([tabindex='-1'])")];
      if (!f.length) return;
      const a = f[0]!, z = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, []);
  return ref;
}

export function Sheet({ title, onClose, children, footer, wide, label }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; label?: string }) {
  const ref = useDismiss(onClose);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`sheet${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={label ?? title} tabIndex={-1}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon btn-sm" data-close onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function SlideOver({ title, label, onClose, children, actions }: { title: string; label: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useDismiss(onClose);
  return (
    <>
      <div className="slideover-backdrop" onMouseDown={onClose} />
      <aside ref={ref} className="slideover" aria-label={label} tabIndex={-1}>
        <div className="slideover-head">
          <h2>{title}</h2>
          {actions}
          <button className="btn btn-ghost btn-icon btn-sm" data-close onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><Icon name="close" size={14} /></button>
        </div>
        <div className="slideover-body">{children}</div>
      </aside>
    </>
  );
}
