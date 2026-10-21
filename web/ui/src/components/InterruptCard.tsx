import { CircleCheck, CircleX, PencilLine, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { pretty } from "../lib/format";
import { useStore, type InterruptOutcome } from "../store";
import { JsonBlock } from "./Code";
import { Tag, cx } from "./ui";

/**
 * The collapsed form of an approval once you've answered it: icon, tool, outcome
 * badge and your note. Shown in place of the card, and kept on the tool's card in
 * the transcript afterwards.
 */
export function DecisionRow({ outcome, inline }: { outcome: Pick<InterruptOutcome, "tool" | "action" | "edited" | "note">; inline?: boolean }) {
  const approved = outcome.action === "approve";
  const label = approved ? (outcome.edited ? "approved with edits" : "approved") : "rejected";
  return (
    <div
      data-decision={label}
      className={cx(
        "flex min-w-0 items-center gap-2 text-[12.5px]",
        inline ? "border-t border-info/25 bg-info/[0.05] px-2.5 py-1.5" : "rounded-card border border-info/40 bg-info/[0.06] px-3 py-2",
      )}
    >
      {approved ? <CircleCheck className="h-4 w-4 shrink-0 text-ok" /> : <CircleX className="h-4 w-4 shrink-0 text-err" />}
      <span className="shrink-0 font-mono text-text">{outcome.tool}</span>
      <Tag tone={approved ? "ok" : "err"}>{label}</Tag>
      {outcome.note && <span className="min-w-0 truncate text-muted" title={outcome.note}>“{outcome.note}”</span>}
    </div>
  );
}

/** Human-in-the-loop approval, pinned at the tail of the stream. */
export function InterruptCard() {
  const intr = useStore((s) => s.run.current_interrupt);
  const outcome = useStore((s) => s.run.interrupt_outcome);
  const queued = useStore((s) => s.run.queued_interrupts.length);
  const hitlNote = useStore((s) => s.settings.hitl_note);
  const decide = useStore((s) => s.decide);

  const original = useMemo(() => (intr ? pretty(intr.args) : ""), [intr]);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState(original);
  const [note, setNote] = useState("");

  useEffect(() => {
    setDraft(original);
    setEdit(false);
    setNote("");
  }, [original, intr?.interrupt_id]);

  if (!intr) return null;

  if (outcome && outcome.interrupt_id === intr.interrupt_id) return <DecisionRow outcome={outcome} />;

  let parsed: Record<string, unknown> | null = null;
  let parseError = "";
  try {
    const v = JSON.parse(draft);
    if (v && typeof v === "object" && !Array.isArray(v)) parsed = v;
    else parseError = "arguments must be a JSON object";
  } catch (e) {
    parseError = (e as Error).message;
  }
  const changed = edit && draft.trim() !== original.trim();
  const canEditApprove = changed && parsed !== null;
  const noteValue = note.trim() || undefined;

  return (
    <div className="animate-slidein overflow-hidden rounded-card border border-info/60 bg-gradient-to-b from-info/[0.09] to-transparent shadow-[0_0_0_1px_rgb(var(--info)/0.12)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-info/30 px-3.5 py-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
        </span>
        <ShieldAlert className="h-4 w-4 text-warn" />
        <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text">approval required</span>
        <Tag tone="info" className="font-semibold">
          {intr.tool}
        </Tag>
        {queued > 0 && <Tag tone="warn">+{queued} more</Tag>}
      </div>
      <div className="space-y-3 p-3.5">
        {intr.message && <div className="text-[12.5px] text-muted">{intr.message}</div>}
        <JsonBlock value={intr.args} maxHeight={240} />
        <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={edit} onChange={(e) => setEdit(e.target.checked)} />
          <PencilLine className="h-3.5 w-3.5" /> edit arguments before approving
        </label>
        <textarea
          className={cx("textarea min-h-[110px]", !edit && "opacity-50", edit && parseError && "border-err/60")}
          disabled={!edit}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={Math.min(14, Math.max(4, draft.split("\n").length))}
          aria-label="Edited arguments (JSON)"
        />
        {edit && parseError && <div className="font-mono text-[11.5px] text-err">{parseError}</div>}
        {hitlNote && (
          <input className="input font-mono" placeholder="optional note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ok" onClick={() => decide({ action: "approve", note: noteValue })}>
            <CircleCheck className="h-4 w-4" /> approve
          </button>
          <button
            className="btn btn-accent"
            disabled={!canEditApprove}
            onClick={() => parsed && decide({ action: "approve", edited_args: parsed, note: noteValue })}
          >
            <PencilLine className="h-4 w-4" /> approve with edits
          </button>
          <button className="btn btn-err" onClick={() => decide({ action: "reject", note: noteValue })}>
            <CircleX className="h-4 w-4" /> reject
          </button>
        </div>
      </div>
    </div>
  );
}
