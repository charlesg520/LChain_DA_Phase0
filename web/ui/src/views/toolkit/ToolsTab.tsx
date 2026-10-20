import { ChevronDown, ChevronRight, Hammer, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { JsonBlock } from "../../components/Code";
import { Empty, Tag, cx } from "../../components/ui";
import { invocationCounts, useStore } from "../../store";

export function ToolsTab() {
  const tools = useStore((s) => s.tools);
  const messages = useStore((s) => s.run.messages);
  const counts = useMemo(() => invocationCounts(messages), [messages]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? tools.filter((t) => `${t.name} ${t.description} ${t.source ?? ""}`.toLowerCase().includes(n)) : tools;
  }, [tools, q]);
  const groups = useMemo(() => {
    const g: Record<string, typeof filtered> = {};
    for (const t of filtered) (g[t.source || "tools"] ||= []).push(t);
    return Object.entries(g);
  }, [filtered]);

  if (!tools.length) return <Empty icon={<Hammer />} title="No tools reported" hint="The tool registry arrives from the server after connecting." />;
  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted" />
        <input className="input pl-8" placeholder={`Search ${tools.length} tools`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.map(([group, list]) => (
        <div key={group}>
          {groups.length > 1 && <div className="section-title mb-1.5">{group}</div>}
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {list.map((t) => {
              const n = counts[t.name] || 0;
              const expanded = open === t.name;
              return (
                <div key={t.name} className="bg-panel">
                  <button className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-panel-hi" onClick={() => setOpen(expanded ? null : t.name)} aria-expanded={expanded}>
                    {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[12.5px] font-semibold text-text">{t.name}</span>
                        {t.approval && (
                          <Tag tone="warn" title="Pauses for your approval">
                            <ShieldAlert className="h-3 w-3" /> approval
                          </Tag>
                        )}
                        {(t.agents || []).map((a) => (
                          <Tag key={a} tone={a === "orchestrator" ? "accent" : "info"}>
                            {a}
                          </Tag>
                        ))}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{t.description}</div>
                    </div>
                    <span
                      className={cx("shrink-0 rounded-[5px] px-1.5 py-0.5 font-mono text-[11px] tabular-nums", n ? "bg-accent/15 text-accent" : "text-muted/60")}
                      title="calls in the current run"
                    >
                      {n}×
                    </span>
                  </button>
                  {expanded && (
                    <div className="border-t border-border bg-[#0d121a] p-2.5">
                      <JsonBlock value={t.schema} maxHeight={360} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
