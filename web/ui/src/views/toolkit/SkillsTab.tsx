import { CircleCheck, CircleX, FilePlus, GitCompareArrows, History, Inbox, Pencil, Plus, Puzzle, RotateCcw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeView } from "../../components/Code";
import { Markdown } from "../../components/Markdown";
import { Dot, Empty, Modal, Spinner, Switch, Tag, cx } from "../../components/ui";
import { api } from "../../lib/api";
import { relTime } from "../../lib/format";
import { useStore } from "../../store";
import type { Skill, SkillDetail, SkillProposal } from "../../types";

const TEMPLATE = (name: string) => `---
name: ${name || "my-skill"}
description: What this skill does and when HQ should use it (one or two sentences).
---

# ${name || "My skill"}

- Step-by-step know-how, conventions, commands or checklists.
- Keep it short; HQ reads it before doing the task it covers.
`;

export function SkillsTab() {
  const skills = useStore((s) => s.skills);
  const toggle = useStore((s) => s.toggleSkill);
  const live = useStore((s) => s.connection.hello?.features?.includes("skill-enable") ?? false);
  const studio = useStore((s) => s.connection.hello?.features?.includes("skill-studio") ?? false);
  const conn = useStore((s) => s.connection.status);
  const [q, setQ] = useState("");
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [editing, setEditing] = useState<{ category: string; name: string; isNew: boolean } | null>(null);
  const [historyOf, setHistoryOf] = useState<Skill | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const loadProposals = useCallback(() => {
    if (!studio) return;
    api<SkillProposal[]>("/skill-proposals?status=pending")
      .then(setProposals)
      .catch(() => setProposals([]));
  }, [studio]);
  useEffect(() => {
    if (conn === "open") loadProposals();
  }, [conn, loadProposals, skills]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? skills.filter((s) => `${s.name} ${s.description} ${s.category ?? ""}`.toLowerCase().includes(n)) : skills;
  }, [skills, q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted" />
          <input className="input pl-8" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {studio && (
          <button className="btn btn-accent" onClick={() => setEditing({ category: "coding", name: "", isNew: true })}>
            <Plus className="h-4 w-4" /> new skill
          </button>
        )}
      </div>

      {proposals.length > 0 && (
        <div className="overflow-hidden rounded-card border border-warn/40 bg-warn/[0.04]">
          <div className="flex items-center gap-2 border-b border-warn/25 px-3.5 py-2">
            <Inbox className="h-4 w-4 text-warn" />
            <span className="text-[12.5px] font-semibold text-text">HQ proposed {proposals.length === 1 ? "a skill change" : `${proposals.length} skill changes`}</span>
            <span className="text-[12px] text-muted">nothing changes until you approve</span>
          </div>
          {proposals.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 border-b border-border/50 px-3.5 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] text-text">
                    {p.category}/{p.name}
                  </span>
                  <Tag>{p.proposed_by}</Tag>
                  <span className="text-[11px] text-muted">{relTime(p.created_at * (p.created_at < 1e12 ? 1000 : 1))}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{p.reason}</div>
              </div>
              <button className="btn btn-warn btn-sm" onClick={() => setReviewing(p.id)}>
                <GitCompareArrows className="h-3.5 w-3.5" /> review
              </button>
            </div>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty icon={<Puzzle />} title={q ? "No skills match" : "No skills yet"} hint="Skills are SKILL.md playbooks HQ reads before doing a task." />
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {filtered.map((s) => (
            <SkillCard
              key={`${s.category}/${s.name}`}
              s={s}
              live={live}
              studio={studio}
              onToggle={() => toggle(s.name)}
              onEdit={() => setEditing({ category: s.category || "coding", name: s.name, isNew: false })}
              onHistory={() => setHistoryOf(s)}
            />
          ))}
        </div>
      )}
      <p className="text-[12px] text-muted">
        {live
          ? "Click a card to enable or disable that skill for every agent. A green pulse means HQ loaded it during the current run."
          : "Click a card to load or unload that skill."}
      </p>

      {editing && <SkillEditor {...editing} onClose={() => setEditing(null)} />}
      {historyOf && <SkillHistory skill={historyOf} onClose={() => setHistoryOf(null)} />}
      {reviewing && (
        <ProposalReview
          id={reviewing}
          onClose={() => {
            setReviewing(null);
            loadProposals();
          }}
        />
      )}
    </div>
  );
}

function SkillCard({ s, live, studio, onToggle, onEdit, onHistory }: { s: Skill; live: boolean; studio: boolean; onToggle: () => void; onEdit: () => void; onHistory: () => void }) {
  const enabled = s.enabled ?? true;
  const tone = s.status === "loaded" ? "ok" : s.status === "error" ? "err" : "muted";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}
      className={cx(
        "card group cursor-pointer p-3.5 transition-colors hover:border-accent/40",
        s.status === "loaded" && "border-ok/40",
        !enabled && "opacity-55",
      )}
      title={live ? (enabled ? "Click to disable" : "Click to enable") : s.status === "loaded" ? "Click to unload" : "Click to load"}
    >
      <div className="flex items-start gap-2.5">
        <Dot tone={tone} pulse={s.status === "loaded"} className="mt-1.5" title={s.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[13px] font-semibold text-text">{s.name}</span>
            {s.category && <Tag>{s.category}</Tag>}
            {s.version != null && <Tag>v{s.version}</Tag>}
            {!enabled && <Tag tone="warn">disabled</Tag>}
            {s.builtin_update && <Tag tone="info">repo update</Tag>}
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-muted">{s.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-muted/80">{s.file}</span>
            <Tag tone={s.source === "built-in" || s.source === "builtin" ? "accent" : "muted"}>{s.source}</Tag>
          </div>
          {s.error && <div className="mt-1.5 text-[12px] text-err">{s.error}</div>}
        </div>
        {live && <Switch checked={enabled} onChange={onToggle} label={`${s.name} enabled`} />}
      </div>
      {studio && (
        <div className="mt-2.5 flex gap-1.5 border-t border-border/60 pt-2.5 opacity-70 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-sm h-6" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> edit
          </button>
          <button className="btn btn-sm h-6" onClick={onHistory}>
            <History className="h-3 w-3" /> history
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor
function SkillEditor({ category, name, isNew, onClose }: { category: string; name: string; isNew: boolean; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [cat, setCat] = useState(category);
  const [nm, setNm] = useState(name);
  const [files, setFiles] = useState<Record<string, string> | null>(isNew ? { "SKILL.md": TEMPLATE("") } : null);
  const [active, setActive] = useState("SKILL.md");
  const [preview, setPreview] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    if (isNew) return;
    api<SkillDetail>(`/skills/${category}/${name}`)
      .then((d) => setFiles(d.files))
      .catch((e) => setErr(e.message));
  }, [category, name, isNew]);

  // keep the frontmatter name in sync while naming a new skill
  useEffect(() => {
    if (!isNew || !files) return;
    setFiles((f) => (f ? { ...f, "SKILL.md": f["SKILL.md"].replace(/^name:.*$/m, `name: ${nm || "my-skill"}`) } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nm]);

  const save = async () => {
    if (!files) return;
    setSaving(true);
    setErr("");
    try {
      const r = await api<{ version: number }>(`/skills/${encodeURIComponent(cat)}/${encodeURIComponent(nm)}`, { method: "PUT", body: { files, note } });
      toast("ok", `${cat}/${nm} saved as v${r.version}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      wide
      title={isNew ? "New skill" : `Edit ${category}/${name}`}
      onClose={onClose}
      footer={
        <>
          {err && <span className="mr-auto max-w-[60%] text-[12px] text-err">{err}</span>}
          <input className="input h-8 max-w-[260px]" placeholder="change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn" onClick={onClose}>
            cancel
          </button>
          <button className="btn btn-accent" onClick={() => void save()} disabled={!files || saving || !nm || !cat}>
            {saving ? <Spinner /> : <CircleCheck className="h-4 w-4" />} save {isNew ? "skill" : "new version"}
          </button>
        </>
      }
    >
      {!files ? (
        <div className="flex h-60 items-center justify-center gap-2 text-muted">{err ? <span className="text-err">{err}</span> : <><Spinner /> loading</>}</div>
      ) : (
        <div className="grid min-h-[60vh] md:grid-cols-[200px_1fr]">
          <div className="space-y-3 border-b border-border p-3 md:border-b-0 md:border-r">
            {isNew && (
              <>
                <div>
                  <label className="label">category</label>
                  <input className="input font-mono" value={cat} onChange={(e) => setCat(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} list="skill-cats" />
                  <datalist id="skill-cats">
                    {["coding", "markets", "research", "ops", "writing"].map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="label">name</label>
                  <input className="input font-mono" placeholder="kebab-case" value={nm} onChange={(e) => setNm(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} autoFocus />
                </div>
              </>
            )}
            <div>
              <label className="label">files</label>
              <ul className="space-y-0.5">
                {Object.keys(files)
                  .sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)))
                  .map((p) => (
                    <li key={p} className="group flex items-center">
                      <button className={cx("flex-1 truncate rounded px-2 py-1 text-left font-mono text-[12px]", active === p ? "bg-accent/10 text-accent" : "text-muted hover:text-text")} onClick={() => setActive(p)}>
                        {p}
                      </button>
                      {p !== "SKILL.md" && (
                        <button
                          className="p-1 text-muted opacity-0 hover:text-err group-hover:opacity-100"
                          onClick={() => {
                            const { [p]: _gone, ...rest } = files;
                            setFiles(rest);
                            setActive("SKILL.md");
                          }}
                          aria-label={`Remove ${p}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
              <form
                className="mt-2 flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const p = newPath.trim().replace(/^\/+/, "");
                  if (!p || p in files) return;
                  setFiles({ ...files, [p]: "" });
                  setActive(p);
                  setNewPath("");
                }}
              >
                <input className="input h-7 font-mono text-[11.5px]" placeholder="scripts/check.sh" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
                <button className="btn btn-sm w-7 shrink-0 px-0" aria-label="Add file">
                  <FilePlus className="h-3.5 w-3.5" />
                </button>
              </form>
            </div>
            <p className="text-[11.5px] leading-snug text-muted">
              SKILL.md needs frontmatter with <span className="font-mono">name</span> (matching the folder) and a <span className="font-mono">description</span> saying when to use it.
            </p>
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex h-9 items-center gap-1 border-b border-border px-2">
              <span className="font-mono text-[12px] text-muted">{active}</span>
              {active.endsWith(".md") && (
                <button className="btn btn-ghost btn-sm ml-auto h-6" onClick={() => setPreview(!preview)}>
                  {preview ? "edit" : "preview"}
                </button>
              )}
            </div>
            {preview && active.endsWith(".md") ? (
              <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                <Markdown text={files[active].replace(/^---[\s\S]*?---\s*/, "")} />
              </div>
            ) : (
              <textarea className="min-h-[50vh] flex-1 resize-none rounded-none border-0 bg-bg p-3 font-mono text-[12.5px] leading-[1.6] text-text focus:outline-none" value={files[active] ?? ""} onChange={(e) => setFiles({ ...files, [active]: e.target.value })} spellCheck={false} aria-label={`Edit ${active}`} />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------- history
function SkillHistory({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState("");
  const cat = skill.category || "coding";
  const load = useCallback(() => {
    api<SkillDetail>(`/skills/${cat}/${skill.name}`)
      .then(setDetail)
      .catch((e) => setErr(e.message));
  }, [cat, skill.name]);
  useEffect(load, [load]);
  useEffect(() => {
    if (pick === null) return setFiles(null);
    api<{ files: Record<string, string> }>(`/skills/${cat}/${skill.name}/versions/${pick}`)
      .then((d) => setFiles(d.files))
      .catch((e) => setErr(e.message));
  }, [pick, cat, skill.name]);
  const versions = (detail?.history || []).filter((h) => h.version !== null).reverse();
  const current = versions[0]?.version;
  const restore = async () => {
    if (pick === null) return;
    try {
      const r = await api<{ version: number }>(`/skills/${cat}/${skill.name}/rollback`, { body: { version: pick } });
      toast("ok", `Restored v${pick} as v${r.version}`);
      load();
      setPick(null);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <Modal wide title={`History · ${cat}/${skill.name}`} onClose={onClose}>
      <div className="grid min-h-[50vh] md:grid-cols-[260px_1fr]">
        <ul className="max-h-[70vh] overflow-y-auto border-b border-border md:border-b-0 md:border-r">
          {err && <li className="p-3 text-[12px] text-err">{err}</li>}
          {!detail && !err && (
            <li className="flex items-center gap-2 p-3 text-muted">
              <Spinner /> loading
            </li>
          )}
          {versions.map((v) => (
            <li key={v.version}>
              <button className={cx("w-full border-b border-border/60 px-3 py-2.5 text-left hover:bg-panel-hi", pick === v.version && "bg-accent/[0.08]")} onClick={() => setPick(v.version)}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] font-semibold text-text">v{v.version}</span>
                  {v.version === current && <Tag tone="ok">live</Tag>}
                  <span className="ml-auto text-[11px] text-muted">{relTime(v.ts < 1e12 ? v.ts * 1000 : v.ts)}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{v.source}</div>
                {v.note && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted">{v.note}</div>}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-h-0 flex-col">
          {pick === null ? (
            <Empty icon={<History />} title="Pick a version" hint="See exactly what HQ read at that point, and restore it if a change made things worse." />
          ) : !files ? (
            <div className="flex h-40 items-center justify-center gap-2 text-muted">
              <Spinner /> loading v{pick}
            </div>
          ) : (
            <>
              <div className="flex h-10 items-center gap-2 border-b border-border px-3">
                <span className="font-mono text-[12px] text-muted">v{pick} · SKILL.md</span>
                <button className="btn btn-warn btn-sm ml-auto" disabled={pick === current} onClick={() => void restore()}>
                  <RotateCcw className="h-3.5 w-3.5" /> restore v{pick}
                </button>
              </div>
              <CodeView code={files["SKILL.md"] ?? Object.values(files)[0] ?? ""} lang="md" className="max-h-[62vh] py-2" />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------- proposal review
function ProposalReview({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [p, setP] = useState<SkillProposal | null>(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<SkillProposal>(`/skill-proposals/${id}`)
      .then((d) => {
        setP(d);
        setDraft(d.files?.["SKILL.md"] ?? "");
      })
      .catch((e) => setErr(e.message));
  }, [id]);
  const decide = async (decision: "approve" | "reject") => {
    if (!p) return;
    setBusy(true);
    try {
      const edited = edit && draft !== (p.files?.["SKILL.md"] ?? "");
      const body: Record<string, unknown> = { note };
      if (decision === "approve" && edited) body.files = { ...(p.files || {}), "SKILL.md": draft };
      await api(`/skill-proposals/${id}/${decision}`, { body });
      toast(decision === "approve" ? "ok" : "info", decision === "approve" ? `${p.category}/${p.name} updated${edited ? " (with your edits)" : ""}` : "Proposal rejected");
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={p ? `Review proposal · ${p.category}/${p.name}` : "Review proposal"}
      onClose={onClose}
      footer={
        p && (
          <>
            {err && <span className="mr-auto text-[12px] text-err">{err}</span>}
            <input className="input h-8 max-w-[260px]" placeholder="note for the record (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn-err" disabled={busy} onClick={() => void decide("reject")}>
              <CircleX className="h-4 w-4" /> reject
            </button>
            <button className="btn btn-ok" disabled={busy} onClick={() => void decide("approve")}>
              <CircleCheck className="h-4 w-4" /> approve{edit && draft !== (p.files?.["SKILL.md"] ?? "") ? " with edits" : ""}
            </button>
          </>
        )
      }
    >
      {!p ? (
        <div className="flex h-60 items-center justify-center gap-2 text-muted">{err ? <span className="text-err">{err}</span> : <><Spinner /> loading</>}</div>
      ) : (
        <div className="space-y-3 p-4">
          <div className="rounded-card border border-border bg-panel-hi px-3 py-2.5">
            <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">why ({p.proposed_by})</div>
            <div className="text-[13px] text-text">{p.reason}</div>
          </div>
          {p.live_changed_since_proposed && (
            <div className="rounded-card border border-warn/40 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-warn">
              The live skill changed after this was proposed. Approving replaces it with the proposed version.
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="section-title">{edit ? "edit before approving" : "changes"}</span>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={edit} onChange={(e) => setEdit(e.target.checked)} /> edit SKILL.md
            </label>
          </div>
          {edit ? (
            <textarea className="textarea min-h-[45vh]" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-[#0a0e15]">
              <CodeView code={p.diff || "(no textual changes)"} lang="diff" numbers={false} className="max-h-[52vh] py-2" />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
