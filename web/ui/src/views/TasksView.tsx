import { ListChecks } from "lucide-react";
import { TodoIcon, progress } from "../components/Todos";
import { Empty, ViewHeader, cx } from "../components/ui";
import { useStore } from "../store";

export function TasksPanel({ compact }: { compact?: boolean }) {
  const todos = useStore((s) => s.run.todos);
  const p = progress(todos);
  if (!todos.length) {
    return <Empty icon={<ListChecks />} title="No plan yet" hint="When HQ breaks work into steps, the checklist shows up here and updates live." />;
  }
  return (
    <div className={cx("flex h-full min-h-0 flex-col", compact ? "p-3" : "p-5")}>
      <div className="mb-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${p.pct}%` }} />
        </div>
        <span className="font-mono text-[11.5px] tabular-nums text-muted">
          {p.pct}% · {p.done}/{p.total}
        </span>
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto font-mono">
        {todos.map((t, i) => (
          <li
            key={i}
            className={cx(
              "flex items-start gap-2.5 rounded-card border px-3 py-2 text-[12.5px]",
              t.status === "in_progress" ? "border-accent/40 bg-accent/[0.06]" : "border-border bg-panel",
            )}
          >
            <TodoIcon status={t.status} className="mt-px" />
            <span
              className={cx(
                "flex-1",
                t.status === "completed" && "text-muted line-through decoration-muted/60",
                t.status === "in_progress" && "text-accent",
                t.status === "pending" && "text-text/80",
              )}
            >
              {t.content}
            </span>
            <span className={cx("text-[10.5px] uppercase tracking-wide", t.status === "completed" ? "text-ok" : t.status === "in_progress" ? "text-accent" : "text-muted")}>
              {t.status.replace("_", " ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TasksView() {
  const todos = useStore((s) => s.run.todos);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader icon={<ListChecks />} title="Tasks" subtitle={todos.length ? "HQ's plan for the current run" : "plan checklist"} />
      <div className="mx-auto min-h-0 w-full max-w-3xl flex-1">
        <TasksPanel />
      </div>
    </div>
  );
}
