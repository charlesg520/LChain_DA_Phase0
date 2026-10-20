import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Markdown } from "../components/Markdown";
import { MessageRow } from "../components/MessageRow";
import { Empty, Spinner, Tag, ViewHeader, cx } from "../components/ui";
import { duration } from "../lib/format";
import { useStore } from "../store";
import type { Subtask } from "../types";

export function AgentsPanel({ compact }: { compact?: boolean }) {
  const tasks = useStore((s) => s.run.tasks);
  if (!tasks.length) {
    return <Empty icon={<Bot />} title="No sub-agents yet" hint="When HQ delegates to the coder, reviewer or researcher, each one shows up here with its live stream." />;
  }
  return (
    <div className={cx("h-full space-y-2 overflow-y-auto", compact ? "p-3" : "p-5")}>
      {tasks.map((t) => (
        <AgentRow key={t.id} t={t} compact={compact} />
      ))}
    </div>
  );
}

function AgentRow({ t, compact }: { t: Subtask; compact?: boolean }) {
  const expanded = useStore((s) => s.ui.expanded_agent === t.id);
  const setUi = useStore((s) => s.setUi);
  const now = useStore((s) => s.run.now);
  const messages = useStore((s) => s.run.messages);
  const streaming = useStore((s) => s.run.streaming);
  const inner = useMemo(() => messages.filter((m) => m.subagent_id === t.id), [messages, t.id]);
  const innerCalls = useMemo(() => {
    const ids = new Set<string>();
    for (const m of inner) for (const c of m.tool_calls || []) ids.add(c.id);
    return ids;
  }, [inner]);
  const flow = inner.filter((m) => !(m.role === "tool" && m.tool_call_id && innerCalls.has(m.tool_call_id)));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded && t.status === "running") end.current?.scrollIntoView({ block: "nearest" });
  }, [expanded, inner.length, t.status]);

  const took = (t.ended_at ?? now) - t.started_at;
  const tone = t.status === "running" ? "info" : t.status === "error" ? "err" : "ok";
  return (
    <div className={cx("overflow-hidden rounded-card border bg-panel", t.status === "running" ? "border-info/50" : "border-border")}>
      <button className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-panel-hi" onClick={() => setUi({ expanded_agent: expanded ? null : t.id })} aria-expanded={expanded}>
        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className={cx("text-[13px] text-text", !expanded && "line-clamp-2")}>{t.description}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Tag tone="info">
              <Bot className="h-3 w-3" /> {t.agent}
            </Tag>
            <Tag tone={tone}>
              {t.status === "running" && <Spinner className="h-3 w-3" />}
              {t.status}
            </Tag>
            <span className="font-mono text-[11px] text-muted">
              {t.status === "running" ? `running ${duration(took)}` : `took ${duration(took)}`} · {inner.length} msgs
            </span>
          </div>
        </div>
      </button>
      {(t.report || t.error) && !expanded && (
        <div className={cx("border-t border-border px-3 py-2 text-[12.5px]", t.error ? "text-err" : "text-muted")}>
          <div className={compact ? "line-clamp-3" : "line-clamp-4"}>{t.error || t.report}</div>
        </div>
      )}
      {expanded && (
        <div className="space-y-4 border-t border-border bg-[#0d121a] px-3 py-3">
          {flow.length === 0 && <div className="flex items-center gap-2 text-[12px] text-muted">{t.status === "running" ? <><Spinner /> waiting for the sub-agent's first message…</> : "No messages were captured for this sub-agent."}</div>}
          {flow.map((m) => (
            <MessageRow key={m.id} m={m} messages={inner} streaming={streaming === m.id} />
          ))}
          {(t.report || t.error) && (
            <div className={cx("rounded-card border px-3 py-2.5", t.error ? "border-err/40 bg-err/[0.05]" : "border-ok/30 bg-ok/[0.04]")}>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">{t.error ? "error" : "report"}</div>
              <Markdown text={t.error || t.report || ""} />
            </div>
          )}
          <div ref={end} />
        </div>
      )}
    </div>
  );
}

export function AgentsView() {
  const tasks = useStore((s) => s.run.tasks);
  const running = tasks.filter((t) => t.status === "running").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader icon={<Bot />} title="Sub-agents" subtitle={tasks.length ? `${tasks.length} delegated · ${running} running` : "delegated work, streamed live"} />
      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1">
        <AgentsPanel />
      </div>
    </div>
  );
}
