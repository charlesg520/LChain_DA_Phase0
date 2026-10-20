import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { connect, startServer } from "./helpers.js";

let srv;
before(async () => {
  srv = await startServer({ HQ_WEB_MODE: "mock", MOCK_SPEED: "25" });
});
after(() => srv?.stop());

describe("mock server contract", () => {
  test("hello is followed by memory, skills, tools and mcp snapshots", async () => {
    const c = await connect(srv.port);
    const hello = await c.waitFor((f) => f.type === "hello");
    assert.equal(hello.mode, "mock");
    assert.ok(hello.version && hello.model);
    await c.waitFor((f) => f.type === "mcp");
    const types = c.frames.slice(0, 5).map((f) => f.type);
    assert.deepEqual(types, ["hello", "memory", "skills", "tools", "mcp"]);
    const mem = c.frames[1];
    assert.equal(mem.files[0].path, "/AGENTS.md");
    assert.match(mem.files[0].content, /House rules/);
    assert.deepEqual(c.frames[2].skills.map((s) => s.name), ["crypto-tools", "web-scraper", "db-query"]);
    assert.deepEqual(c.frames[3].tools.map((t) => t.name), ["ls", "read_file", "write_file", "edit_file", "grep", "task", "memory"]);
    for (const t of c.frames[3].tools) assert.doesNotThrow(() => JSON.parse(t.schema));
    const [fsOps, web] = c.frames[4].servers;
    assert.equal(web.status, "error");
    assert.match(web.error, /ECONNREFUSED/);
    // fs-ops flips from connecting to connected shortly after
    if (fsOps.status === "connecting") {
      const up = await c.waitFor((f) => f.type === "mcp" && f.servers.find((s) => s.id === "fs-ops")?.status === "connected");
      assert.deepEqual(up.servers.find((s) => s.id === "fs-ops").tools, ["fs_read", "fs_write", "fs_list"]);
    }
    c.close();
  });

  test("ping/pong, files, file (text and binary)", async () => {
    const c = await connect(srv.port);
    c.send({ type: "ping", ts: 123 });
    assert.equal((await c.waitFor((f) => f.type === "pong")).ts, 123);
    c.send({ type: "files", path: "/workspace" });
    const listing = await c.waitFor((f) => f.type === "fs" && f.path === "/workspace");
    assert.deepEqual(listing.entries.map((e) => e.name), ["docs", "media", "src"]);
    c.send({ type: "files" });
    const root = await c.waitFor((f) => f.type === "fs" && f.path === "/");
    assert.ok(root.entries.some((e) => e.name === "README.md"));
    c.send({ type: "file", path: "/workspace/src/auth.ts" });
    const auth = await c.waitFor((f) => f.type === "file" && f.path === "/workspace/src/auth.ts");
    assert.equal(auth.result.encoding, "utf8");
    assert.match(auth.result.content, /requireAuth/);
    c.send({ type: "file", path: "/workspace/media/logo.png" });
    const png = await c.waitFor((f) => f.type === "file" && f.path.endsWith("logo.png"));
    assert.equal(png.result.encoding, "base64");
    assert.equal(Buffer.from(png.result.content, "base64").subarray(1, 4).toString(), "PNG");
    c.send({ type: "file", path: "/nope.txt" });
    assert.equal((await c.waitFor((f) => f.type === "error" && f.code === "file_not_found")).code, "file_not_found");
    c.close();
  });

  test("skills toggle, memory save, mcp add/toggle/remove", async () => {
    const c = await connect(srv.port);
    await c.waitFor((f) => f.type === "skills");
    c.send({ type: "skills-toggle", name: "web-scraper" });
    const loaded = await c.waitFor((f) => f.type === "skills" && f.skills.find((s) => s.name === "web-scraper").status === "loaded");
    assert.ok(loaded);
    c.send({ type: "skills-toggle", name: "web-scraper" });
    await c.waitFor((f, i) => f.type === "skills" && f.skills.find((s) => s.name === "web-scraper").status === "idle" && f !== loaded);

    c.send({ type: "memory-save", path: "/AGENTS.md", content: "# House rules\n- new rule\n" });
    await c.waitFor((f) => f.type === "memory" && f.files[0].content.includes("new rule"));

    c.send({ type: "mcp-add", id: "x1", name: "demo", transport: "sse", url: "http://localhost:1/sse", headers: { A: "b" } });
    const connecting = await c.waitFor((f) => f.type === "mcp" && f.servers.find((s) => s.id === "x1")?.status === "connecting");
    assert.equal(connecting.servers.find((s) => s.id === "x1").headers.A, "b");
    const up = await c.waitFor((f) => f.type === "mcp" && f.servers.find((s) => s.id === "x1")?.status === "connected");
    assert.deepEqual(up.servers.find((s) => s.id === "x1").tools, ["demo_echo", "demo_lookup"]);
    c.send({ type: "mcp-toggle", id: "x1", enabled: false });
    await c.waitFor((f) => f.type === "mcp" && f.servers.find((s) => s.id === "x1")?.status === "disconnected");
    c.send({ type: "mcp-remove", id: "x1" });
    await c.waitFor((f) => f.type === "mcp" && !f.servers.some((s) => s.id === "x1"));
    c.close();
  });

  test("scripted run with approval: todos, tools, sub-agent, interrupt, edit applied, done", async () => {
    const c = await connect(srv.port);
    await c.waitFor((f) => f.type === "mcp");
    const runId = "run-approve-test";
    c.send({ type: "chat", run_id: runId, content: "check refresh tokens" });
    const todos = await c.waitFor((f) => f.type === "todos");
    assert.equal(todos.todos.length, 3);
    assert.equal(todos.run_id, runId);
    const partial = await c.waitFor((f) => f.type === "message" && f.partial);
    // token stream: same id, growing snapshot
    const sameId = await c.waitFor((f) => f.type === "message" && f.id === partial.id && f.message.content.length > partial.message.content.length);
    assert.ok(sameId);
    await c.waitFor((f) => f.type === "skills" && f.skills.find((s) => s.name === "crypto-tools").status === "loaded");
    const start = await c.waitFor((f) => f.type === "task" && f.event === "start");
    assert.equal(start.task.agent, "general-purpose");
    assert.equal(start.task.description, "trace how JWT refresh tokens are validated");
    const inner = await c.waitFor((f) => f.type === "task" && f.event === "inner" && f.message.tool_calls?.[0]?.name === "read_file");
    assert.equal(inner.message.subagent_id, start.task.id);
    assert.ok(inner.inner_id);
    const end = await c.waitFor((f) => f.type === "task" && f.event === "end");
    assert.match(end.subtask.report, /off-by-one/);
    await c.waitFor((f) => f.type === "stats");
    const intr = await c.waitFor((f) => f.type === "interrupt");
    assert.equal(intr.tool, "edit_file");
    assert.equal(intr.args.new_string, "if (exp <= now) reject();");
    // nothing more streams while paused for approval
    const count = c.frames.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.frames.filter((f) => f.type === "message").length, c.frames.slice(0, count).filter((f) => f.type === "message").length);

    c.send({ type: "interrupt", run_id: runId, interrupt_id: intr.interrupt_id, decision: { action: "approve" } });
    const done = await c.waitFor((f) => f.type === "done" && f.run_id === runId, 30000);
    assert.equal(done.stats.tokens_in, 48213);
    assert.equal(done.stats.tokens_out, 9477);
    assert.ok(done.stats.ended_at > done.stats.started_at);
    assert.match(done.message.content, /```ts/);
    assert.ok(done.message.usage);
    const lastTodos = c.frames.filter((f) => f.type === "todos").at(-1);
    assert.ok(lastTodos.todos.every((t) => t.status === "completed"));

    // the edit really landed in the virtual FS
    c.send({ type: "file", path: "/workspace/src/token.ts" });
    const tok = await c.waitFor((f) => f.type === "file" && f.path === "/workspace/src/token.ts");
    assert.match(tok.result.content, /exp <= now/);

    // and the run shows up in history, sub-agent inner messages included
    const hist = await (await fetch(`${srv.url}/api/history`)).json();
    assert.equal(hist.runs[0].id, runId);
    const detail = await (await fetch(`${srv.url}/api/history/${runId}`)).json();
    assert.ok(detail.messages.some((m) => m.subagent_id === start.task.id));
    assert.ok(detail.messages.some((m) => m.role === "tool" && m.tool_call_id));
    c.close();
  });

  test("reject path acknowledges the note", async () => {
    const c = await connect(srv.port);
    const runId = "run-reject-test";
    c.send({ type: "chat", run_id: runId, content: "go" });
    const intr = await c.waitFor((f) => f.type === "interrupt" && f.run_id === runId, 30000);
    c.send({ type: "interrupt", run_id: runId, interrupt_id: intr.interrupt_id, decision: { action: "reject", note: "not today" } });
    const done = await c.waitFor((f) => f.type === "done" && f.run_id === runId);
    assert.match(done.message.content, /OK, leaving token.ts untouched/);
    assert.match(done.message.content, /not today/);
    c.close();
  });

  test("stop ends the run with done and no message; pause holds it", async () => {
    const c = await connect(srv.port);
    const runId = "run-stop-test";
    c.send({ type: "chat", run_id: runId, content: "go" });
    await c.waitFor((f) => f.type === "message" && f.run_id === runId);
    c.send({ type: "control", run_id: runId, cmd: "pause" });
    await c.waitFor((f) => f.type === "status" && f.status === "paused");
    await new Promise((r) => setTimeout(r, 150));
    const n = c.frames.filter((f) => f.type === "message").length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.frames.filter((f) => f.type === "message").length, n, "no messages while paused");
    c.send({ type: "control", run_id: runId, cmd: "stop" });
    const done = await c.waitFor((f) => f.type === "done" && f.run_id === runId);
    assert.equal(done.message, undefined);
    c.close();
  });

  test("history REST and seeded runs; media served", async () => {
    const hist = await (await fetch(`${srv.url}/api/history`)).json();
    const ids = hist.runs.map((r) => r.id);
    assert.ok(ids.includes("run-7f3a1c2e") && ids.includes("run-b81d44a0"));
    const d = await (await fetch(`${srv.url}/api/history/run-7f3a1c2e`)).json();
    assert.equal(d.stats.run_id, "run-7f3a1c2e");
    assert.ok(d.messages.length >= 4);
    for (const [file, type] of [["sample.mp4", "video/mp4"], ["sample.wav", "audio/wav"], ["report.pdf", "application/pdf"], ["logo.png", "image/png"]]) {
      const r = await fetch(`${srv.url}/media/${file}`);
      assert.equal(r.status, 200, file);
      assert.match(r.headers.get("content-type"), new RegExp(type.replace("/", "\\/")));
    }
    assert.equal((await fetch(`${srv.url}/media/../src/index.js`)).status, 404);
  });

  test("skill studio REST: proposals, approve, save, validation", async () => {
    const list = await (await fetch(`${srv.url}/api/skill-proposals`)).json();
    assert.equal(list.length, 1);
    const detail = await (await fetch(`${srv.url}/api/skill-proposals/${list[0].id}`)).json();
    assert.match(detail.diff, /\+## Revenue by month/);
    const ok = await fetch(`${srv.url}/api/skill-proposals/${list[0].id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal((await ok.json()).status, "approved");
    const bad = await fetch(`${srv.url}/api/skills/coding/new-thing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "SKILL.md": "no frontmatter" } }),
    });
    assert.equal(bad.status, 400);
    const good = await fetch(`${srv.url}/api/skills/coding/new-thing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "SKILL.md": "---\nname: new-thing\ndescription: A new skill. Use always.\n---\nbody\n" } }),
    });
    assert.equal((await good.json()).version, 1);
  });
});

describe("auth", () => {
  test("token is required when configured (ws closes 4401, REST 401)", async () => {
    const s = await startServer({ HQ_WEB_MODE: "mock", MOCK_TOKEN: "secret-token-1234567890" });
    try {
      const bad = await connect(s.port, "wrong");
      assert.equal((await bad.closed).code, 4401);
      const good = await connect(s.port, "secret-token-1234567890");
      await good.waitFor((f) => f.type === "hello");
      good.close();
      assert.equal((await fetch(`${s.url}/api/history`)).status, 401);
      assert.equal((await fetch(`${s.url}/api/history`, { headers: { authorization: "Bearer secret-token-1234567890" } })).status, 200);
      assert.equal((await fetch(`${s.url}/api/health`)).status, 200);
    } finally {
      s.stop();
    }
  });
});
