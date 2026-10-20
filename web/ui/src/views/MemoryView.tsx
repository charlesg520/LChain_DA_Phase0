import { Brain, RotateCcw, Save } from "lucide-react";
import { useEffect } from "react";
import { Empty, Spinner, ViewHeader, cx } from "../components/ui";
import { useStore } from "../store";

export function MemoryView() {
  const mem = useStore((s) => s.mem);
  const setDraft = useStore((s) => s.setDraft);
  const setActive = useStore((s) => s.setMemActive);
  const save = useStore((s) => s.saveMemory);
  const send = useStore((s) => s.send);
  const conn = useStore((s) => s.connection.status);

  useEffect(() => {
    if (conn === "open") send({ type: "memory" });
  }, [conn, send]);

  const active = mem.active ?? mem.files[0]?.path ?? null;
  const file = mem.files.find((f) => f.path === active);
  const value = active && active in mem.drafts ? mem.drafts[active] : file?.content ?? "";
  const dirty = Boolean(active && active in mem.drafts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && active && dirty) {
        e.preventDefault();
        save(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, dirty, save]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        icon={<Brain />}
        title="Memory"
        subtitle="Loaded into every conversation. Keep it short and true."
        right={
          active && (
            <>
              <button className="btn btn-sm" disabled={!dirty} onClick={() => file && setDraft(active, file.content)}>
                <RotateCcw className="h-3.5 w-3.5" /> revert
              </button>
              <button className="btn btn-accent btn-sm" disabled={!dirty || mem.saving === active} onClick={() => save(active)}>
                {mem.saving === active ? <Spinner /> : <Save className="h-3.5 w-3.5" />} save
                <span className="kbd ml-1 hidden sm:inline">Ctrl+S</span>
              </button>
            </>
          )
        }
      />
      {mem.files.length === 0 ? (
        <Empty icon={<Brain />} title="No memory files" hint="HQ writes durable notes (your preferences, project conventions, decisions) to /memories/." />
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border px-3" role="tablist">
            {mem.files.map((f) => {
              const d = f.path in mem.drafts;
              return (
                <button
                  key={f.path}
                  role="tab"
                  aria-selected={f.path === active}
                  onClick={() => setActive(f.path)}
                  className={cx(
                    "-mb-px flex h-9 items-center gap-2 rounded-t-[7px] border px-3 font-mono text-[12px]",
                    f.path === active ? "border-border border-b-bg bg-bg text-text" : "border-transparent text-muted hover:text-text",
                  )}
                >
                  {f.path.replace(/^\//, "")}
                  {d && <span className="h-1.5 w-1.5 rounded-full bg-warn" title="unsaved changes" />}
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 p-4">
            <textarea
              className="textarea h-full resize-none text-[13px] leading-[1.65]"
              value={value}
              onChange={(e) => active && setDraft(active, e.target.value)}
              spellCheck={false}
              aria-label={`Edit ${active}`}
            />
          </div>
        </>
      )}
    </div>
  );
}
