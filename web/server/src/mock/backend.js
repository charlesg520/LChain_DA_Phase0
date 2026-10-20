// Standalone mock backend: reproduces the full contract with a scripted run,
// so the UI can be demoed and developed with no agent behind it.
import path from "node:path";
import { RunControl, SPEED, Stopped, VERSION, chunks, cleanPath, isTextMime, now, uid } from "../util.js";
import {
  ASSET_DIR,
  MEMORY_AGENTS,
  SKILL_BODIES,
  TOKEN_TS,
  TOOLS,
  buildFs,
  initialMcp,
  initialSkills,
  seededHistory,
} from "./data.js";

const MODEL = "mock:deepagent-sonnet";
const TARGET_IN = 48213;
const TARGET_OUT = 9477;

export class MockBackend {
  /** @param {{ broadcast: (frame:any)=>void }} hub */
  constructor(hub) {
    this.mode = "mock";
    this.hub = hub;
    this.fs = buildFs();
    this.memory = [{ path: "/AGENTS.md", content: MEMORY_AGENTS }];
    this.skills = initialSkills();
    this.skillFiles = Object.fromEntries(Object.entries(SKILL_BODIES).map(([k, v]) => [k, { "SKILL.md": v }]));
    this.skillHistory = Object.fromEntries(
      this.skills.map((s) => [s.name, [{ version: 1, ts: now() - 86400_000 * 3, source: "builtin", note: "", hash: uid() }]]),
    );
    this.skillHistory["db-query"].push({ version: 2, ts: now() - 86400_000, source: "manual", note: "added order query", hash: uid() });
    this.proposals = [
      {
        id: "sp-20261019-142233-a1b2",
        category: "data",
        name: "db-query",
        reason: "C asked for revenue by month twice this week; adding the query saves a round trip.",
        status: "pending",
        created_at: now() - 3 * 3600_000,
        proposed_by: "orchestrator",
        base_hash: null,
        files: {
          "SKILL.md":
            SKILL_BODIES["db-query"] +
            "\n## Revenue by month\n\n```sql\nSELECT date_trunc('month', created_at) AS month, SUM(total_cents) / 100.0 AS revenue\nFROM orders WHERE status = 'paid' GROUP BY 1 ORDER BY 1 DESC;\n```\n",
        },
      },
    ];
    this.tools = TOOLS;
    /** @type {any[]} */
    this.mcp = initialMcp();
    this.history = seededHistory();
    /** @type {Map<string, any>} */
    this.runs = new Map();
    this._connectMcp("fs-ops", ["fs_read", "fs_write", "fs_list"], 1200);
  }

  // ------------------------------------------------------------ snapshots
  hello() {
    return { type: "hello", version: VERSION, model: MODEL, mode: "mock", features: ["skill-studio", "pause", "approvals"], projects: ["default", "demo-app"] };
  }

  snapshots() {
    return [
      { type: "memory", files: this.memory },
      { type: "skills", skills: this.skills },
      { type: "tools", tools: this.tools },
      { type: "mcp", servers: this.mcp },
    ];
  }

  _broadcastSkills() {
    this.hub.broadcast({ type: "skills", skills: this.skills });
  }

  _broadcastMcp() {
    this.hub.broadcast({ type: "mcp", servers: this.mcp });
  }

  _connectMcp(id, tools, delay) {
    delay = delay / SPEED;
    setTimeout(() => {
      const s = this.mcp.find((x) => x.id === id);
      if (!s || s.status !== "connecting") return;
      s.status = "connected";
      s.tools = tools;
      s.error = undefined;
      this._broadcastMcp();
    }, delay);
  }

  // ---------------------------------------------------------------- uplink
  /** @param {{send:(f:any)=>void}} client */
  async handle(client, frame) {
    switch (frame.type) {
      case "chat":
        return this._chat(frame);
      case "interrupt":
        return this._decide(frame);
      case "control":
        return this._control(frame);
      case "files":
        return client.send(this._list(frame.path));
      case "file":
        return client.send(this._read(frame.path));
      case "memory":
        return client.send({ type: "memory", files: this.memory });
      case "memory-save":
        return this._saveMemory(frame);
      case "skills":
        return client.send({ type: "skills", skills: this.skills });
      case "tools":
        return client.send({ type: "tools", tools: this.tools });
      case "mcp":
        return client.send({ type: "mcp", servers: this.mcp });
      case "skills-toggle":
        return this._toggleSkill(client, frame.name);
      case "mcp-add":
        return this._mcpAdd(frame);
      case "mcp-remove":
        this.mcp = this.mcp.filter((s) => s.id !== frame.id);
        return this._broadcastMcp();
      case "mcp-toggle":
        return this._mcpToggle(frame);
      default:
        return client.send({ type: "error", message: `unknown frame type: ${frame.type}`, code: "bad_frame" });
    }
  }

  _toggleSkill(client, name) {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return client.send({ type: "error", message: `no skill named ${name}`, code: "skill_not_found" });
    skill.status = skill.status === "loaded" ? "idle" : "loaded";
    this._broadcastSkills();
  }

  _mcpAdd(f) {
    if (!f.id || !f.name) return this.hub.broadcast({ type: "error", message: "mcp-add needs id and name", code: "bad_frame" });
    this.mcp = this.mcp.filter((s) => s.id !== f.id);
    this.mcp.push({
      id: f.id,
      name: f.name,
      transport: f.transport || "stdio",
      command: f.command,
      url: f.url,
      env: f.env,
      headers: f.headers,
      agents: f.agents,
      status: "connecting",
      tools: [],
      started_at: now(),
    });
    this._broadcastMcp();
    this._connectMcp(f.id, ["demo_echo", "demo_lookup"], 900);
  }

  _mcpToggle(f) {
    const s = this.mcp.find((x) => x.id === f.id);
    if (!s) return;
    if (f.enabled) {
      s.status = "connecting";
      s.error = undefined;
      s.started_at = now();
      this._broadcastMcp();
      const tools = s.id === "fs-ops" ? ["fs_read", "fs_write", "fs_list"] : ["demo_echo", "demo_lookup"];
      this._connectMcp(s.id, tools, 900);
    } else {
      s.status = "disconnected";
      s.tools = [];
      s.started_at = undefined;
      this._broadcastMcp();
    }
  }

  _saveMemory(f) {
    const p = cleanPath(f.path);
    const existing = this.memory.find((m) => m.path === p);
    if (existing) existing.content = f.content;
    else this.memory.push({ path: p, content: f.content });
    const node = this.fs.get(p);
    if (node && node.type === "file") {
      node.content = Buffer.from(f.content);
      node.modified_at = now();
    }
    this.hub.broadcast({ type: "memory", files: this.memory });
  }

  // ---------------------------------------------------------------- files
  _list(rawPath) {
    const p = cleanPath(rawPath || "/");
    const prefix = p === "/" ? "/" : p + "/";
    const entries = [];
    for (const [full, node] of this.fs) {
      if (full === p || !full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      entries.push({
        name: rest,
        path: full,
        type: node.type,
        size: node.type === "file" ? node.content.length : 0,
        mime: node.type === "file" ? node.mime : "inode/directory",
        modified_at: node.modified_at,
      });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { type: "fs", path: p, entries };
  }

  _read(rawPath) {
    const p = cleanPath(rawPath);
    const node = this.fs.get(p);
    if (!node || node.type !== "file") {
      return { type: "error", message: `no such file: ${p}`, code: "file_not_found" };
    }
    const text = isTextMime(node.mime);
    return {
      type: "file",
      path: p,
      result: {
        path: p,
        content: text ? node.content.toString("utf8") : node.content.toString("base64"),
        encoding: text ? "utf8" : "base64",
        mime: node.mime,
        size: node.content.length,
      },
    };
  }

  // ------------------------------------------------------------------ runs
  _control(f) {
    const run = this.runs.get(f.run_id);
    if (!run) return;
    if (f.cmd === "stop") {
      run.ctl.stop();
      if (run.waiting) run.waiting.resolve(null);
    } else if (f.cmd === "pause") {
      run.ctl.paused = true;
      this.hub.broadcast({ type: "status", run_id: f.run_id, status: "paused" });
    } else if (f.cmd === "resume") {
      run.ctl.paused = false;
      this.hub.broadcast({ type: "status", run_id: f.run_id, status: "running" });
    }
  }

  _decide(f) {
    const run = this.runs.get(f.run_id);
    if (!run || !run.waiting || run.waiting.id !== f.interrupt_id) {
      return this.hub.broadcast({ type: "error", run_id: f.run_id, message: "no pending approval with that id", code: "stale_interrupt" });
    }
    const w = run.waiting;
    run.waiting = null;
    w.resolve(f.decision);
  }

  _chat(f) {
    const runId = f.run_id || uid("run-");
    const existing = this.runs.get(runId);
    if (existing && existing.active) {
      return this.hub.broadcast({ type: "error", run_id: runId, message: "a run is already in progress", code: "another_run_active" });
    }
    const first = !existing;
    const run = existing || { id: runId, title: f.content.slice(0, 60), messages: [], todos: [], tasks: [] };
    run.active = true;
    run.ctl = new RunControl();
    run.waiting = null;
    run.stats = { run_id: runId, started_at: now(), tokens_in: 0, tokens_out: 0 };
    this.runs.set(runId, run);
    run.messages.push({ id: uid("u-"), role: "user", content: f.content, ts: now() });
    const script = first ? this._script(run) : this._followup(run, f.content);
    script.catch((e) => {
      if (!(e instanceof Stopped)) {
        this.hub.broadcast({ type: "error", run_id: runId, message: String(e?.message || e), code: "mock_failure" });
      }
    }).finally(() => this._finish(run));
  }

  _finish(run) {
    clearInterval(run.statsTimer);
    run.active = false;
    run.stats.ended_at = now();
    const stopped = run.ctl.stopped;
    this.hub.broadcast({ type: "done", run_id: run.id, message: stopped ? undefined : run.final, stats: run.stats });
    run.final = undefined;
    this._saveHistory(run);
  }

  _saveHistory(run) {
    const entry = {
      id: run.id,
      title: run.title,
      updated_at: now(),
      stats: { ...run.stats },
      messages: run.messages.map((m) => ({ ...m })),
      todos: run.todos.map((t) => ({ ...t })),
      tasks: run.tasks.map((t) => ({ ...t })),
    };
    this.history = [entry, ...this.history.filter((h) => h.id !== run.id)];
  }

  _startStats(run, durationMs) {
    const t0 = now();
    const send = () => {
      const frac = Math.min(1, (now() - t0) / durationMs);
      run.stats.tokens_in = Math.round(TARGET_IN * 0.95 * frac);
      run.stats.tokens_out = Math.round(TARGET_OUT * 0.9 * frac);
      this.hub.broadcast({ type: "stats", run_id: run.id, stats: { ...run.stats } });
    };
    send();
    run.statsTimer = setInterval(() => {
      if (!run.ctl.paused) send();
    }, 2000 / SPEED);
  }

  _todos(run, statuses) {
    run.todos = run.todos.map((t, i) => ({ ...t, status: statuses[i] ?? t.status }));
    this.hub.broadcast({ type: "todos", run_id: run.id, todos: run.todos });
  }

  /**
   * Stream an assistant message token by token; optional tool calls arrive with the final frame.
   * @param {any} run
   * @param {string} text
   * @param {{toolCalls?: any[], usage?: any, subagent?: string, speed?: number}} [opts]
   */
  async _say(run, text, { toolCalls, usage, subagent, speed = 45 } = {}) {
    const msg = { id: uid("a-"), role: "assistant", content: "", ts: now() };
    if (subagent) msg.subagent_id = subagent;
    for (const piece of chunks(text, 2)) {
      await run.ctl.tick(speed);
      msg.content += piece;
      this._emitMessage(run, msg, true, subagent);
    }
    if (toolCalls) msg.tool_calls = toolCalls;
    if (usage) msg.usage = usage;
    await run.ctl.tick(60);
    this._emitMessage(run, msg, false, subagent);
    run.messages.push(msg);
    return msg;
  }

  _emitMessage(run, msg, partial, subagent) {
    const snapshot = { ...msg };
    if (subagent) {
      this.hub.broadcast({ type: "task", run_id: run.id, event: "inner", inner_id: msg.id, message: snapshot, partial });
    } else {
      this.hub.broadcast({ type: "message", run_id: run.id, id: msg.id, partial, message: snapshot });
    }
  }

  /**
   * @param {any} run
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {string} result
   * @param {{subagent?: string, delay?: number, text?: string, usage?: any}} [opts]
   */
  async _call(run, name, args, result, { subagent, delay = 500, text = "", usage } = {}) {
    const call = { id: uid("call-"), name, args };
    await this._say(run, text, { toolCalls: [call], usage, subagent });
    await run.ctl.tick(delay);
    const res = { id: uid("t-"), role: "tool", name, tool_call_id: call.id, content: result, ts: now(), status: "ok" };
    if (subagent) res.subagent_id = subagent;
    this._emitMessage(run, res, false, subagent);
    run.messages.push(res);
    return call;
  }

  async _script(run) {
    this._startStats(run, 26_000 / SPEED);
    run.todos = [
      { content: "Map the auth module", status: "in_progress" },
      { content: "Trace refresh-token validation", status: "pending" },
      { content: "Fix the expiry check and verify", status: "pending" },
    ];
    this.hub.broadcast({ type: "todos", run_id: run.id, todos: run.todos });
    await run.ctl.tick(400);

    await this._call(run, "ls", { path: "/workspace" }, "src/\ndocs/\nmedia/\nREADME.md", {
      text: "I'll start by mapping the workspace, then trace the token flow.",
      usage: { input_tokens: 3812, output_tokens: 96 },
    });
    await this._call(run, "read_file", { file_path: "/workspace/src/auth.ts" }, this.fs.get("/workspace/src/auth.ts").content.toString(), {
      delay: 700,
      usage: { input_tokens: 4120, output_tokens: 41 },
    });

    // grep: the agent pulls in the crypto-tools skill while searching
    const grepCall = { id: uid("call-"), name: "grep", args: { pattern: "token", path: "/workspace/src" } };
    await this._say(run, "Now finding everything that touches tokens.", { toolCalls: [grepCall], usage: { input_tokens: 5904, output_tokens: 58 } });
    const crypto = this.skills.find((s) => s.name === "crypto-tools");
    if (crypto) {
      crypto.status = "loaded";
      this._broadcastSkills();
    }
    await run.ctl.tick(650);
    const grepOut =
      "/workspace/src/auth.ts:1: import { verifyAccess, rotateRefresh } from \"./token\";\n" +
      "/workspace/src/auth.ts:12: const token = header.startsWith(\"Bearer \") ? header.slice(7) : null;\n" +
      "/workspace/src/auth.ts:21: const pair = await rotateRefresh(req.body.refresh_token);\n" +
      "/workspace/src/token.ts:19: export async function rotateRefresh(token: string) {\n" +
      "/workspace/src/token.ts:24: if (exp < now) reject();";
    const grepRes = { id: uid("t-"), role: "tool", name: "grep", tool_call_id: grepCall.id, content: grepOut, ts: now(), status: "ok" };
    this._emitMessage(run, grepRes, false);
    run.messages.push(grepRes);
    this._todos(run, ["completed", "in_progress"]);

    // sub-agent
    const taskArgs = { description: "trace how JWT refresh tokens are validated", subagent_type: "general-purpose" };
    const taskCall = { id: uid("call-"), name: "task", args: taskArgs };
    await this._say(run, "Handing the refresh path to a focused sub-agent.", { toolCalls: [taskCall], usage: { input_tokens: 6611, output_tokens: 112 } });
    const sub = { id: taskCall.id, description: taskArgs.description, agent: "general-purpose", status: "running", started_at: now() };
    run.tasks.push(sub);
    this.hub.broadcast({ type: "task", run_id: run.id, event: "start", task: { ...sub } });
    await run.ctl.tick(500);
    await this._say(run, "Reading `token.ts` to find where refresh tokens are checked.", { subagent: sub.id, usage: { input_tokens: 2210, output_tokens: 64 } });
    await this._call(run, "read_file", { file_path: "/workspace/src/token.ts" }, this.fs.get("/workspace/src/token.ts").content.toString(), {
      subagent: sub.id,
      delay: 800,
      usage: { input_tokens: 2480, output_tokens: 38 },
    });
    await this._say(
      run,
      "`rotateRefresh` decodes the claims, checks `kind === \"refresh\"`, then compares expiry with `exp < now`. " +
        "A token whose `exp` equals the current second still passes, one second past its lifetime. " +
        "RFC 7519 says the token must be rejected **on or after** `exp`.",
      { subagent: sub.id, usage: { input_tokens: 3920, output_tokens: 211 } },
    );
    const report =
      "Found an off-by-one expiry check in `rotateRefresh` (`/workspace/src/token.ts:24`): `exp < now` accepts a refresh token " +
      "in its final second. Use `exp <= now`.";
    Object.assign(sub, { status: "done", ended_at: now(), report });
    this.hub.broadcast({ type: "task", run_id: run.id, event: "end", subtask: { id: sub.id, status: "done", report } });
    const taskRes = { id: uid("t-"), role: "tool", name: "task", tool_call_id: taskCall.id, content: report, ts: now(), status: "ok" };
    this._emitMessage(run, taskRes, false);
    run.messages.push(taskRes);
    this._todos(run, ["completed", "completed", "in_progress"]);
    await run.ctl.tick(400);

    // human-in-the-loop edit
    const editArgs = {
      file: "/workspace/src/token.ts",
      old_string: "if (exp < now) reject();",
      new_string: "if (exp <= now) reject();",
      note: "fix expiry boundary",
    };
    const editCall = { id: uid("call-"), name: "edit_file", args: editArgs };
    await this._say(run, "The sub-agent confirmed it. Here's the one-character fix; it needs your approval.", {
      toolCalls: [editCall],
      usage: { input_tokens: 7340, output_tokens: 140 },
    });
    const interruptId = uid("int-");
    const decision = await new Promise((resolve) => {
      run.waiting = { id: interruptId, resolve };
      this.hub.broadcast({
        type: "interrupt",
        run_id: run.id,
        interrupt_id: interruptId,
        tool: "edit_file",
        args: editArgs,
        message: "edit_file on /workspace/src/token.ts requires approval",
      });
    });
    if (!decision) throw new Stopped();

    if (decision.action === "reject") {
      const res = { id: uid("t-"), role: "tool", name: "edit_file", tool_call_id: editCall.id, content: `Rejected by C${decision.note ? `: ${decision.note}` : "."}`, ts: now(), status: "error" };
      this._emitMessage(run, res, false);
      run.messages.push(res);
      const note = decision.note ? ` Your note: "${decision.note}".` : "";
      run.final = await this._say(run, `OK, leaving token.ts untouched.${note}`, { usage: { input_tokens: 820, output_tokens: 24 } });
      run.stats.tokens_in = Math.round(TARGET_IN * 0.8);
      run.stats.tokens_out = Math.round(TARGET_OUT * 0.7);
      return;
    }

    const args = decision.edited_args || editArgs;
    const file = String(args.file ?? args.file_path ?? editArgs.file);
    const node = this.fs.get(cleanPath(file));
    let resultText = `Updated ${file}`;
    if (node && node.type === "file") {
      const before = node.content.toString();
      if (before.includes(String(args.old_string))) {
        node.content = Buffer.from(before.replace(String(args.old_string), String(args.new_string)));
        node.modified_at = now();
      } else {
        resultText = `old_string not found in ${file}; nothing changed`;
      }
    }
    const editRes = { id: uid("t-"), role: "tool", name: "edit_file", tool_call_id: editCall.id, content: resultText, ts: now(), status: "ok" };
    this._emitMessage(run, editRes, false);
    run.messages.push(editRes);
    await run.ctl.tick(400);
    const fixed = this.fs.get("/workspace/src/token.ts")?.content.toString() ?? TOKEN_TS;
    const line = fixed.split("\n").findIndex((l) => l.includes("reject();") && l.includes("exp")) + 1;
    await this._call(run, "grep", { pattern: "exp <=? now", path: "/workspace/src" }, `/workspace/src/token.ts:${line}: ${fixed.split("\n")[line - 1]?.trim()}`, {
      text: "Verifying the edit landed (house rule: grep before declaring success).",
      usage: { input_tokens: 7990, output_tokens: 61 },
    });
    this._todos(run, ["completed", "completed", "completed"]);
    await this._say(run, "Verified.", { usage: { input_tokens: 120, output_tokens: 4 } });
    run.final = await this._say(
      run,
      [
        "## Fixed: refresh tokens accepted one second too long",
        "",
        "`rotateRefresh` compared expiry with a strict `<`, so a refresh token was still accepted in the exact second it expired.",
        "",
        "```ts",
        "// src/token.ts",
        "if (!claims || claims.kind !== \"refresh\") return null;",
        "if (exp <= now) reject(); // was: exp < now",
        "```",
        "",
        "| Check | Result |",
        "|---|---|",
        "| Edit applied | yes |",
        "| Verified with grep | yes |",
        "| Other `exp` comparisons | none found |",
        "",
        "Next step: add a test for `exp === now`.",
      ].join("\n"),
      { usage: { input_tokens: 1200, output_tokens: 380 }, speed: 30 },
    );
    run.stats.tokens_in = TARGET_IN;
    run.stats.tokens_out = TARGET_OUT;
  }

  async _followup(run, content) {
    this._startStats(run, 4000 / SPEED);
    await run.ctl.tick(300);
    run.final = await this._say(
      run,
      `Mock mode replays one scripted job per chat; follow-ups get this short reply. You said:\n\n> ${content.replace(/\n/g, "\n> ")}\n\nStart a **new chat** to watch the full run again, or switch the server to live mode to talk to HQ.`,
      { usage: { input_tokens: 1400, output_tokens: 90 } },
    );
  }

  // ------------------------------------------------------------------ REST
  /** @param {import("express").Router} r */
  routes(r) {
    r.get("/history", (_req, res) => {
      res.json({ runs: this.history.map((h) => ({ id: h.id, title: h.title, updated_at: h.updated_at })) });
    });
    r.get("/history/:id", (req, res) => {
      const live = this.runs.get(req.params.id);
      if (live && live.active) {
        return res.json({ id: live.id, title: live.title, updated_at: now(), stats: live.stats, messages: live.messages, todos: live.todos, tasks: live.tasks, running: true });
      }
      const h = this.history.find((x) => x.id === req.params.id);
      if (!h) return res.status(404).json({ error: "not found" });
      res.json(h);
    });
    r.delete("/history/:id", (req, res) => {
      this.history = this.history.filter((x) => x.id !== req.params.id);
      this.runs.delete(req.params.id);
      res.json({ deleted: req.params.id });
    });

    // ---- skill studio (HQ extension)
    const skillKey = (req) => this.skills.find((s) => s.category === req.params.category && s.name === req.params.name);
    r.get("/skills/:category/:name", (req, res) => {
      const s = skillKey(req);
      if (!s) return res.status(404).json({ detail: "no such skill" });
      res.json({ category: s.category, name: s.name, files: this.skillFiles[s.name] || { "SKILL.md": "" }, hash: uid(), history: this.skillHistory[s.name] || [] });
    });
    r.put("/skills/:category/:name", (req, res) => {
      const { category, name } = req.params;
      const files = req.body?.files || {};
      const err = validateSkill(category, name, files);
      if (err) return res.status(400).json({ detail: err });
      let s = skillKey(req);
      const meta = frontmatter(files["SKILL.md"]);
      if (!s) {
        s = { name, category, description: meta.description, file: `/skills/${category}/${name}`, source: "manual", status: "idle", enabled: true, version: 0 };
        this.skills.push(s);
        this.skillHistory[name] = [];
      }
      s.description = meta.description;
      s.version = (s.version || 0) + 1;
      this.skillFiles[name] = files;
      this.skillHistory[name].push({ version: s.version, ts: now(), source: "manual", note: req.body?.note || "", hash: uid() });
      this._broadcastSkills();
      res.json({ version: s.version });
    });
    r.get("/skills/:category/:name/versions/:version", (req, res) => {
      const s = skillKey(req);
      if (!s) return res.status(404).json({ detail: "no such skill" });
      const v = Number(req.params.version);
      if (!(this.skillHistory[s.name] || []).some((h) => h.version === v)) return res.status(404).json({ detail: `${s.name} has no version ${v}` });
      res.json({ version: v, files: this.skillFiles[s.name] || { "SKILL.md": "" } });
    });
    r.post("/skills/:category/:name/enabled", (req, res) => {
      const s = skillKey(req);
      if (!s) return res.status(404).json({ detail: "no such skill" });
      s.enabled = !!req.body?.enabled;
      if (!s.enabled) s.status = "idle";
      this._broadcastSkills();
      res.json({ enabled: s.enabled });
    });
    r.post("/skills/:category/:name/rollback", (req, res) => {
      const s = skillKey(req);
      if (!s) return res.status(404).json({ detail: "no such skill" });
      s.version = (s.version || 0) + 1;
      this.skillHistory[s.name].push({ version: s.version, ts: now(), source: `rollback:v${req.body?.version}`, note: "", hash: uid() });
      this._broadcastSkills();
      res.json({ version: s.version, restored_from: req.body?.version });
    });
    r.delete("/skills/:category/:name", (req, res) => {
      const s = skillKey(req);
      if (!s) return res.status(404).json({ detail: "no such skill" });
      this.skills = this.skills.filter((x) => x !== s);
      this._broadcastSkills();
      res.json({ deleted: `${s.category}/${s.name}` });
    });
    r.get("/skill-proposals", (req, res) => {
      const status = req.query.status || "pending";
      res.json(this.proposals.filter((p) => status === "all" || p.status === status).map(({ files: _f, ...p }) => p));
    });
    r.get("/skill-proposals/:id", (req, res) => {
      const p = this.proposals.find((x) => x.id === req.params.id);
      if (!p) return res.status(404).json({ detail: "no such proposal" });
      const live = this.skillFiles[p.name] || {};
      res.json({ ...p, diff: simpleDiff(live, p.files), live_changed_since_proposed: false });
    });
    r.post("/skill-proposals/:id/:decision", (req, res) => {
      const p = this.proposals.find((x) => x.id === req.params.id);
      if (!p) return res.status(404).json({ detail: "no such proposal" });
      if (p.status !== "pending") return res.status(400).json({ detail: `${p.id} is ${p.status}, not pending` });
      if (req.params.decision === "approve") {
        const s = this.skills.find((x) => x.name === p.name);
        p.files = req.body?.files || p.files;
        this.skillFiles[p.name] = p.files;
        if (s) {
          s.version = (s.version || 0) + 1;
          this.skillHistory[s.name].push({ version: s.version, ts: now(), source: `proposal:${p.id}`, note: p.reason, hash: uid() });
          p.version = s.version;
        }
        p.status = "approved";
        this._broadcastSkills();
      } else if (req.params.decision === "reject") {
        p.status = "rejected";
      } else {
        return res.status(400).json({ detail: "decision must be approve or reject" });
      }
      p.decided_at = now();
      p.decision_note = req.body?.note || null;
      res.json(p);
    });

    // ---- sandboxes (HQ extension)
    r.get("/sandboxes", (_req, res) => {
      res.json({
        reaper: { enabled: true, running: true, idle_stop_minutes: 30, idle_remove_hours: 24 },
        hosts: {
          "tcp://docker-proxy:2375": {
            reachable: true,
            stop_after_s: 1800,
            sandboxes: [{ name: "hq-sbx-demo-app", project: "demo-app", status: "running", idle_s: 240, busy: false, pinned_until: null }],
          },
        },
      });
    });
    r.post("/sandboxes/:project/:action", (req, res) => res.json({ done: [`${req.params.action} hq-sbx-${req.params.project} (mock)`] }));
  }

  /** @param {import("express").Express} app */
  media(app, express) {
    app.use("/media", express.static(ASSET_DIR, { index: false, fallthrough: false }));
  }
}

function frontmatter(text = "") {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function validateSkill(category, name, files) {
  const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
  if (!slug.test(category)) return `category ${JSON.stringify(category)}: use lowercase letters, digits and hyphens`;
  if (!slug.test(name)) return `name ${JSON.stringify(name)}: use lowercase letters, digits and hyphens`;
  if (!files["SKILL.md"]) return "a skill needs a SKILL.md";
  const meta = frontmatter(files["SKILL.md"]);
  if (!Object.keys(meta).length) return "SKILL.md must start with YAML frontmatter (name, description)";
  if (meta.name !== name) return `frontmatter name is ${JSON.stringify(meta.name)} but the skill folder is ${JSON.stringify(name)}`;
  if (!meta.description) return "frontmatter needs a description";
  for (const p of Object.keys(files)) {
    if (p.startsWith("/") || p.split("/").includes("..") || path.posix.basename(p).startsWith(".")) return `bad file path ${p}`;
  }
  return null;
}

/** Line diff good enough for the mock's review screen (unified-ish, whole file). */
function simpleDiff(oldFiles, newFiles) {
  const out = [];
  for (const f of [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].sort()) {
    const a = (oldFiles[f] || "").split("\n");
    const b = (newFiles[f] || "").split("\n");
    if (a.join("\n") === b.join("\n")) continue;
    out.push(`--- a/${f}`, `+++ b/${f}`, `@@ -1,${a.length} +1,${b.length} @@`);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) out.push(" " + a[i++]);
    let j = a.length - 1;
    let k = b.length - 1;
    const tail = [];
    while (j >= i && k >= i && a[j] === b[k]) tail.unshift(" " + a[j--]) && k--;
    for (let x = i; x <= j; x++) out.push("-" + a[x]);
    for (let x = i; x <= k; x++) out.push("+" + b[x]);
    out.push(...tail);
  }
  return out.join("\n") + "\n";
}
