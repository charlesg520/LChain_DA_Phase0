import { Bot, Brain, ChevronDown, ChevronRight, Info, User, Wrench } from "lucide-react";
import { memo, useState } from "react";
import { clock, compact } from "../lib/format";
import { resultFor, useStore } from "../store";
import type { Message } from "../types";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { CopyButton, Tag, cx } from "./ui";

/**
 * One message. Tool results are rendered inside the ToolCard of the call they
 * answer (matched by tool_call_id); `messages` is the list to search for them.
 */
export const MessageRow = memo(function MessageRow({ m, messages, streaming }: { m: Message; messages: Message[]; streaming: boolean }) {
  if (m.role === "user") return <UserRow m={m} />;
  if (m.role === "system") {
    const stopped = m.content.startsWith("Run stopped:");
    return (
      <div className={cx("flex items-start justify-center gap-2 py-1 text-[12px]", stopped ? "text-warn" : "text-muted")}>
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="max-w-[80%] text-center">{m.content}</span>
      </div>
    );
  }
  if (m.role === "tool") return <OrphanToolRow m={m} />;
  return <AssistantRow m={m} messages={messages} streaming={streaming} />;
});

function UserRow({ m }: { m: Message }) {
  return (
    <div className="group flex justify-end">
      <div className="max-w-[min(680px,85%)]">
        <div className="whitespace-pre-wrap break-words rounded-[12px] rounded-br-[4px] border border-accent/25 bg-accent/[0.09] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-text">
          {m.content}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
          <span className="font-mono">{clock(m.ts)}</span>
          <CopyButton text={m.content} />
          <User className="h-3 w-3" />
        </div>
      </div>
    </div>
  );
}

function AssistantRow({ m, messages, streaming }: { m: Message; messages: Message[]; streaming: boolean }) {
  const sub = Boolean(m.subagent_id);
  const agentName = useStore((s) => (m.subagent_id ? s.run.tasks.find((t) => t.id === m.subagent_id)?.agent : undefined));
  const [thinkOpen, setThinkOpen] = useState(false);
  const hasText = m.content.trim().length > 0;
  const calls = m.tool_calls || [];
  if (!hasText && !calls.length && !m.thinking && !streaming) return null;
  return (
    <div className={cx("group flex gap-3", sub && "opacity-80")}>
      <div
        className={cx(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border",
          sub ? "border-info/50 bg-info/10 text-[#b9a4ff]" : "border-accent/40 bg-accent/10 text-accent",
        )}
      >
        {sub ? <Bot className="h-3.5 w-3.5" /> : <span className="font-mono text-[10px] font-bold">HQ</span>}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {sub && (
          <div className="flex items-center gap-1.5">
            <Tag tone="info">sub-agent</Tag>
            {agentName && <span className="font-mono text-[11px] text-muted">{agentName}</span>}
          </div>
        )}
        {m.thinking && (
          <div className="rounded-card border border-border/70 bg-panel/60">
            <button className="flex h-7 w-full items-center gap-1.5 px-2 text-[11.5px] text-muted hover:text-text" onClick={() => setThinkOpen(!thinkOpen)}>
              {thinkOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Brain className="h-3 w-3" /> reasoning
            </button>
            {thinkOpen && <div className="whitespace-pre-wrap border-t border-border/70 px-3 py-2 text-[12px] italic text-muted">{m.thinking}</div>}
          </div>
        )}
        {(hasText || (streaming && !calls.length)) && (
          <Markdown text={m.content || ""} streaming={streaming} className={cx(!hasText && "cursor h-5")} />
        )}
        {calls.length > 0 && (
          <div className="space-y-1.5">
            {calls.map((c) => (
              <ToolCard key={c.id} call={c} result={resultFor(messages, c.id)} />
            ))}
          </div>
        )}
        <div className="-mt-1 flex h-4 items-center gap-2 text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
          <span className="font-mono">{clock(m.ts)}</span>
          {m.usage && (
            <span className="font-mono">
              {compact(m.usage.input_tokens)} in · {compact(m.usage.output_tokens)} out
            </span>
          )}
          {hasText && <CopyButton text={m.content} />}
        </div>
      </div>
    </div>
  );
}

function OrphanToolRow({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ml-9">
      <button className="flex items-center gap-1.5 text-[12px] text-muted hover:text-text" onClick={() => setOpen(!open)}>
        <Wrench className="h-3.5 w-3.5" />
        <span className="font-mono">{m.name || "tool"}</span> result
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && <pre className="mt-1 max-h-72 overflow-auto rounded-card border border-border bg-[#0a0e15] p-2.5 font-mono text-[12px]">{m.content}</pre>}
    </div>
  );
}
