import { Plug, Plus, Power, Server, Trash2, X } from "lucide-react";
import { useState } from "react";
import { JsonBlock } from "../../components/Code";
import { Dot, Empty, Spinner, Tag, cx } from "../../components/ui";
import { duration, newId } from "../../lib/format";
import { useStore } from "../../store";
import type { McpServer, McpTransport } from "../../types";

const ROLES = ["orchestrator", "coder", "reviewer", "researcher"] as const;

export function ServersTab() {
  const servers = useStore((s) => s.mcp);
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[12.5px] text-muted">MCP servers give HQ extra tools (GitHub, databases, browsers, APIs). Changes apply live; no restart.</p>
        {!adding && (
          <button className="btn btn-accent" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> add server
          </button>
        )}
      </div>
      {adding && <AddServerForm onDone={() => setAdding(false)} />}
      {servers.length === 0 && !adding ? (
        <Empty icon={<Server />} title="No MCP servers" hint="Add one to give HQ more tools." action={<button className="btn btn-sm" onClick={() => setAdding(true)}>add server</button>} />
      ) : (
        <div className="grid gap-2.5 lg:grid-cols-2">
          {servers.map((s) => (
            <ServerCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerCard({ s }: { s: McpServer }) {
  const send = useStore((x) => x.send);
  const now = useStore((x) => x.run.now);
  const [confirm, setConfirm] = useState(false);
  const tone = s.status === "connected" ? "ok" : s.status === "connecting" ? "warn" : s.status === "error" ? "err" : "muted";
  const enabled = s.status !== "disconnected";
  const uptime = s.started_at && s.status === "connected" ? duration(Math.max(now, Date.now()) - s.started_at) : null;
  return (
    <div className={cx("card p-3.5", s.status === "error" && "border-err/35", s.status === "connected" && "border-ok/25")}>
      <div className="flex items-start gap-2.5">
        {s.status === "connecting" ? <Spinner className="mt-0.5 text-warn" /> : <Dot tone={tone} pulse={s.status === "connected"} className="mt-1.5" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[13px] font-semibold text-text">{s.name}</span>
            <Tag tone={s.transport === "stdio" ? "info" : "accent"}>{s.transport}</Tag>
            <span className={cx("font-mono text-[11px]", tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "err" ? "text-err" : "text-muted")}>{s.status}</span>
            {uptime && <span className="font-mono text-[11px] text-muted">up {uptime}</span>}
          </div>
          <div className="mt-1 truncate font-mono text-[11.5px] text-muted" title={s.command || s.url}>
            {s.command || s.url}
          </div>
          {s.error && <div className="mt-1.5 break-words rounded-[6px] border border-err/30 bg-err/[0.06] px-2 py-1 font-mono text-[11.5px] text-err">{s.error}</div>}
        </div>
      </div>
      {s.env && Object.keys(s.env).length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">env</div>
          <JsonBlock value={s.env} maxHeight={120} />
        </div>
      )}
      {s.agents && Object.keys(s.agents).length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {Object.entries(s.agents).map(([role, pats]) => (
            <Tag
              key={role}
              tone={role === "orchestrator" ? "accent" : "info"}
              title={pats.join(", ")}
              className="h-auto min-h-5 max-w-full whitespace-normal py-[3px] leading-[1.35] [overflow-wrap:anywhere]"
            >
              {role}: {pats.join(" ")}
            </Tag>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1">
        {s.tools.length === 0 ? (
          <span className="text-[11.5px] text-muted">{s.status === "connected" ? "no tools exposed" : "tools appear once connected"}</span>
        ) : (
          s.tools.map((t) => (
            <span key={t} className="rounded-[5px] border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-text/85">
              {t}
            </span>
          ))
        )}
      </div>
      <div className="mt-3 flex gap-1.5 border-t border-border/60 pt-2.5">
        <button className={cx("btn btn-sm h-7", enabled ? "" : "btn-ok")} onClick={() => send({ type: "mcp-toggle", id: s.id, enabled: !enabled })}>
          <Power className="h-3.5 w-3.5" /> {enabled ? "disable" : "enable"}
        </button>
        {confirm ? (
          <>
            <button className="btn btn-err btn-sm h-7" onClick={() => send({ type: "mcp-remove", id: s.id })}>
              remove {s.name}?
            </button>
            <button className="btn btn-sm h-7" onClick={() => setConfirm(false)}>
              cancel
            </button>
          </>
        ) : (
          <button className="btn btn-sm h-7 hover:text-err" onClick={() => setConfirm(true)}>
            <Trash2 className="h-3.5 w-3.5" /> remove
          </button>
        )}
      </div>
    </div>
  );
}

function parseJson(label: string, text: string): { value?: Record<string, string>; error?: string } {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `${label} must be a JSON object` };
    for (const [k, val] of Object.entries(v)) if (typeof val !== "string") return { error: `${label}.${k} must be a string` };
    return { value: v as Record<string, string> };
  } catch (e) {
    return { error: `${label}: ${(e as Error).message}` };
  }
}

function AddServerForm({ onDone }: { onDone: () => void }) {
  const addMcp = useStore((s) => s.addMcp);
  const live = useStore((s) => s.connection.hello?.mode === "live");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>(live ? "http" : "stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [agents, setAgents] = useState<Record<string, string>>({ orchestrator: "*", coder: "*", reviewer: "", researcher: "" });
  const [err, setErr] = useState("");

  const submit = () => {
    const n = name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n)) return setErr("name: lowercase letters, digits, - and _ (max 32)");
    if (transport === "stdio" && !command.trim()) return setErr("command is required for stdio");
    if (transport !== "stdio" && !/^https?:\/\//.test(url.trim())) return setErr("url must start with http:// or https://");
    const e1 = parseJson("env", env);
    const e2 = parseJson("headers", headers);
    if (e1.error || e2.error) return setErr(e1.error || e2.error || "");
    const agentMap: Record<string, string[]> = {};
    for (const [role, pats] of Object.entries(agents)) {
      const list = pats.split(/[\s,]+/).filter(Boolean);
      if (list.length) agentMap[role] = list;
    }
    addMcp({
      id: n || newId("mcp-"),
      name: n,
      transport,
      command: transport === "stdio" ? command.trim() : undefined,
      url: transport !== "stdio" ? url.trim() : undefined,
      env: e1.value,
      headers: e2.value,
      agents: Object.keys(agentMap).length ? agentMap : undefined,
    });
    onDone();
  };

  return (
    <form
      className="panel animate-slidein space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-2">
        <Plug className="h-4 w-4 text-accent" />
        <span className="text-[13px] font-semibold">Add MCP server</span>
        <button type="button" className="btn btn-ghost btn-sm ml-auto w-7 px-0" onClick={onDone} aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">name</label>
          <input className="input font-mono" placeholder="github" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus />
        </div>
        <div>
          <label className="label">transport</label>
          <div className="flex gap-1 rounded-card border border-border p-0.5" role="radiogroup">
            {(["stdio", "sse", "http"] as McpTransport[]).map((t) => (
              <label key={t} className={cx("flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[6px] font-mono text-[12px]", transport === t ? "bg-accent/15 text-accent" : "text-muted hover:text-text")}>
                <input type="radio" name="transport" className="sr-only" checked={transport === t} onChange={() => setTransport(t)} />
                {t === "http" ? "http (streamable)" : t}
              </label>
            ))}
          </div>
        </div>
      </div>
      {transport === "stdio" ? (
        <div>
          <label className="label">command</label>
          <input className="input font-mono" placeholder="npx -y @modelcontextprotocol/server-filesystem /data" value={command} onChange={(e) => setCommand(e.target.value)} />
          {live && <p className="mt-1 text-[11.5px] text-muted">Runs inside the agent container, so the program must exist there. Remote (http/sse) servers are the reliable choice.</p>}
        </div>
      ) : (
        <div>
          <label className="label">url</label>
          <input className="input font-mono" placeholder={transport === "sse" ? "https://example.com/sse" : "https://api.githubcopilot.com/mcp/"} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">env (json, optional)</label>
          <textarea className="textarea h-20" placeholder='{"API_KEY": "${MY_KEY}"}' value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
        </div>
        <div>
          <label className="label">headers (json, optional)</label>
          <textarea className="textarea h-20" placeholder='{"Authorization": "Bearer ${GITHUB_MCP_TOKEN}"}' value={headers} onChange={(e) => setHeaders(e.target.value)} spellCheck={false} />
        </div>
      </div>
      {live && (
        <div>
          <label className="label">which agents get its tools (glob patterns, empty = none)</label>
          <div className="grid gap-2 sm:grid-cols-4">
            {ROLES.map((r) => (
              <div key={r}>
                <div className="mb-0.5 font-mono text-[11px] text-muted">{r}</div>
                <input className="input h-7 font-mono text-[12px]" placeholder="get_* search_*" value={agents[r]} onChange={(e) => setAgents({ ...agents, [r]: e.target.value })} />
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11.5px] text-muted">
            Use <span className="font-mono">{"${VAR}"}</span> for secrets that live in the server's <span className="font-mono">.env</span>; values typed here are stored on the server.
          </p>
        </div>
      )}
      {err && <div className="text-[12px] text-err">{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onDone}>
          cancel
        </button>
        <button type="submit" className="btn btn-accent">
          <Plug className="h-4 w-4" /> connect
        </button>
      </div>
    </form>
  );
}
