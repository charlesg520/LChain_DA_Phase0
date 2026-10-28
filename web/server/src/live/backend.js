// Live backend: translates between the console's WebSocket contract and HQ
// (Aegra's Agent Protocol + the /ops API).
//
//   chat      -> POST /threads/{id}/runs/stream   (thread id == console run_id)
//   interrupt -> resume the run with the HITL decision
//   control   -> pause = interrupt-cancel (resume continues from the checkpoint),
//                stop  = cancel
//   everything else -> /ops/*
//
// Each run's frames are also kept as a transcript in WEB_DATA_DIR, so history
// replays sub-agent messages too (those don't live in the parent thread's state).
import fs from "node:fs";
import path from "node:path";
import { VERSION, uid } from "../util.js";
import { ChunkBuffer, msTimes, skillKeyFromPath, splitContent, toMessage, toSkill } from "./convert.js";
import { HqClient, HqError } from "./hq.js";
import { Notifier } from "./notify.js";

// "custom" carries HQ's own events, e.g. "the model provider timed out, retrying in 30s".
const STREAM_MODE = ["messages-tuple", "updates", "custom"];
const STREAM_FLUSH_MS = 80;
const STATS_MS = 2000;
const MCP_POLL_MS = 1000;
const MCP_POLL_MAX = 45;
const REJOIN_ATTEMPTS = 6;
const RECOVER_DAYS = 14;
const HISTORY_MAX = 500;

export class LiveBackend {
  /**
   * @param {{broadcast:(f:any)=>void}} hub
   * @param {{apiUrl:string, apiToken:string, dataDir:string, assistant:string, notify?: any}} opts
   */
  constructor(hub, { apiUrl, apiToken, dataDir, assistant, notify }) {
    this.mode = "live";
    this.hub = hub;
    this.hq = new HqClient({ apiUrl, apiToken });
    this.assistant = assistant;
    this.dataDir = dataDir;
    this.transcripts = path.join(dataDir, "transcripts");
    fs.mkdirSync(this.transcripts, { recursive: true });
    /** @type {Map<string, Run>} */
    this.runs = new Map();
    this.loadedSkills = new Set(); // "category/name" read during the latest run
    this.skillsCache = [];
    this.model = "";
    this.notifier = new Notifier(notify || {});
    this.recovered = this._recover().catch((e) => console.error("could not recover runs in progress:", e?.message || e));
  }

  /**
   * After a console restart, pick back up the chats HQ is still working in or
   * waiting on (runs keep going in HQ while the console is away).
   */
  async _recover() {
    const recent = Date.now() - RECOVER_DAYS * 86400_000;
    for (const status of ["interrupted", "busy"]) {
      let threads = [];
      for (let i = 0; i < 30; i++) {
        try {
          threads = await this.hq.json("/threads/search", { body: { status, limit: 50, offset: 0 } });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 2000)); // HQ may still be starting
        }
      }
      for (const t of threads || []) {
        const id = t.thread_id;
        if (this.runs.has(id) || (Date.parse(t.updated_at) || 0) < recent || !/^[0-9a-f-]{36}$/i.test(id)) continue;
        const transcript = this._loadTranscript(id) || (await this._detailFromState(id).catch(() => null));
        const run = new Run(this, id, t.metadata?.project || "default", transcript);
        run.title ||= t.metadata?.title || "";
        if (status === "interrupted") {
          run.begin();
          if (!(await run._pendingFromState(true))) {
            run.active = false;
            clearInterval(run.statsTimer);
            continue;
          }
          this.runs.set(id, run);
        } else {
          const runs = await this.hq.json(`/threads/${id}/runs`).catch(() => []);
          const live = (runs || []).find((r) => r.status === "running" || r.status === "pending");
          if (!live) continue;
          this.runs.set(id, run);
          run.begin();
          run.aegraRun = live.run_id;
          run.stream(null);
        }
        console.log(`recovered ${status} chat ${id} (${run.title || "untitled"})`);
      }
    }
  }

  // ------------------------------------------------------------ snapshots
  async hello() {
    let info = {};
    try {
      info = await this.hq.json("/ops/info", { timeoutMs: 15000 });
    } catch (e) {
      this.hub.broadcast({ type: "notice", level: "error", message: `HQ is not answering: ${e.message}` });
    }
    this.model = info?.models?.orchestrator?.replace(/^[a-z]+:/, "") || "hq";
    const projects = new Set(["default"]);
    try {
      const inv = await this.hq.json("/ops/sandboxes", { timeoutMs: 10000 });
      for (const h of Object.values(inv.hosts || {})) for (const s of /** @type {any} */ (h).sandboxes || []) projects.add(s.project);
    } catch {
      /* sandboxes optional */
    }
    return {
      type: "hello",
      version: `${VERSION} · hq ${info?.version || "?"}`,
      model: this.model,
      mode: "live",
      features: ["skill-studio", "skill-enable", "pause", "approvals", "projects", "parallel-chats", ...(this.notifier.enabled ? ["notify"] : [])],
      projects: [...projects],
    };
  }

  async snapshots() {
    const results = await Promise.allSettled([this._memoryFrame(), this._skillsFrame(), this._toolsFrame(), this._mcpFrame()]);
    const frames = [];
    for (const r of results) {
      if (r.status === "fulfilled") frames.push(r.value);
      else frames.push({ type: "error", message: String(r.reason?.message || r.reason), code: "backend_unavailable" });
    }
    return frames;
  }

  /** On (re)connect, catch the client up on runs that are still going. */
  async onConnect(client) {
    await this.recovered;
    for (const run of this.runs.values()) {
      if (!run.active) continue;
      client.send({ type: "status", run_id: run.id, status: run.paused ? "paused" : "running", ...(run.lastDetail ? { detail: run.lastDetail } : {}) });
      if (run.todos.length) client.send({ type: "todos", run_id: run.id, todos: run.todos });
      client.send({ type: "stats", run_id: run.id, stats: run.stats });
      for (const f of run.pendingFrames()) client.send(f);
    }
  }

  async _memoryFrame() {
    const d = await this.hq.json("/ops/memory");
    return { type: "memory", files: d.files };
  }

  async _skillsFrame() {
    const list = await this.hq.json("/ops/skills");
    this.skillsCache = list;
    return { type: "skills", skills: list.map((s) => toSkill(s, this.loadedSkills)) };
  }

  async _toolsFrame() {
    const tools = await this.hq.json("/ops/tools", { timeoutMs: 60000 });
    return { type: "tools", tools };
  }

  async _mcpFrame() {
    const servers = await this.hq.json("/ops/mcp/servers");
    return { type: "mcp", servers: msTimes(servers) };
  }

  async _broadcastSkills() {
    try {
      this.hub.broadcast(await this._skillsFrame());
    } catch (e) {
      this.hub.broadcast({ type: "error", message: `skills: ${e.message}`, code: "skills_unavailable" });
    }
  }

  // ---------------------------------------------------------------- uplink
  async handle(client, f) {
    switch (f.type) {
      case "chat":
        return this._chat(f);
      case "interrupt":
        return this._decide(f);
      case "control":
        return this._control(f);
      case "files":
        return this._files(client, f);
      case "file":
        return this._file(client, f);
      case "memory":
        return client.send(await this._memoryFrame());
      case "memory-save": {
        const d = await this.hq.json("/ops/memory", { method: "PUT", body: { path: f.path, content: f.content } });
        return this.hub.broadcast({ type: "memory", files: d.files });
      }
      case "skills":
        return client.send(await this._skillsFrame());
      case "skills-toggle":
        return this._toggleSkill(f.name);
      case "tools":
        return client.send(await this._toolsFrame());
      case "mcp":
        return client.send(await this._mcpFrame());
      case "mcp-add":
        return this._mcpChange(() =>
          this.hq.json("/ops/mcp/servers", {
            body: { name: f.name || f.id, transport: f.transport, url: f.url, command: f.command, env: f.env, headers: f.headers, agents: f.agents },
          }),
        );
      case "mcp-remove":
        return this._mcpChange(() => this.hq.json(`/ops/mcp/servers/${encodeURIComponent(f.id)}`, { method: "DELETE" }));
      case "mcp-toggle":
        return this._mcpChange(() => this.hq.json(`/ops/mcp/servers/${encodeURIComponent(f.id)}/enabled`, { body: { enabled: Boolean(f.enabled) } }));
      default:
        return client.send({ type: "error", message: `unknown frame type: ${f.type}`, code: "bad_frame" });
    }
  }

  async _files(client, f) {
    const p = f.path || "/";
    try {
      const d = await this.hq.json(`/ops/fs?${new URLSearchParams({ path: p, project: f.project || "default" })}`, { timeoutMs: 45000 });
      client.send({ type: "fs", path: d.path, entries: d.entries });
    } catch (e) {
      client.send({ type: "fs", path: p, entries: [] });
      client.send({ type: "error", message: e.message, code: e.status === 404 ? "file_not_found" : "fs_error" });
    }
  }

  async _file(client, f) {
    try {
      const r = await this.hq.json(`/ops/fs/file?${new URLSearchParams({ path: f.path, project: f.project || "default" })}`, { timeoutMs: 60000 });
      client.send({ type: "file", path: r.path, result: r });
    } catch (e) {
      client.send({ type: "error", message: e.message, code: e.status === 404 ? "file_not_found" : "fs_error" });
    }
  }

  async _toggleSkill(name) {
    if (!this.skillsCache.length) await this._skillsFrame().catch(() => null);
    const s = this.skillsCache.find((x) => x.name === name);
    if (!s) return this.hub.broadcast({ type: "error", message: `no skill named ${name}`, code: "skill_not_found" });
    try {
      await this.hq.json(`/ops/skills/${s.category}/${s.name}/enabled`, { body: { enabled: s.enabled === false } });
    } catch (e) {
      this.hub.broadcast({ type: "error", message: `skill ${name}: ${e.message}`, code: "skill_toggle_failed" });
    }
    await this._broadcastSkills();
    this._refreshTools();
  }

  async _mcpChange(action) {
    try {
      const servers = await action();
      this.hub.broadcast({ type: "mcp", servers: msTimes(servers) });
    } catch (e) {
      this.hub.broadcast({ type: "error", message: `MCP: ${e.message}`, code: "mcp_error" });
      this.hub.broadcast(await this._mcpFrame().catch(() => ({ type: "mcp", servers: [] })));
      return;
    }
    // Servers reconnect in the background; follow along until none is "connecting".
    let last = "";
    for (let i = 0; i < MCP_POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, MCP_POLL_MS));
      let frame;
      try {
        frame = await this._mcpFrame();
      } catch {
        continue;
      }
      const sig = JSON.stringify(frame.servers.map((s) => [s.id, s.status, s.tools.length]));
      if (sig !== last) this.hub.broadcast(frame);
      last = sig;
      if (!frame.servers.some((s) => s.status === "connecting")) break;
    }
    this._refreshTools();
  }

  _refreshTools() {
    this._toolsFrame()
      .then((f) => this.hub.broadcast(f))
      .catch(() => {});
  }

  // ------------------------------------------------------------------ runs
  async _chat(f) {
    const threadId = f.run_id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || "")) {
      return this.hub.broadcast({ type: "error", run_id: threadId, message: "run_id must be a UUID (it is the HQ thread id)", code: "bad_frame" });
    }
    if (typeof f.content !== "string" || !f.content.trim() || f.content.length > 500_000) {
      return this.hub.broadcast({ type: "error", run_id: threadId, message: "a message needs some text (and under 500 KB)", code: "bad_frame" });
    }
    const existing = this.runs.get(threadId);
    if (existing?.active) {
      return this.hub.broadcast({ type: "error", run_id: threadId, message: "HQ is already working in this chat", code: "busy" });
    }
    const project = (f.project || "default").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "default";
    const run = existing || new Run(this, threadId, project, this._loadTranscript(threadId));
    this.runs.set(threadId, run);
    run.begin();
    run.addMessage({ id: uid("u-"), role: "user", content: f.content, ts: Date.now() });

    try {
      await this.hq.json("/threads", {
        body: { thread_id: threadId, if_exists: "do_nothing", metadata: { title: run.title || f.content.slice(0, 80), project } },
      });
      if (!run.title) {
        run.title = f.content.slice(0, 80);
        await this.hq.json(`/threads/${threadId}`, { method: "PATCH", body: { metadata: { title: run.title, project } } }).catch(() => {});
      }
    } catch (e) {
      return run.fail(`could not open the chat in HQ: ${e.message}`);
    }
    this.loadedSkills.clear();
    this._broadcastSkills();
    run.stream({
      assistant_id: this.assistant,
      // skills_metadata: null makes every turn re-read /skills, so approved or toggled skills apply right away
      input: { messages: [{ role: "user", content: f.content }], skills_metadata: null },
      config: { configurable: { project: run.project } },
      stream_mode: STREAM_MODE,
      stream_subgraphs: true,
    });
  }

  _decide(f) {
    const run = this.runs.get(f.run_id);
    if (!run || !run.awaiting) {
      return this.hub.broadcast({ type: "error", run_id: f.run_id, message: "no pending approval for that chat", code: "stale_interrupt" });
    }
    run.decide(f.interrupt_id, f.decision);
  }

  async _control(f) {
    const run = this.runs.get(f.run_id);
    if (!run || !run.active) return;
    if (f.cmd === "stop") return run.stop();
    if (f.cmd === "pause") return run.pause();
    if (f.cmd === "resume") return run.resume();
  }

  // ----------------------------------------------------------- transcripts
  _transcriptPath(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HqError(400, "bad id");
    return path.join(this.transcripts, `${id}.json`);
  }

  _loadTranscript(id) {
    try {
      return JSON.parse(fs.readFileSync(this._transcriptPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  saveTranscript(run) {
    const data = {
      id: run.id,
      title: run.title,
      project: run.project,
      updated_at: Date.now(),
      stats: run.stats,
      messages: run.messages(),
      todos: run.todos,
      tasks: run.taskList(),
    };
    const p = this._transcriptPath(run.id);
    fs.writeFileSync(p + ".tmp", JSON.stringify(data));
    fs.renameSync(p + ".tmp", p);
  }

  /** Thread state -> history detail, for chats with no transcript (e.g. started from a script). */
  async _detailFromState(id) {
    const [thread, state] = await Promise.all([this.hq.json(`/threads/${id}`), this.hq.json(`/threads/${id}/state`)]);
    const values = state?.values || {};
    const t0 = Date.parse(thread.created_at) || Date.now();
    const messages = (values.messages || []).map((m, i) => toMessage(m, t0 + i));
    return {
      id,
      title: thread.metadata?.title || firstUserText(messages) || "Untitled chat",
      project: thread.metadata?.project,
      updated_at: Date.parse(thread.updated_at) || Date.now(),
      stats: { run_id: id, started_at: t0, ended_at: Date.parse(thread.updated_at) || t0, tokens_in: sum(messages, "input_tokens"), tokens_out: sum(messages, "output_tokens") },
      messages,
      todos: values.todos || [],
      tasks: [],
    };
  }

  // ------------------------------------------------------------------ REST
  /**
   * Routes without the console token: the Approve/Reject buttons on a phone
   * notification. Each link is a one-time, unguessable token for one approval.
   * @param {import("express").Express} app
   */
  publicRoutes(app) {
    app.post("/api/notify/act/:token", async (req, res) => {
      const hit = this.notifier.takeAction(req.params.token);
      if (!hit) return res.status(410).type("text").send("This button has expired or was already used. Open HQ to decide.");
      const run = this.runs.get(hit.runId);
      const pending = run?.interrupts.some((x) => x.ids.includes(hit.interruptId) && x.decisions.length <= x.ids.indexOf(hit.interruptId));
      if (!run || !pending) return res.status(409).type("text").send("Already decided. Open HQ to see what happened.");
      run.decide(hit.interruptId, { action: hit.action, note: hit.action === "reject" ? "rejected from a phone notification" : undefined });
      res.type("text").send(hit.action === "approve" ? "Approved. HQ is continuing." : "Rejected. HQ has been told.");
    });
  }

  /** @param {import("express").Router} r */
  routes(r) {
    const wrap = (fn) => async (req, res) => {
      try {
        const out = await fn(req, res);
        if (out !== undefined && !res.headersSent) res.json(out);
      } catch (e) {
        const status = e instanceof HqError ? e.status : 500;
        if (!res.headersSent) res.status(status >= 400 && status < 600 ? status : 502).json({ detail: e.message || String(e) });
      }
    };
    const pass = (method, toPath, after) =>
      wrap(async (req) => {
        const out = await this.hq.json(toPath(req), { method, body: method === "GET" || method === "DELETE" ? undefined : req.body || {} });
        if (after) await after(req, out);
        return msTimes(out);
      });
    const skill = (req) => `/ops/skills/${encodeURIComponent(req.params.category)}/${encodeURIComponent(req.params.name)}`;
    const skillsChanged = async () => {
      await this._broadcastSkills();
      this._refreshTools();
    };

    r.get("/notify", (_req, res) => res.json(this.notifier.info()));
    r.post(
      "/notify/test",
      wrap(async () => {
        if (!this.notifier.enabled) throw new HqError(400, "notifications are off: set NTFY_TOPIC for the web service");
        if (!(await this.notifier.test())) throw new HqError(502, `ntfy did not accept it: ${this.notifier.lastError}`);
        return this.notifier.info();
      }),
    );

    r.get(
      "/history",
      wrap(async () => {
        // Aegra pages at most 100 threads per call (newest first).
        let threads = [];
        for (let offset = 0; offset < HISTORY_MAX; offset += 100) {
          const page = await this.hq.json("/threads/search", { body: { limit: 100, offset } });
          threads = threads.concat(page || []);
          if (!page || page.length < 100) break;
        }
        const runs = (threads || [])
          .map((t) => ({
            id: t.thread_id,
            title: t.metadata?.title || "Untitled chat",
            updated_at: Date.parse(t.updated_at) || 0,
            project: t.metadata?.project,
            status: t.status === "busy" ? "running" : t.status === "interrupted" && this.runs.get(t.thread_id)?.awaiting ? "approval" : undefined,
          }))
          .sort((a, b) => b.updated_at - a.updated_at);
        return { runs };
      }),
    );
    r.get(
      "/history/:id",
      wrap(async (req) => {
        const id = req.params.id;
        const live = this.runs.get(id);
        if (live?.active) return { ...live.detail(), running: true };
        const t = this._loadTranscript(id);
        if (t) return t;
        return this._detailFromState(id);
      }),
    );
    r.delete(
      "/history/:id",
      wrap(async (req) => {
        const id = req.params.id;
        if (this.runs.get(id)?.active) throw new HqError(409, "stop the run before deleting this chat");
        await this.hq.json(`/threads/${id}`, { method: "DELETE" }).catch((e) => {
          if (e.status !== 404) throw e;
        });
        fs.rmSync(this._transcriptPath(id), { force: true });
        this.runs.delete(id);
        return { deleted: id };
      }),
    );

    r.get("/skills/:category/:name", pass("GET", skill));
    r.put("/skills/:category/:name", pass("PUT", skill, skillsChanged));
    r.delete("/skills/:category/:name", pass("DELETE", skill, skillsChanged));
    r.post("/skills/:category/:name/enabled", pass("POST", (q) => `${skill(q)}/enabled`, skillsChanged));
    r.post("/skills/:category/:name/rollback", pass("POST", (q) => `${skill(q)}/rollback`, skillsChanged));
    r.post("/skills/:category/:name/adopt-builtin", pass("POST", (q) => `${skill(q)}/adopt-builtin`, skillsChanged));
    r.get("/skills/:category/:name/versions/:version", pass("GET", (q) => `${skill(q)}/versions/${encodeURIComponent(q.params.version)}`));
    r.get("/skill-proposals", pass("GET", (q) => `/ops/skill-proposals?status=${encodeURIComponent(String(q.query.status || "pending"))}`));
    r.get("/skill-proposals/:id", pass("GET", (q) => `/ops/skill-proposals/${encodeURIComponent(q.params.id)}`));
    r.post(
      "/skill-proposals/:id/:decision",
      wrap(async (req) => {
        if (!["approve", "reject"].includes(req.params.decision)) throw new HqError(400, "decision must be approve or reject");
        const out = await this.hq.json(`/ops/skill-proposals/${encodeURIComponent(req.params.id)}/${req.params.decision}`, { body: req.body || {} });
        if (req.params.decision === "approve") await skillsChanged();
        return msTimes(out);
      }),
    );

    r.get(
      "/sandboxes",
      wrap(async () => msTimes(await this.hq.json("/ops/sandboxes"))),
    );
    r.post(
      "/sandboxes/:project/:action",
      wrap(async (req) => {
        const p = encodeURIComponent(req.params.project);
        if (req.params.action === "stop") return this.hq.json(`/ops/sandboxes/${p}/stop`, { body: {} });
        if (req.params.action === "pin") return msTimes(await this.hq.json(`/ops/sandboxes/${p}/pin`, { body: { hours: Number(req.body?.hours) || 4 } }));
        if (req.params.action === "unpin") return this.hq.json(`/ops/sandboxes/${p}/pin`, { method: "DELETE" });
        throw new HqError(400, "action must be stop, pin or unpin");
      }),
    );
  }
}

// ======================================================================= run
/** One chat (HQ thread) and whatever run is currently streaming for it. */
class Run {
  /** @param {LiveBackend} be @param {string} id @param {string} project @param {any} transcript */
  constructor(be, id, project, transcript) {
    this.be = be;
    this.hub = be.hub;
    this.id = id;
    this.project = transcript?.project || project;
    this.title = transcript?.title || "";
    /** @type {Map<string, any>} */
    this.byId = new Map();
    this.order = [];
    for (const m of transcript?.messages || []) this._store(m);
    this.todos = transcript?.todos || [];
    /** @type {Map<string, any>} */
    this.tasks = new Map((transcript?.tasks || []).map((t) => [t.id, t]));
    this.nsToTask = new Map();
    this.chunks = new ChunkBuffer();
    this.flushTimers = new Map();
    this.counted = new Set(); // AI message ids whose usage is already in the stats
    this.prevTokens = { in: transcript?.stats?.tokens_in || 0, out: transcript?.stats?.tokens_out || 0 };
    this.active = false;
    this.paused = false;
    this.aegraRun = null;
    this.abort = null;
    /** @type {{lgId: string, ns: string|null, requests: any[], decisions: any[], ids: string[]}[]} */
    this.interrupts = [];
    /** @type {Set<string>} interrupts already answered this turn */
    this.decided = new Set();
    this.lastMain = null;
  }

  get awaiting() {
    return this.interrupts.length > 0;
  }

  begin() {
    this.active = true;
    this.paused = false;
    this.interrupts = [];
    this.decided = new Set();
    this.lastMain = null;
    this.stats = { run_id: this.id, started_at: Date.now(), tokens_in: this.prevTokens.in, tokens_out: this.prevTokens.out };
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => this.active && !this.paused && !this.awaiting && this.emit({ type: "stats", run_id: this.id, stats: { ...this.stats } }), STATS_MS);
    this.emit({ type: "status", run_id: this.id, status: "running" });
    this.emit({ type: "stats", run_id: this.id, stats: { ...this.stats } });
  }

  emit(f) {
    this.hub.broadcast(f);
  }

  messages() {
    return this.order.map((id) => this.byId.get(id)).filter(Boolean);
  }

  taskList() {
    return [...this.tasks.values()];
  }

  detail() {
    return {
      id: this.id,
      title: this.title,
      project: this.project,
      updated_at: Date.now(),
      stats: this.stats,
      messages: this.messages(),
      todos: this.todos,
      tasks: this.taskList(),
      pending_interrupts: this.pendingFrames(),
    };
  }

  _store(m) {
    if (!this.byId.has(m.id)) this.order.push(m.id);
    const prev = this.byId.get(m.id);
    // keep the first-seen timestamp
    this.byId.set(m.id, prev ? { ...prev, ...m, ts: prev.ts } : m);
    return this.byId.get(m.id);
  }

  addMessage(m) {
    this._store(m);
  }

  /** Emit a message (main flow or a sub-agent's inner stream). */
  _emitMessage(m, partial) {
    this.lastDetail = null; // the model answered; any "retrying…" note is stale
    const msg = this._store(m);
    if (msg.subagent_id) {
      this.emit({ type: "task", run_id: this.id, event: "inner", inner_id: msg.id, message: msg, partial });
    } else {
      this.emit({ type: "message", run_id: this.id, id: msg.id, partial, message: msg });
    }
  }

  // ------------------------------------------------------------ streaming
  /** Start streaming a run; `this.streaming` settles once the SSE stream has ended. */
  stream(body) {
    this.streaming = this._stream(body);
    return this.streaming;
  }

  /**
   * @param {any} body run request, or null to (re)join this.aegraRun
   */
  async _stream(body) {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let sawInterrupt = false;
    let path = body ? `/threads/${this.id}/runs/stream` : `/threads/${this.id}/runs/${this.aegraRun}/stream`;
    let rejoined = !body;
    // The run keeps going in HQ if this connection drops; we rejoin where we left off.
    let req = body ? { ...body, on_disconnect: "continue" } : null;
    if (body) this.lastEventId = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const { event, data, id } of this.be.hq.stream(path, req, signal, { lastEventId: this.lastEventId })) {
          if (id) this.lastEventId = id;
          attempt = 0;
          const [kind, ...nsParts] = event.split("|");
          const ns = nsParts.length ? nsParts.join("|") : null;
          if (kind === "metadata" && data?.run_id) this.aegraRun = data.run_id;
          else if (kind === "messages") this._onChunk(Array.isArray(data) ? data[0] : data, Array.isArray(data) ? data[1] : {}, ns);
          else if (kind === "updates") sawInterrupt = this._onUpdates(data, ns) || sawInterrupt;
          else if (kind === "values" && data?.__interrupt__) sawInterrupt = this._onInterrupts(data.__interrupt__, ns) || sawInterrupt;
          else if (kind === "custom") this._onCustom(data, ns);
          else if (kind === "error") throw new HqError(500, data?.message || data?.error || "run failed");
        }
        break;
      } catch (e) {
        if (signal.aborted) return; // pause/stop handled elsewhere
        const dropped = e instanceof HqError && e.status === 502 && this.aegraRun;
        if (!dropped || attempt >= REJOIN_ATTEMPTS) return this.fail(e.message || String(e));
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
        if (signal.aborted) return;
        path = `/threads/${this.id}/runs/${this.aegraRun}/stream`;
        req = null;
        rejoined = true;
      }
    }
    if (signal.aborted) return;
    // A rejoined stream only replays what the broker still has; an approval
    // request may have come and gone while we were away, so ask the thread.
    if (rejoined && !sawInterrupt && !this.awaiting) sawInterrupt = await this._pendingFromState();
    if (sawInterrupt || this.awaiting) {
      this.be.saveTranscript(this);
      return; // waiting for C; the run resumes on decision
    }
    this.finish(false);
  }

  /**
   * Pick up approvals waiting in the thread's state (after a rejoin or a console restart).
   * @param {boolean} [quiet] don't notify (a console restart re-finding old approvals)
   */
  async _pendingFromState(quiet = false) {
    const state = await this.be.hq.json(`/threads/${this.id}/state`).catch(() => null);
    const list = [...(state?.interrupts || [])];
    for (const t of state?.tasks || []) for (const it of t.interrupts || []) if (!list.some((x) => x.id === it.id)) list.push(it);
    return list.length ? this._onInterrupts(list, null, quiet) : false;
  }

  /** HQ's own stream events (resilience.py): show model retries/switches as they happen. */
  _onCustom(data, ns) {
    const kind = data?.hq;
    if (!kind) return;
    const where = ns ? " (sub-agent)" : "";
    let detail = null;
    if (kind === "model_retry") detail = `The model provider ${data.reason}${where}. Retrying in ${data.delay_s}s (${data.attempt}/${data.of})…`;
    else if (kind === "model_switch") detail = `${data.from} ${data.reason}${where}; switched to ${data.to}.`;
    else if (kind === "model_failed") detail = `The model provider ${data.reason}${where}; no tries left.`;
    if (!detail) return;
    this.lastDetail = detail;
    this.emit({ type: "status", run_id: this.id, status: "running", detail });
    if (kind === "model_switch") this.emit({ type: "notice", level: "warn", message: detail });
  }

  _onChunk(chunk, meta, ns) {
    if (!chunk || chunk.type !== "AIMessageChunk") return;
    const snap = this.chunks.add(chunk);
    if (!snap) return;
    const subagent = ns ? this._taskForNs(ns, meta?.lc_agent_name) : undefined;
    if (ns && !subagent) return;
    // Throttle: emit the growing snapshot at most every STREAM_FLUSH_MS per message.
    if (this.flushTimers.has(snap.id)) return;
    this.flushTimers.set(
      snap.id,
      setTimeout(() => {
        this.flushTimers.delete(snap.id);
        const cur = this.chunks.byId.get(snap.id);
        if (!cur || !this.active) return;
        if (this.byId.get(snap.id)?.final) return; // the complete message already arrived
        const m = { id: snap.id, role: "assistant", content: cur.text, ts: cur.ts };
        if (cur.thinking) m.thinking = cur.thinking;
        if (subagent) m.subagent_id = subagent;
        this._emitMessage(m, true);
      }, STREAM_FLUSH_MS),
    );
  }

  /** @returns {boolean} whether an interrupt arrived */
  _onUpdates(data, ns) {
    if (!data || typeof data !== "object") return false;
    let interrupted = false;
    for (const [node, upd] of Object.entries(data)) {
      if (node === "__interrupt__") {
        interrupted = this._onInterrupts(upd, ns) || interrupted;
        continue;
      }
      if (!upd || typeof upd !== "object") continue;
      if (Array.isArray(upd.todos) && !ns && JSON.stringify(upd.todos) !== JSON.stringify(this.todos)) {
        this.todos = upd.todos;
        this.emit({ type: "todos", run_id: this.id, todos: this.todos });
      }
      for (const raw of Array.isArray(upd.messages) ? upd.messages : []) this._onFinalMessage(raw, ns);
    }
    return interrupted;
  }

  _onFinalMessage(raw, ns) {
    if (!raw || typeof raw !== "object") return;
    if (raw.type === "human" && !raw.additional_kwargs?.hq_push_reminder) return; // our own input, already shown
    const subagent = ns ? this._taskForNs(ns, raw.name) : undefined;
    if (ns && !subagent) return;
    const t = this.chunks.firstSeen(raw.id) || this.byId.get(raw.id)?.ts || Date.now();
    const m = toMessage(raw, t, subagent);
    m.final = true;
    clearTimeout(this.flushTimers.get(m.id));
    this.flushTimers.delete(m.id);
    this.chunks.drop(m.id);

    if (m.role === "assistant" && raw.usage_metadata && !this.counted.has(m.id)) {
      this.counted.add(m.id);
      this.stats.tokens_in += raw.usage_metadata.input_tokens || 0;
      this.stats.tokens_out += raw.usage_metadata.output_tokens || 0;
    }
    const { final: _f, ...clean } = m;
    this._emitMessage(clean, false);
    this.byId.get(m.id).final = true;

    if (m.role === "assistant") {
      if (!subagent) this.lastMain = m.id;
      for (const c of m.tool_calls || []) {
        if (!subagent && c.name === "task") {
          const task = {
            id: c.id,
            description: String(c.args?.description || ""),
            agent: String(c.args?.subagent_type || "general-purpose"),
            status: "running",
            started_at: Date.now(),
          };
          this.tasks.set(task.id, task);
          this.emit({ type: "task", run_id: this.id, event: "start", task });
        }
        const key = c.name === "read_file" ? skillKeyFromPath(c.args?.file_path) : null;
        if (key && !this.be.loadedSkills.has(key)) {
          this.be.loadedSkills.add(key);
          this.be._broadcastSkills();
        }
      }
    }
    if (m.role === "tool" && !subagent && m.name === "task" && this.tasks.has(m.tool_call_id)) {
      const task = this.tasks.get(m.tool_call_id);
      const failed = m.status === "error";
      Object.assign(task, { status: failed ? "error" : "done", ended_at: Date.now(), [failed ? "error" : "report"]: m.content });
      this.emit({ type: "task", run_id: this.id, event: "end", subtask: { id: task.id, status: task.status, report: task.report, error: task.error } });
    }
  }

  /** Sub-agent namespaces look like "tools:<id>" (nested ones add "|tools:<id>"); map each to its task call. */
  _taskForNs(ns, agentName) {
    const top = ns.split("|")[0];
    if (this.nsToTask.has(top)) return this.nsToTask.get(top);
    const taken = new Set(this.nsToTask.values());
    const open = [...this.tasks.values()].filter((t) => t.status === "running" && !taken.has(t.id));
    const pick = open.find((t) => agentName && t.agent === agentName) || open[0];
    if (!pick) return undefined;
    this.nsToTask.set(top, pick.id);
    return pick.id;
  }

  // ------------------------------------------------------------- approvals
  _onInterrupts(list, ns, quiet = false) {
    let any = false;
    const fresh = [];
    for (const it of Array.isArray(list) ? list : []) {
      const value = it?.value;
      const requests = value?.action_requests;
      if (!Array.isArray(requests) || !requests.length || this.interrupts.some((x) => x.lgId === it.id)) continue;
      // Resuming a sub-agent's interrupt replays it once at the start of the new stream.
      if (this.decided.has(it.id)) continue;
      const entry = { lgId: it.id, ns, requests, decisions: [], ids: requests.map((_, i) => `${it.id}:${i}`) };
      this.interrupts.push(entry);
      fresh.push(entry);
      any = true;
    }
    if (any) for (const f of this.pendingFrames()) this.emit(f);
    if (!quiet) for (const e of fresh) e.requests.forEach((req, i) => this.be.notifier.approvalNeeded(this, e.ids[i], req.name));
    return any;
  }

  /** The interrupt frame(s) still waiting for a decision (one per pending action request). */
  pendingFrames() {
    const frames = [];
    for (const it of this.interrupts) {
      it.requests.forEach((req, i) => {
        if (i < it.decisions.length) return;
        frames.push({
          type: "interrupt",
          run_id: this.id,
          interrupt_id: it.ids[i],
          tool: req.name,
          args: req.args || {},
          message: firstLine(req.description) || `${req.name} needs your approval`,
        });
      });
    }
    return frames;
  }

  decide(interruptId, decision) {
    const it = this.interrupts.find((x) => x.ids.includes(interruptId));
    if (!it) return this.emit({ type: "error", run_id: this.id, message: "that approval is no longer pending", code: "stale_interrupt" });
    const idx = it.ids.indexOf(interruptId);
    if (idx !== it.decisions.length) return; // decisions arrive in order; ignore duplicates
    const req = it.requests[idx];
    const action = decision?.action === "reject" ? "reject" : "approve";
    if (action === "reject") {
      it.decisions.push({ type: "reject", message: decision?.note ? `C rejected this: ${decision.note}` : "C rejected this tool call." });
    } else if (decision?.edited_args && typeof decision.edited_args === "object") {
      it.decisions.push({ type: "edit", edited_action: { name: req.name, args: decision.edited_args } });
    } else {
      it.decisions.push({ type: "approve" });
    }
    if (this.interrupts.some((x) => x.decisions.length < x.requests.length)) return; // more to decide
    const done = this.interrupts;
    for (const x of done) this.decided.add(x.lgId);
    this.interrupts = [];
    // One pending interrupt: plain resume value. Several (parallel sub-agents): keyed by interrupt id.
    const resume = done.length === 1 ? { decisions: done[0].decisions } : Object.fromEntries(done.map((x) => [x.lgId, { decisions: x.decisions }]));
    this._resumeAfterInterrupt(resume);
  }

  /**
   * Aegra only accepts a resume once the thread is marked "interrupted", which
   * happens a moment after the interrupt reaches us. Wait for the stream to end
   * and the status to land; if it never does (e.g. the run was cut off), ask HQ
   * to re-open the pending interrupt from the checkpoint.
   */
  async _resumeAfterInterrupt(resume) {
    await this.streaming?.catch(() => {});
    const hq = this.be.hq;
    let status = "";
    for (let i = 0; i < 40; i++) {
      status = (await hq.json(`/threads/${this.id}`).catch(() => ({})))?.status || "";
      if (status === "interrupted") break;
      if (status !== "busy" && i >= 10) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (status !== "interrupted") {
      const state = await hq.json(`/threads/${this.id}/state`).catch(() => null);
      const pending = (state?.interrupts || []).length || (state?.tasks || []).some((t) => (t.interrupts || []).length);
      if (!pending) return this.fail("the approval is no longer pending in HQ (the run moved on or was cancelled)");
      try {
        await hq.json(`/ops/threads/${this.id}/reopen-interrupt`, { body: {} });
      } catch (e) {
        return this.fail(`could not resume after your decision: ${e.message}`);
      }
    }
    this._resumeStream({ command: { resume } });
  }

  _resumeStream(extra) {
    const body = { assistant_id: this.be.assistant, config: { configurable: { project: this.project } }, stream_mode: STREAM_MODE, stream_subgraphs: true, ...extra };
    this.stream(body);
  }

  // --------------------------------------------------------------- control
  async _cancel(action) {
    this.abort?.abort();
    if (!this.aegraRun) return;
    await this.be.hq.json(`/threads/${this.id}/runs/${this.aegraRun}/cancel?action=${action}`, { body: {} }).catch(() => {});
  }

  async stop() {
    if (this.awaiting) {
      this.interrupts = [];
      // Stopped instead of decided: let HQ know, or the approval comes back after a console
      // restart. HQ marks the thread "interrupted" a moment after the stream ends; wait for that.
      this._dismissWhenSettled();
    } else {
      await this._cancel("cancel");
    }
    this.finish(true);
  }

  async _dismissWhenSettled() {
    await this.streaming?.catch(() => {});
    for (let i = 0; i < 40; i++) {
      const status = (await this.be.hq.json(`/threads/${this.id}`).catch(() => ({})))?.status;
      if (status && status !== "busy") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.be.hq.json(`/ops/threads/${this.id}/dismiss-interrupt`, { body: {} }).catch((e) => console.error("dismiss failed:", e.message));
  }

  async pause() {
    if (this.paused || this.awaiting) return;
    this.paused = true;
    this.emit({ type: "status", run_id: this.id, status: "paused" });
    await this._cancel("interrupt");
    this._settlePartials();
  }

  /** A message cut off mid-stream (pause/stop) stays as far as it got, without a streaming cursor. */
  _settlePartials() {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    for (const [id, cur] of this.chunks.byId) {
      const prev = this.byId.get(id);
      if (!prev || prev.final) continue; // never shown, or already complete
      const m = { ...prev, content: cur.text || prev.content || "", final: true };
      if (cur.thinking) m.thinking = cur.thinking;
      const { final: _f, ...clean } = m;
      this._emitMessage(clean, false);
      this.byId.get(id).final = true;
    }
    this.chunks.byId.clear();
  }

  async resume() {
    if (!this.paused) return;
    this.paused = false;
    this.emit({ type: "status", run_id: this.id, status: "running" });
    // Any Command continues the thread from its last checkpoint (the pending
    // node runs again). A no-op update is the smallest one Aegra accepts; a
    // `resume` value would be wrong here since nothing is waiting for one.
    this._resumeStream({ command: { update: { messages: [] } } });
  }

  // ------------------------------------------------------------------ end
  finish(stopped) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.statsTimer);
    this._settlePartials();
    for (const t of this.tasks.values()) {
      if (t.status === "running") {
        Object.assign(t, { status: "error", ended_at: Date.now(), error: stopped ? "stopped" : "ended without a report" });
        this.emit({ type: "task", run_id: this.id, event: "end", subtask: { id: t.id, status: "error", error: t.error } });
      }
    }
    this.stats.ended_at = Date.now();
    this.prevTokens = { in: this.stats.tokens_in, out: this.stats.tokens_out };
    const last = this.lastMain ? this.byId.get(this.lastMain) : null;
    const message = !stopped && last && !(last.tool_calls || []).length ? stripFinal(last) : undefined;
    this.emit({ type: "done", run_id: this.id, message, stats: { ...this.stats } });
    if (!stopped) this.be.notifier.runFinished(this, this.stats.ended_at - this.stats.started_at);
    try {
      this.be.saveTranscript(this);
    } catch (e) {
      console.error("transcript save failed:", e);
    }
  }

  fail(message) {
    const reason = plainReason(message);
    // Keep it in the chat too, so the reason is still there when you come back.
    const note = { id: uid("sys-"), role: "system", content: `Run stopped: ${reason}`, ts: Date.now() };
    this.addMessage(note);
    this.emit({ type: "message", run_id: this.id, id: note.id, partial: false, message: note });
    this.emit({ type: "error", run_id: this.id, message: `HQ: ${reason}`, code: "run_failed" });
    if (this.active) this.be.notifier.runFailed(this, reason);
    this.finish(true);
  }
}

/** Provider errors arrive as SDK dumps; keep the sentence a person needs. */
function plainReason(message) {
  const s = String(message || "run failed");
  const code = /Error code: (\d{3})/.exec(s)?.[1] || /\b(52[0-9]|50[0-9]|429)\b/.exec(s)?.[1];
  if (code && s.length > 200) {
    const what = code === "524" ? "timed out (HTTP 524)" : code === "429" ? "is rate-limiting us (HTTP 429)" : `returned HTTP ${code}`;
    return `The model provider ${what}. Send a message to pick up where it left off.`;
  }
  return s.length > 400 ? `${s.slice(0, 399)}…` : s;
}

function stripFinal(m) {
  const { final: _f, ...rest } = m;
  return rest;
}

function firstLine(s) {
  return String(s || "").split("\n")[0].trim();
}

function firstUserText(messages) {
  return messages.find((m) => m.role === "user")?.content?.slice(0, 80);
}

function sum(messages, key) {
  return messages.reduce((n, m) => n + (m.usage?.[key] || 0), 0);
}

export { splitContent };
