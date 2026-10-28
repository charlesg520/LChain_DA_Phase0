import { Eye, EyeOff, KeyRound, RotateCcw, Save, Settings as SettingsIcon, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton, Dot, Section, Tag, ViewHeader, cx } from "../components/ui";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { Accent, SandboxInfo } from "../types";
import { reconnect, wsUrl } from "../ws";

const ACCENTS: { id: Accent; hex: string }[] = [
  { id: "cyan", hex: "#22d3ee" },
  { id: "violet", hex: "#a78bfa" },
  { id: "green", hex: "#4ade80" },
  { id: "amber", hex: "#f59e0b" },
];

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const reset = useStore((s) => s.resetSettings);
  const conn = useStore((s) => s.connection);
  const toast = useStore((s) => s.toast);
  const [form, setForm] = useState(settings);
  const [show, setShow] = useState(false);
  const dirty = form.host !== settings.host || form.ws_path !== settings.ws_path || form.token !== settings.token;

  useEffect(() => setForm(settings), [settings]);

  const apply = () => {
    save({ host: form.host.trim(), ws_path: form.ws_path.trim() || "/ws", token: form.token.trim() });
    toast("info", "Saved. Reconnecting with the new settings…");
    setTimeout(reconnect, 50);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader icon={<SettingsIcon />} title="Settings" subtitle="Stored in this browser only" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 p-5">
          <Section
            title={
              <>
                <Wifi className="h-3.5 w-3.5" /> connection
              </>
            }
            right={
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
                <Dot tone={conn.status === "open" ? "ok" : conn.status === "connecting" ? "warn" : "err"} />
                {conn.status}
                {conn.hello && ` · ${conn.hello.mode ?? "server"} v${conn.hello.version}`}
              </span>
            }
          >
            <form
              className="space-y-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                <div>
                  <label className="label" htmlFor="host">
                    host
                  </label>
                  <input id="host" className="input font-mono" placeholder="(same as this page)" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="ws_path">
                    ws path
                  </label>
                  <input id="ws_path" className="input font-mono" value={form.ws_path} onChange={(e) => setForm({ ...form, ws_path: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="token">
                  <KeyRound className="mr-1 inline h-3 w-3" /> token
                </label>
                <div className="relative">
                  <input
                    id="token"
                    className="input pr-9 font-mono"
                    type={show ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="HQ_API_TOKEN (or WEB_TOKEN) from the server's .env"
                    value={form.token}
                    onChange={(e) => setForm({ ...form, token: e.target.value })}
                  />
                  <button type="button" className="absolute right-1 top-1 rounded p-1 text-muted hover:text-text" onClick={() => setShow(!show)} aria-label={show ? "Hide token" : "Show token"}>
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {conn.status === "unauthorized" && <p className="mt-1.5 text-[12px] text-err">The server rejected this token.</p>}
              </div>
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="truncate font-mono text-[11px] text-muted" title="WebSocket URL">
                  {wsUrl().replace(/token=[^&]+/, "token=••••")}
                </span>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-sm" onClick={() => reconnect()}>
                    reconnect
                  </button>
                  <button type="submit" className="btn btn-accent btn-sm" disabled={!dirty}>
                    <Save className="h-3.5 w-3.5" /> save & reconnect
                  </button>
                </div>
              </div>
            </form>
          </Section>

          <Section title="appearance">
            <div className="flex flex-wrap gap-2 p-4" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((a) => (
                <label
                  key={a.id}
                  className={cx(
                    "flex cursor-pointer items-center gap-2 rounded-card border px-3 py-2 text-[12.5px] capitalize",
                    settings.accent === a.id ? "border-text/40 bg-panel-hi" : "border-border hover:border-muted/50",
                  )}
                >
                  <input type="radio" name="accent" className="sr-only" checked={settings.accent === a.id} onChange={() => save({ accent: a.id })} />
                  <span className="h-3.5 w-3.5 rounded-full" style={{ background: a.hex }} />
                  {a.id}
                </label>
              ))}
            </div>
          </Section>

          <Section title="approvals">
            <label className="flex cursor-pointer items-start gap-3 p-4">
              <input type="checkbox" className="mt-1 accent-[rgb(var(--accent))]" checked={settings.hitl_note} onChange={(e) => save({ hitl_note: e.target.checked })} />
              <span>
                <span className="block text-[13px] text-text">Show a note field on approval cards</span>
                <span className="block text-[12px] text-muted">The note goes back to the agent with your decision (e.g. why you rejected an edit).</span>
              </span>
            </label>
            {conn.hello?.mode === "live" && (
              <p className="border-t border-border px-4 py-3 text-[12px] text-muted">
                Which tools need approval is set on the server, e.g. <span className="font-mono text-text/80">HQ_REQUIRE_APPROVAL=edit_file,write_file</span> in{" "}
                <span className="font-mono">.env</span>, then <span className="font-mono">make up</span>. Toolkit → Tools shows which tools ask right now.
              </p>
            )}
          </Section>

          <NotificationsSection />
          <SandboxesSection />

          <div className="flex justify-end">
            <button
              className="btn btn-sm"
              onClick={() => {
                reset();
                toast("info", "Settings reset to defaults");
                setTimeout(reconnect, 50);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> reset defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type NotifyInfo = { enabled: boolean; server: string; topic: string; sent: number; last_error: string | null };

/** ntfy phone notifications (live mode): where to subscribe, and a test button. */
function NotificationsSection() {
  const conn = useStore((s) => s.connection.status);
  const toast = useStore((s) => s.toast);
  const [info, setInfo] = useState<NotifyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (conn === "open") api<NotifyInfo>("/notify").then(setInfo, () => setInfo(null));
  }, [conn]);
  if (!info) return null; // mock mode, or a server without notifications
  const test = async () => {
    setBusy(true);
    try {
      setInfo(await api<NotifyInfo>("/notify/test", { method: "POST", body: {} }));
      toast("ok", "Test notification sent; check your phone");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="notifications" right={info.enabled ? <Tag tone="ok">on</Tag> : <Tag tone="muted">off</Tag>}>
      <div className="space-y-2.5 p-4 text-[12.5px]">
        {info.enabled ? (
          <>
            <p className="text-muted">
              Your phone gets a notification when HQ finishes a longer job, stops on an error, or needs your approval. Tap it to open the chat; approvals have
              Approve / Reject buttons.
            </p>
            <div className="text-muted">In the ntfy app, tap + and subscribe to this topic{info.server !== "https://ntfy.sh" ? ` on ${info.server}` : ""}:</div>
            <div className="flex items-center gap-2 rounded-card border border-border bg-bg px-3 py-2 font-mono text-[12.5px]">
              <span className="min-w-0 flex-1 truncate text-text">{info.topic}</span>
              <CopyButton text={info.topic} />
            </div>
            <p className="text-[11.5px] text-muted">Keep the topic private: anyone who knows it can read these notifications (titles and status only).</p>
            <div className="flex items-center gap-3">
              <button className="btn btn-sm" onClick={() => void test()} disabled={busy}>
                send a test
              </button>
              <span className="font-mono text-[11px] text-muted">sent {info.sent}</span>
              {info.last_error && <span className="text-[11.5px] text-err">last error: {info.last_error}</span>}
            </div>
          </>
        ) : (
          <p className="text-muted">
            Off. Set <span className="font-mono text-text">NTFY_TOPIC</span> in the server's <span className="font-mono">.env</span> (make init generates one), then{" "}
            <span className="font-mono">make up</span>.
          </p>
        )}
      </div>
    </Section>
  );
}

function SandboxesSection() {
  const conn = useStore((s) => s.connection.status);
  const toast = useStore((s) => s.toast);
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    api<SandboxInfo>("/sandboxes")
      .then((d) => {
        setInfo(d);
        setErr("");
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    if (conn === "open") void load();
  }, [conn]);
  const act = async (project: string, action: "stop" | "pin" | "unpin") => {
    try {
      await api(`/sandboxes/${encodeURIComponent(project)}/${action}`, { method: "POST", body: action === "pin" ? { hours: 4 } : {} });
      toast("ok", `${action} ${project}`);
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const rows = info ? Object.entries(info.hosts) : [];
  return (
    <Section title="sandboxes" right={<button className="btn btn-ghost btn-sm h-6" onClick={() => void load()}>refresh</button>}>
      <div className="space-y-2 p-4 text-[12.5px]">
        {err && <div className="text-err">{err}</div>}
        {info?.reaper && (
          <div className="text-muted">
            Idle reaper {info.reaper.running ? "running" : "off"}: stops after {info.reaper.idle_stop_minutes} min idle, removes after {info.reaper.idle_remove_hours} h. Workspaces are kept.
          </div>
        )}
        {rows.map(([host, h]) => (
          <div key={host} className="rounded-card border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11.5px]">
              <Dot tone={h.reachable ? "ok" : "muted"} /> {host}
              {!h.reachable && <span className="text-muted">unreachable</span>}
            </div>
            {(h.sandboxes || []).length === 0 ? (
              <div className="px-3 py-2 text-muted">{h.reachable ? "no sandboxes" : h.error}</div>
            ) : (
              h.sandboxes!.map((s) => (
                <div key={s.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-mono text-text">{s.project}</span>
                  <Tag tone={s.status === "running" ? "ok" : "muted"}>{s.status}</Tag>
                  {s.busy && <Tag tone="accent">busy</Tag>}
                  {s.pinned_until && <Tag tone="info">pinned</Tag>}
                  {s.idle_s !== null && <span className="font-mono text-[11px] text-muted">idle {Math.round(s.idle_s / 60)}m</span>}
                  <span className="ml-auto flex gap-1.5">
                    {s.status === "running" && (
                      <button className="btn btn-sm h-6" onClick={() => void act(s.project, "stop")}>
                        stop
                      </button>
                    )}
                    <button className="btn btn-sm h-6" onClick={() => void act(s.project, s.pinned_until ? "unpin" : "pin")}>
                      {s.pinned_until ? "unpin" : "keep 4h"}
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
