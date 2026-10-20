import { History, MessageSquare, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Empty, Spinner, ViewHeader, cx } from "../components/ui";
import { relTime, shortId } from "../lib/format";
import { deleteHistory, openHistory, refreshHistory } from "../lib/history";
import { useStore } from "../store";

export function HistoryView() {
  const history = useStore((s) => s.history);
  const current = useStore((s) => s.run.id);
  const status = useStore((s) => s.run.status);
  const parallel = useStore((s) => Boolean(s.connection.hello?.features?.includes("parallel-chats")));
  const newChat = useStore((s) => s.newChat);
  const conn = useStore((s) => s.connection.status);
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (conn === "open") void refreshHistory();
  }, [conn]);

  const runs = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? history.runs.filter((r) => r.title.toLowerCase().includes(needle) || r.id.includes(needle)) : history.runs;
  }, [history.runs, q]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        icon={<History />}
        title="History"
        subtitle={`${history.runs.length} chats`}
        right={
          <>
            <button className="btn btn-sm" onClick={() => void refreshHistory()} disabled={history.loading}>
              {history.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} refresh
            </button>
            <button className="btn btn-accent btn-sm" onClick={newChat} disabled={status !== "idle" && !parallel}>
              <Plus className="h-3.5 w-3.5" /> new chat
            </button>
          </>
        }
      />
      <div className="border-b border-border px-5 py-2.5">
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted" />
          <input className="input pl-8" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {history.error ? (
          <Empty icon={<History />} title="Couldn't load history" hint={history.error} action={<button className="btn btn-sm" onClick={() => void refreshHistory()}>retry</button>} />
        ) : !history.loaded && history.loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-muted">
            <Spinner /> loading
          </div>
        ) : runs.length === 0 ? (
          <Empty icon={<MessageSquare />} title={q ? "No chats match" : "No chats yet"} hint={q ? "Try another search." : "Your conversations with HQ show up here."} />
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.id} className={cx("group flex items-center gap-3 px-5 py-3 hover:bg-panel", current === r.id && "bg-accent/[0.05]")}>
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void openHistory(r.id)}>
                  <MessageSquare className={cx("h-4 w-4 shrink-0", current === r.id ? "text-accent" : "text-muted")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-text">{r.title || "Untitled chat"}</div>
                    <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                      <span>{relTime(r.updated_at)}</span>
                      <span>#{shortId(r.id)}</span>
                      {r.project && r.project !== "default" && <span>project: {r.project}</span>}
                      {r.status === "approval" && <span className="text-warn">waiting for approval</span>}
                      {r.status === "running" && <span className="text-accent">working</span>}
                    </div>
                  </div>
                </button>
                {confirm === r.id ? (
                  <div className="flex items-center gap-1.5">
                    <button className="btn btn-err btn-sm" onClick={() => void deleteHistory(r.id).then(() => setConfirm(null))}>
                      delete
                    </button>
                    <button className="btn btn-sm" onClick={() => setConfirm(null)}>
                      cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm w-8 px-0 text-muted opacity-0 hover:text-err group-hover:opacity-100"
                    onClick={() => setConfirm(r.id)}
                    aria-label="Delete chat"
                    disabled={current === r.id && status !== "idle"}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
