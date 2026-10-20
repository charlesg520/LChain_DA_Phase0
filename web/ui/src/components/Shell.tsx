import {
  Bot,
  Brain,
  FolderTree,
  History,
  ListChecks,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Pause,
  Play,
  Settings as SettingsIcon,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { compact, duration, mmss, shortId } from "../lib/format";
import { elapsedMs, useStore, type DockTab, type View } from "../store";
import { AgentsPanel } from "../views/AgentsView";
import { ConsolePanel } from "../views/ConsoleView";
import { TasksPanel } from "../views/TasksView";
import { Dot, Tooltip, cx } from "./ui";

export const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: "chat", label: "Chat", icon: <MessageSquare /> },
  { view: "history", label: "History", icon: <History /> },
  { view: "tasks", label: "Tasks", icon: <ListChecks /> },
  { view: "agents", label: "Sub-agents", icon: <Bot /> },
  { view: "files", label: "Files", icon: <FolderTree /> },
  { view: "memory", label: "Memory", icon: <Brain /> },
  { view: "toolkit", label: "Toolkit", icon: <Wrench /> },
  { view: "console", label: "Console", icon: <Terminal /> },
  { view: "settings", label: "Settings", icon: <SettingsIcon /> },
];

// ------------------------------------------------------------------ header
export function Header() {
  const conn = useStore((s) => s.connection.status);
  const hello = useStore((s) => s.connection.hello);
  const run = useStore((s) => s.run);
  const draft = useStore((s) => s.ui.draft);
  const dock = useStore((s) => s.ui.dock);
  const setUi = useStore((s) => s.setUi);
  const chat = useStore((s) => s.chat);
  const control = useStore((s) => s.control);

  const awaiting = Boolean(run.current_interrupt && !run.interrupt_outcome && run.status !== "idle");
  const offline = conn !== "open";
  const label = offline
    ? conn === "unauthorized"
      ? "NO ACCESS"
      : conn === "connecting"
        ? "CONNECTING"
        : "OFFLINE"
    : awaiting
      ? "APPROVAL"
      : run.status === "running"
        ? "LIVE"
        : run.status === "paused"
          ? "PAUSED"
          : run.id
            ? "STOPPED"
            : "READY";
  const tone = offline ? (conn === "connecting" ? "warn" : "err") : awaiting || run.status === "paused" ? "warn" : run.status === "running" ? "accent" : "muted";
  const elapsed = elapsedMs(run);

  return (
    <header className="relative z-30 flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-panel px-3 md:px-4">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-accent/40 bg-accent/10 font-mono text-[11px] font-bold text-accent">HQ</div>
        <span className="hidden text-[13.5px] font-semibold tracking-tight sm:inline">HQ Console</span>
        {hello?.mode === "mock" && (
          <span className="tag border-warn/40 bg-warn/10 text-warn" title="Standalone demo: no agent behind it">
            mock
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-card border border-border bg-bg/60 px-2.5 py-1">
        <Dot tone={tone} pulse={!offline && (run.status === "running" || awaiting)} />
        <span className={cx("font-mono text-[11px] font-semibold tracking-[0.12em]", tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : tone === "err" ? "text-err" : "text-muted")}>
          {label}
        </span>
      </div>

      {hello?.model && (
        <span className="hidden max-w-[220px] truncate rounded-card border border-border px-2 py-1 font-mono text-[11px] text-muted lg:inline" title={`model: ${hello.model}`}>
          {hello.model}
        </span>
      )}

      <div className="hidden items-center gap-3 font-mono text-[11.5px] tabular-nums text-muted md:flex">
        <span title="elapsed">{mmss(elapsed)}</span>
        <span title="tokens in / out">
          <span className="text-text/80">{compact(run.stats?.tokens_in ?? 0)}</span>↓ <span className="text-text/80">{compact(run.stats?.tokens_out ?? 0)}</span>↑
        </span>
        <span className="hidden xl:inline" title={run.id || "no run yet"}>
          #{shortId(run.id)}
        </span>
      </div>

      {run.title && <div className="hidden min-w-0 flex-1 truncate text-center text-[12.5px] text-muted 2xl:block">{run.title}</div>}

      <div className="ml-auto flex items-center gap-1.5">
        <button className="btn btn-accent btn-sm" disabled={run.status !== "idle" || !draft.trim() || conn === "unauthorized"} onClick={() => chat(draft)} title="Run (sends the composer)">
          <Play className="h-3.5 w-3.5" /> <span className="hidden sm:inline">RUN</span>
        </button>
        {run.status === "paused" ? (
          <button className="btn btn-warn btn-sm" onClick={() => control("resume")} title="Resume">
            <Play className="h-3.5 w-3.5" /> <span className="hidden sm:inline">RESUME</span>
          </button>
        ) : (
          <button className="btn btn-sm" disabled={run.status !== "running" || awaiting} onClick={() => control("pause")} title="Pause">
            <Pause className="h-3.5 w-3.5" /> <span className="hidden sm:inline">PAUSE</span>
          </button>
        )}
        <button className="btn btn-err btn-sm" disabled={run.status === "idle"} onClick={() => control("stop")} title="Stop (Esc)">
          <Square className="h-3 w-3" /> <span className="hidden sm:inline">STOP</span>
        </button>
        <Tooltip label={dock ? "Hide dock" : "Show dock"} side="bottom">
          <button className="btn btn-ghost btn-sm ml-1 w-8 px-0" onClick={() => setUi({ dock: !dock })} aria-label="Toggle dock">
            {dock ? <PanelRightClose className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
          </button>
        </Tooltip>
      </div>
    </header>
  );
}

// -------------------------------------------------------------------- rail
export function Rail({ narrow }: { narrow: boolean }) {
  const view = useStore((s) => s.ui.view);
  const collapsed = useStore((s) => s.ui.sidebar_collapsed) || narrow;
  const setView = useStore((s) => s.setView);
  const setUi = useStore((s) => s.setUi);
  const awaiting = useStore((s) => Boolean(s.run.current_interrupt && !s.run.interrupt_outcome && s.run.status !== "idle"));
  const runningTasks = useStore((s) => s.run.tasks.filter((t) => t.status === "running").length);
  const todosLeft = useStore((s) => s.run.todos.filter((t) => t.status !== "completed").length);
  const memDirty = useStore((s) => Object.keys(s.mem.drafts).length);
  const mcpErr = useStore((s) => s.mcp.filter((m) => m.status === "error").length);

  const badge: Partial<Record<View, { n?: number; tone: "warn" | "accent" | "info" | "err" }>> = {
    chat: awaiting ? { tone: "warn" } : undefined,
    agents: runningTasks ? { n: runningTasks, tone: "info" } : undefined,
    tasks: todosLeft ? { n: todosLeft, tone: "accent" } : undefined,
    memory: memDirty ? { tone: "warn" } : undefined,
    toolkit: mcpErr ? { n: mcpErr, tone: "err" } : undefined,
  };

  return (
    <nav className={cx("flex shrink-0 flex-col border-r border-border bg-panel py-2 transition-[width] duration-150", collapsed ? "w-16" : "w-[184px]")} aria-label="Views">
      <div className="flex-1 space-y-0.5 px-2">
        {NAV.map((n) => {
          const active = view === n.view;
          const b = badge[n.view];
          const button = (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              aria-current={active ? "page" : undefined}
              aria-label={n.label}
              className={cx(
                "relative flex h-10 w-full items-center gap-3 rounded-card text-[13px] transition-colors",
                collapsed ? "justify-center" : "px-3",
                active ? "bg-accent/10 text-accent" : "text-muted hover:bg-panel-hi hover:text-text",
              )}
            >
              {active && <span className="absolute -left-2 top-2 h-6 w-[3px] rounded-r bg-accent" />}
              <span className="relative [&>svg]:h-[18px] [&>svg]:w-[18px]">
                {n.icon}
                {b && (
                  <span
                    className={cx(
                      "absolute -right-2 -top-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 font-mono text-[9.5px] font-bold text-bg",
                      b.tone === "warn" ? "bg-warn" : b.tone === "info" ? "bg-info text-white" : b.tone === "err" ? "bg-err" : "bg-accent",
                      b.n === undefined && "h-2 min-w-2 animate-pulsedot px-0",
                    )}
                  >
                    {b.n}
                  </span>
                )}
              </span>
              {!collapsed && <span className="truncate font-medium">{n.label}</span>}
            </button>
          );
          return collapsed ? (
            <Tooltip key={n.view} label={n.label} block>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
      {!narrow && (
        <div className="px-2">
          <button
            className={cx("flex h-9 w-full items-center gap-3 rounded-card text-[12px] text-muted hover:bg-panel-hi hover:text-text", collapsed ? "justify-center" : "px-3")}
            onClick={() => setUi({ sidebar_collapsed: !collapsed })}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      )}
    </nav>
  );
}

// -------------------------------------------------------------------- dock
export function Dock({ overlay }: { overlay: boolean }) {
  const tab = useStore((s) => s.ui.dock_tab);
  const setUi = useStore((s) => s.setUi);
  const tabs: { id: DockTab; label: string }[] = [
    { id: "tasks", label: "Tasks" },
    { id: "agents", label: "Agents" },
    { id: "console", label: "Console" },
  ];
  return (
    <aside
      className={cx(
        "flex w-[380px] max-w-[92vw] shrink-0 flex-col border-l border-border bg-panel",
        overlay && "absolute bottom-0 right-0 top-0 z-40 shadow-2xl",
      )}
      aria-label="Dock"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setUi({ dock_tab: t.id })}
            className={cx(
              "h-7 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors",
              tab === t.id ? "bg-panel-hi text-text" : "text-muted hover:text-text",
            )}
          >
            {t.label}
          </button>
        ))}
        {overlay && (
          <button className="btn btn-ghost btn-sm ml-auto w-7 px-0" onClick={() => setUi({ dock: false })} aria-label="Close dock">
            <PanelRightClose className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "tasks" && <TasksPanel compact />}
        {tab === "agents" && <AgentsPanel compact />}
        {tab === "console" && <ConsolePanel compact />}
      </div>
      <StatsFooter />
    </aside>
  );
}

function StatsFooter() {
  const stats = useStore((s) => s.run.stats);
  const lastRun = useStore((s) => s.run.last_run_ms);
  const lastTool = useStore((s) => s.run.last_tool_duration);
  const status = useStore((s) => s.run.status);
  const now = useStore((s) => s.run.now);
  const tin = stats?.tokens_in ?? 0;
  const tout = stats?.tokens_out ?? 0;
  const scale = Math.max(tin, tout, 1);
  const current = stats && status !== "idle" ? now - stats.started_at : null;
  return (
    <div className="shrink-0 space-y-2 border-t border-border px-3.5 py-3">
      <div className="section-title">tokens</div>
      <Bar label="in" value={tin} pct={(tin / scale) * 100} className="bg-accent" />
      <Bar label="out" value={tout} pct={(tout / scale) * 100} className="bg-info" />
      <div className="flex justify-between pt-1 font-mono text-[11px] text-muted">
        <span>{current !== null ? `running ${duration(current)}` : `last run ${lastRun !== null ? duration(lastRun) : "–"}`}</span>
        <span>last tool {lastTool !== null ? duration(lastTool) : "–"}</span>
      </div>
    </div>
  );
}

function Bar({ label, value, pct, className }: { label: string; value: number; pct: number; className: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 font-mono text-[11px] text-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
        <div className={cx("h-full rounded-full transition-all duration-700", className)} style={{ width: `${Math.max(pct, value ? 2 : 0)}%` }} />
      </div>
      <span className="w-14 text-right font-mono text-[11px] tabular-nums text-text/80">{value.toLocaleString()}</span>
    </div>
  );
}
