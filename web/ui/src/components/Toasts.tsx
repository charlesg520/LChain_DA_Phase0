import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useStore } from "../store";
import { cx } from "./ui";

const ICON = {
  ok: <CircleCheck className="h-4 w-4 text-ok" />,
  info: <Info className="h-4 w-4 text-accent" />,
  warn: <TriangleAlert className="h-4 w-4 text-warn" />,
  error: <CircleAlert className="h-4 w-4 text-err" />,
};

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex animate-slidein items-start gap-2.5 rounded-card border bg-[#0f141d]/95 px-3 py-2.5 text-[12.5px] shadow-xl backdrop-blur",
            t.level === "error" ? "border-err/40" : t.level === "warn" ? "border-warn/40" : t.level === "ok" ? "border-ok/30" : "border-border",
          )}
          role="status"
        >
          <span className="mt-px">{ICON[t.level]}</span>
          <span className="min-w-0 flex-1 break-words text-text">{t.text}</span>
          <button className="text-muted hover:text-text" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
