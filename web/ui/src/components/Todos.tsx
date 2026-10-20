import { CircleCheck, CircleDashed, ListChecks, LoaderCircle } from "lucide-react";
import type { Todo } from "../types";
import { cx } from "./ui";

export function TodoIcon({ status, className }: { status: Todo["status"]; className?: string }) {
  if (status === "completed") return <CircleCheck className={cx("h-4 w-4 shrink-0 text-ok", className)} />;
  if (status === "in_progress") return <LoaderCircle className={cx("h-4 w-4 shrink-0 animate-spin text-accent", className)} />;
  return <CircleDashed className={cx("h-4 w-4 shrink-0 text-muted/70", className)} />;
}

export function progress(todos: Todo[]) {
  const done = todos.filter((t) => t.status === "completed").length;
  return { done, total: todos.length, pct: todos.length ? Math.round((done / todos.length) * 100) : 0 };
}

/** Compact plan card shown after the latest assistant message. */
export function TodosCard({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const p = progress(todos);
  return (
    <div className="sticky bottom-2 z-10 rounded-card border border-border bg-panel/95 px-3 py-2.5 shadow-lg backdrop-blur">
      <div className="mb-1.5 flex items-center gap-2">
        <ListChecks className="h-3.5 w-3.5 text-accent" />
        <span className="section-title">plan</span>
        <span className="ml-auto font-mono text-[11px] text-muted">
          {p.done}/{p.total}
        </span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${p.pct}%` }} />
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px]">
            <TodoIcon status={t.status} className="mt-px h-3.5 w-3.5" />
            <span className={cx(t.status === "completed" && "text-muted line-through decoration-muted/50", t.status === "in_progress" && "text-text")}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
