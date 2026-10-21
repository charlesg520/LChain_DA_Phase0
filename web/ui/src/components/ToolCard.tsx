import { Bot, ChevronDown, ChevronRight, CircleCheck, CircleX, Clock, ShieldAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { argsSummary, clampLines, duration } from "../lib/format";
import { langFor } from "../lib/highlight";
import { useStore } from "../store";
import type { Message, ToolCall } from "../types";
import { CodeView, JsonBlock } from "./Code";
import { DecisionRow } from "./InterruptCard";
import { Markdown } from "./Markdown";
import { CopyButton, Spinner, Tag, cx } from "./ui";

type Status = "running" | "ok" | "error" | "approval" | "pending";

const MAX_LINES = 40;

export const ToolCard = memo(function ToolCard({ call, result }: { call: ToolCall; result?: Message }) {
  const runStatus = useStore((s) => s.run.status);
  const times = useStore((s) => s.run.tool_times[call.id]);
  const now = useStore((s) => s.run.now);
  const intr = useStore((s) => s.run.current_interrupt);
  const outcome = useStore((s) => s.run.interrupt_outcome);
  const task = useStore((s) => (call.name === "task" ? s.run.tasks.find((t) => t.id === call.id) : undefined));
  const decision = useStore((s) => s.run.decisions.find((d) => d.tool === call.name && sameArgs(d.args, call.args)));
  const setView = useStore((s) => s.setView);
  const setUi = useStore((s) => s.setUi);

  const awaiting = !result && intr && !outcome && intr.tool === call.name && sameArgs(intr.args, call.args);
  const status: Status = result
    ? result.status === "error" || /^(error|Error:)/.test(result.content)
      ? "error"
      : "ok"
    : awaiting
      ? "approval"
      : runStatus === "idle"
        ? "pending"
        : "running";
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const expanded = open || status === "approval";

  const elapsed = times ? (times.end ?? (status === "running" ? now : times.start)) - times.start : null;
  const fileLang = langFor(String(call.args.file_path ?? call.args.path ?? call.args.file ?? ""));
  const resultText = result?.content ?? "";
  const clipped = useMemo(() => (full ? { text: resultText, clipped: 0 } : clampLines(resultText, MAX_LINES)), [resultText, full]);

  return (
    <div
      className={cx(
        "overflow-hidden rounded-card border bg-panel transition-colors",
        status === "error" ? "border-err/35" : status === "approval" ? "border-warn/45" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-9 w-full items-center gap-2 px-2.5 text-left hover:bg-panel-hi"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />}
        <StatusIcon status={status} />
        <span className="shrink-0 font-mono text-[12.5px] font-medium text-text">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{argsSummary(call.args)}</span>
        {call.name === "task" && task && (
          <Tag tone={task.status === "running" ? "info" : task.status === "error" ? "err" : "ok"}>
            <Bot className="h-3 w-3" />
            {task.agent}
          </Tag>
        )}
        {status === "approval" && <Tag tone="warn">awaiting approval</Tag>}
        {elapsed !== null && status !== "pending" && status !== "approval" && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{duration(elapsed)}</span>
        )}
      </button>
      {decision && status !== "approval" && <DecisionRow outcome={decision} inline />}
      {expanded && (
        <div className="space-y-2.5 border-t border-border bg-[#0d121a] p-2.5">
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">arguments</div>
            <JsonBlock value={call.args} maxHeight={260} />
          </div>
          {call.name === "task" && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setUi({ expanded_agent: call.id });
                setView("agents");
              }}
            >
              <Bot className="h-3.5 w-3.5" /> watch sub-agent
            </button>
          )}
          {result ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">result</span>
                <CopyButton text={resultText} />
              </div>
              {call.name === "task" ? (
                <div className="rounded-card border border-border bg-panel px-3 py-2">
                  <Markdown text={resultText} />
                </div>
              ) : (
                <div className="rounded-card border border-border bg-[#0a0e15]">
                  <CodeView
                    code={clipped.text || "(empty)"}
                    lang={call.name === "read_file" ? fileLang : "text"}
                    numbers={call.name === "read_file"}
                    className="py-2"
                    maxHeight={420}
                  />
                  {clipped.clipped > 0 && (
                    <button className="w-full border-t border-border py-1.5 text-[11.5px] text-accent hover:bg-panel-hi" onClick={() => setFull(true)}>
                      show {clipped.clipped} more lines
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-[12px] text-muted">
              {status === "approval" ? "Paused until you decide below." : status === "pending" ? "No result (the run ended first)." : "Running…"}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function StatusIcon({ status }: { status: Status }) {
  if (status === "running") return <Spinner className="shrink-0 text-accent" />;
  if (status === "ok") return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" />;
  if (status === "error") return <CircleX className="h-3.5 w-3.5 shrink-0 text-err" />;
  if (status === "approval") return <ShieldAlert className="h-3.5 w-3.5 shrink-0 animate-pulsedot text-warn" />;
  return <Clock className="h-3.5 w-3.5 shrink-0 text-muted" />;
}

function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
