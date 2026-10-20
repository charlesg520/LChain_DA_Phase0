import { Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type DotTone = "accent" | "ok" | "warn" | "err" | "muted" | "info";
const DOT: Record<DotTone, string> = {
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  muted: "bg-muted/60",
  info: "bg-info",
};
const RING: Record<DotTone, string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  muted: "var(--muted)",
  info: "var(--info)",
};

export function Dot({ tone, pulse, className, title }: { tone: DotTone; pulse?: boolean; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-block h-2 w-2 shrink-0 rounded-full", DOT[tone], pulse && "animate-ring", className)}
      style={pulse ? ({ ["--ring" as string]: RING[tone] } as React.CSSProperties) : undefined}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx("h-3.5 w-3.5 animate-spin", className)} />;
}

type TagTone = "muted" | "accent" | "ok" | "warn" | "err" | "info";
const TAG: Record<TagTone, string> = {
  muted: "border-border bg-panel-hi text-muted",
  accent: "border-accent/40 bg-accent/10 text-accent",
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  err: "border-err/40 bg-err/10 text-err",
  info: "border-info/50 bg-info/10 text-[#b9a4ff]",
};

export function Tag({ tone = "muted", children, className, title }: { tone?: TagTone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("tag", TAG[tone], className)}>
      {children}
    </span>
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-muted/60 [&>svg]:h-7 [&>svg]:w-7">{icon}</div>}
      <div className="text-[13px] font-medium text-text/90">{title}</div>
      {hint && <div className="max-w-sm text-[12.5px] text-muted">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Tooltip({ label, side = "right", block, children }: { label: string; side?: "right" | "bottom" | "top" | "left"; block?: boolean; children: ReactNode }) {
  const pos = {
    right: "left-full top-1/2 ml-2 -translate-y-1/2",
    left: "right-full top-1/2 mr-2 -translate-y-1/2",
    bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
    top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  }[side];
  return (
    <span className={cx("group/tt relative", block ? "flex w-full" : "inline-flex")}>
      {children}
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-[6px] border border-border bg-[#0d121b] px-2 py-1 text-[11.5px] text-text opacity-0 shadow-lg transition-opacity delay-150 group-hover/tt:opacity-100",
          pos,
        )}
      >
        {label}
      </span>
    </span>
  );
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  const toast = useStore((s) => s.toast);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-muted transition-colors hover:bg-panel-hi hover:text-text",
        ok && "animate-flash text-ok hover:text-ok",
        className,
      )}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await copyText(text);
          setOk(true);
          toast("ok", "Copied to clipboard");
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setOk(false), 1400);
        } catch {
          toast("error", "Copy failed");
        }
      }}
      aria-label="Copy"
    >
      {ok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {label && <span>{ok ? "Copied" : label}</span>}
    </button>
  );
}

export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("panel overflow-hidden", className)}>
      <header className="flex h-10 items-center justify-between gap-2 border-b border-border px-3.5">
        <div className="section-title flex items-center gap-2">{title}</div>
        {right && <div className="flex items-center gap-1.5">{right}</div>}
      </header>
      {children}
    </section>
  );
}

export function ViewHeader({ title, subtitle, right, icon }: { title: string; subtitle?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="text-accent [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>}
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="truncate text-[12px] text-muted">{subtitle}</div>}
        </div>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40",
        checked ? "border-accent/60 bg-accent/30" : "border-border bg-panel-hi",
      )}
    >
      <span className={cx("absolute h-3 w-3 rounded-full transition-all", checked ? "left-[15px] bg-accent" : "left-[2px] bg-muted")} />
    </button>
  );
}

/** Small modal used by the skill studio and confirmations. */
export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx("panel flex max-h-[90vh] w-full animate-slidein flex-col shadow-2xl", wide ? "max-w-5xl" : "max-w-lg")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="text-[13.5px] font-semibold">{title}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
