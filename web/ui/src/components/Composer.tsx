import { CornerDownLeft, FolderGit2, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { cx } from "./ui";

const MAX_ROWS = 12;
const LINE = 20; // px, matches leading-[20px]

export function Composer() {
  const status = useStore((s) => s.run.status);
  const conn = useStore((s) => s.connection.status);
  const chat = useStore((s) => s.chat);
  const control = useStore((s) => s.control);
  const focusTick = useStore((s) => s.ui.composer_focus);
  const project = useStore((s) => s.run.project);
  const setProject = useStore((s) => s.setProject);
  const projects = useStore((s) => s.connection.hello?.projects);
  const hasMessages = useStore((s) => s.run.order.length > 0);
  const text = useStore((s) => s.ui.draft);
  const setUi = useStore((s) => s.setUi);
  const setText = (t: string) => setUi({ draft: t });
  const [editingProject, setEditingProject] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const idle = status === "idle";

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * LINE + 20)}px`;
  }, [text]);

  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    if (idle) ref.current?.focus();
  }, [idle]);

  const submit = () => {
    if (!idle || !text.trim()) return;
    chat(text);
  };

  return (
    <div className="border-t border-border bg-bg/95 px-4 pb-3 pt-3 backdrop-blur md:px-6">
      <div className="mx-auto max-w-[920px]">
        <div
          className={cx(
            "flex items-end gap-2 rounded-[10px] border bg-panel px-3 py-2 transition-colors",
            idle ? "border-border focus-within:border-accent/60" : "border-border/60",
          )}
        >
          <textarea
            ref={ref}
            value={text}
            disabled={!idle}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={idle ? (hasMessages ? "Reply to HQ…" : "Ask HQ to build, fix, research or review something…") : "agent is working..."}
            className="max-h-[260px] min-h-[24px] flex-1 resize-none bg-transparent py-0.5 font-mono text-[13px] leading-[20px] text-text placeholder:text-muted/70 focus:outline-none disabled:cursor-not-allowed"
            aria-label="Message"
          />
          {idle ? (
            <button className="btn btn-accent h-8 w-8 shrink-0 px-0" onClick={submit} disabled={!text.trim()} aria-label="Send">
              <CornerDownLeft className="h-4 w-4" />
            </button>
          ) : (
            <button className="btn btn-err h-8 w-8 shrink-0 px-0" onClick={() => control("stop")} aria-label="Stop">
              <Square className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted">
          <span>
            <span className="kbd">Enter</span> send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> newline ·{" "}
            <span className="kbd">Esc</span> stop · <span className="kbd">Ctrl</span>+<span className="kbd">K</span> focus
          </span>
          {conn !== "open" && <span className="text-warn">offline: messages queue until reconnect</span>}
          <span className="ml-auto flex items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5" />
            {editingProject ? (
              <>
                <input
                  autoFocus
                  list="hq-projects"
                  defaultValue={project}
                  className="h-6 w-36 rounded-[5px] border border-border bg-bg px-1.5 font-mono text-[11px] text-text focus:border-accent/60 focus:outline-none"
                  onBlur={(e) => {
                    setProject(e.target.value);
                    setEditingProject(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingProject(false);
                  }}
                  aria-label="Project"
                />
                <datalist id="hq-projects">{projects?.map((p) => <option key={p} value={p} />)}</datalist>
              </>
            ) : (
              <button
                className="font-mono text-muted hover:text-accent disabled:hover:text-muted"
                title="Sandbox project for this chat (each project has its own workspace)"
                disabled={!idle || hasMessages}
                onClick={() => setEditingProject(true)}
              >
                project: <span className="text-text">{project}</span>
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
