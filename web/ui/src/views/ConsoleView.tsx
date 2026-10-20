import { ArrowDown, Terminal, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Empty, ViewHeader, cx } from "../components/ui";
import { clock } from "../lib/format";
import { useStore } from "../store";

const TYPES = ["hello", "message", "todos", "task", "interrupt", "stats", "fs", "file", "memory", "skills", "tools", "mcp", "done", "error", "status", "notice", "pong"] as const;

const COLOR: Record<string, string> = {
  hello: "text-accent",
  message: "text-text/85",
  todos: "text-[#fde68a]",
  task: "text-[#c4b5fd]",
  interrupt: "text-warn",
  stats: "text-muted",
  fs: "text-[#93c5fd]",
  file: "text-[#93c5fd]",
  memory: "text-[#f9a8d4]",
  skills: "text-ok",
  tools: "text-[#5eead4]",
  mcp: "text-[#fdba74]",
  done: "text-ok",
  error: "text-err",
  status: "text-warn",
  notice: "text-accent",
  pong: "text-muted/60",
};

export function ConsolePanel({ compact }: { compact?: boolean }) {
  const entries = useStore((s) => s.console);
  const filter = useStore((s) => s.ui.console_filter);
  const follow = useStore((s) => s.ui.console_follow);
  const setUi = useStore((s) => s.setUi);
  const clear = useStore((s) => s.clearConsole);
  const box = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);

  const visible = useMemo(() => entries.filter((e) => filter[e.type as keyof typeof filter] !== false), [entries, filter]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.type] = (c[e.type] || 0) + 1;
    return c;
  }, [entries]);

  useLayoutEffect(() => {
    if (!follow || !box.current) return;
    programmatic.current = true;
    box.current.scrollTop = box.current.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      if (programmatic.current) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom !== useStore.getState().ui.console_follow) useStore.getState().setUi({ console_follow: atBottom });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className={cx("flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border", compact ? "px-2.5 py-2" : "px-4 py-2.5")}>
        {TYPES.map((t) => (
          <label key={t} className="flex cursor-pointer items-center gap-1 font-mono text-[11px]">
            <input
              type="checkbox"
              className="h-3 w-3 accent-[rgb(var(--accent))]"
              checked={filter[t] !== false}
              onChange={(e) => setUi({ console_filter: { ...filter, [t]: e.target.checked } })}
            />
            <span className={COLOR[t]}>{t}</span>
            {counts[t] ? <span className="text-muted/60">{counts[t]}</span> : null}
          </label>
        ))}
        <button className="btn btn-ghost btn-sm ml-auto h-6" onClick={clear} title="Clear">
          <Trash2 className="h-3.5 w-3.5" /> clear
        </button>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto bg-[#090d14] py-1 font-mono text-[11.5px] leading-[1.55]">
        {visible.length === 0 ? (
          <Empty icon={<Terminal />} title="No frames" hint="Every frame the server sends shows up here (last 1000)." />
        ) : (
          visible.map((e) => (
            <div key={e.n} className="flex gap-2 px-3 hover:bg-white/[0.03]">
              <span className="shrink-0 text-muted/60">{clock(e.ts)}</span>
              <span className={cx("w-[68px] shrink-0 font-semibold", COLOR[e.type] || "text-text")}>{e.type}</span>
              <span className={cx("min-w-0 break-all text-text/70", compact && "line-clamp-3")}>{e.raw}</span>
            </div>
          ))
        )}
      </div>
      {!follow && visible.length > 0 && (
        <button
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/50 bg-panel px-3 py-1 text-[11.5px] text-accent shadow-lg"
          onClick={() => setUi({ console_follow: true })}
        >
          <ArrowDown className="h-3.5 w-3.5" /> paused · resume auto-scroll
        </button>
      )}
    </div>
  );
}

export function ConsoleView() {
  const n = useStore((s) => s.console.length);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader icon={<Terminal />} title="Console" subtitle={`raw downlink frames · ${n}/1000 buffered`} />
      <div className="min-h-0 flex-1">
        <ConsolePanel />
      </div>
    </div>
  );
}
