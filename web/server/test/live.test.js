// End-to-end: console server (live mode) -> real HQ (Aegra + agent + docker sandbox)
// with the scripted fake LLM (test/fake_llm.py). Skipped unless HQ_LIVE_URL is set:
//
//   HQ_LIVE_URL=http://127.0.0.1:58000 HQ_LIVE_TOKEN=... node --test test/live.test.js
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { connect, startServer } from "./helpers.js";

const URL_ = process.env.HQ_LIVE_URL;
const TOKEN = process.env.HQ_LIVE_TOKEN || "";
const skip = !URL_ && "set HQ_LIVE_URL (and HQ_LIVE_TOKEN) to run against a real HQ";
const WEB = "w".repeat(32);
// Set HQ_LIVE_NO_STREAM=1 when the agent under test runs with MODEL_STREAMING=false.
const STREAMING = process.env.HQ_LIVE_NO_STREAM !== "1";

let srv;
let dataDir;
before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hqweb-"));
  srv = await startServer({ HQ_WEB_MODE: "live", HQ_API_URL: URL_, HQ_API_TOKEN: TOKEN, WEB_TOKEN: WEB, WEB_DATA_DIR: dataDir });
});
after(() => {
  srv?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = (p, init = {}) =>
  fetch(srv.url + p, { ...init, headers: { authorization: `Bearer ${WEB}`, "content-type": "application/json", ...(init.headers || {}) } }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => null),
  }));

test("hello and snapshots come from HQ", { skip, timeout: 90000 }, async () => {
  const c = await connect(srv.port, WEB);
  const hello = await c.waitFor((f) => f.type === "hello");
  assert.equal(hello.mode, "live");
  assert.ok(hello.features.includes("approvals"));
  assert.equal(hello.model, "fake-glm");
  const skills = await c.waitFor((f) => f.type === "skills");
  assert.ok(skills.skills.some((s) => s.name === "test-first-change" && s.category === "coding"));
  const tools = await c.waitFor((f) => f.type === "tools", 60000);
  const edit = tools.tools.find((t) => t.name === "edit_file");
  assert.ok(edit && edit.approval, "edit_file needs approval (HQ_REQUIRE_APPROVAL)");
  await c.waitFor((f) => f.type === "memory");
  await c.waitFor((f) => f.type === "mcp");
  c.close();
});

test("full run: streaming, todos, sub-agent, approval, sandbox files, history", { skip, timeout: 240000 }, async () => {
  const c = await connect(srv.port, WEB);
  await c.waitFor((f) => f.type === "hello");
  const run_id = randomUUID();
  const project = `webtest-${run_id.slice(0, 6)}`;
  c.send({ type: "chat", run_id, content: "Build calc.py and get it reviewed", project });

  // token streaming of the first assistant message (not when the agent runs with MODEL_STREAMING=false)
  if (STREAMING) await c.waitFor((f) => f.type === "message" && f.run_id === run_id && f.partial && f.message.role === "assistant", 60000);
  else await c.waitFor((f) => f.type === "message" && f.run_id === run_id && f.message.role === "assistant", 60000);
  const todos = await c.waitFor((f) => f.type === "todos" && f.run_id === run_id, 60000);
  assert.equal(todos.todos.length, 3);

  // sub-agent: start, inner messages, end with a report
  const start = await c.waitFor((f) => f.type === "task" && f.event === "start", 90000);
  assert.equal(start.task.agent, "reviewer");
  const inner = await c.waitFor((f) => f.type === "task" && f.event === "inner" && !f.partial && f.message.role === "tool", 90000);
  assert.equal(inner.message.subagent_id, start.task.id);
  const end = await c.waitFor((f) => f.type === "task" && f.event === "end" && f.subtask.id === start.task.id, 90000);
  assert.equal(end.subtask.status, "done");
  assert.match(end.subtask.report, /blocker/);

  // approval for edit_file
  const intr = await c.waitFor((f) => f.type === "interrupt" && f.run_id === run_id, 90000);
  assert.equal(intr.tool, "edit_file");
  assert.equal(intr.args.new_string, "a + b");

  // a reconnecting client is caught up on the pending approval, and history knows it's running
  const c2 = await connect(srv.port, WEB);
  const again = await c2.waitFor((f) => f.type === "interrupt" && f.run_id === run_id, 30000);
  assert.equal(again.interrupt_id, intr.interrupt_id);
  c2.close();
  const mid = await api(`/api/history/${run_id}`);
  assert.equal(mid.body.running, true);
  assert.equal(mid.body.pending_interrupts.length, 1);

  c.send({ type: "interrupt", run_id, interrupt_id: intr.interrupt_id, decision: { action: "approve" } });
  const done = await c.waitFor((f) => f.type === "done" && f.run_id === run_id, 120000);
  // exact text: catches providers that corrupt streamed text (see fake_llm.py FAKE_STREAM_BUG)
  assert.ok(done.message.content.includes("`add` subtracted instead of adding. Fixed and verified:"), `final reply text: ${JSON.stringify(done.message.content)}`);
  assert.ok(done.stats.tokens_in > 0 && done.stats.tokens_out > 0);
  const verify = c.frames.find((f) => f.type === "message" && f.message.role === "tool" && /^5\s/.test(f.message.content));
  assert.ok(verify, "the verify step printed 5 after the approved edit");
  const skills = c.frames.filter((f) => f.type === "skills").at(-1);
  assert.equal(skills.skills.find((s) => s.name === "test-first-change").status, "loaded");

  // the edited file in the sandbox, through the file browser
  c.send({ type: "files", path: "/workspace/demo", project });
  const listing = await c.waitFor((f) => f.type === "fs" && f.path === "/workspace/demo", 30000);
  assert.ok(listing.entries.some((e) => e.name === "calc.py"));
  c.send({ type: "file", path: "/workspace/demo/calc.py", project });
  const file = await c.waitFor((f) => f.type === "file" && f.path === "/workspace/demo/calc.py", 30000);
  assert.match(file.result.content, /return a \+ b/);

  // history: listed, and the transcript replays sub-agent messages and tasks
  const list = await api("/api/history");
  assert.ok(list.body.runs.some((r) => r.id === run_id && r.title.startsWith("Build calc.py")));
  const detail = await api(`/api/history/${run_id}`);
  assert.equal(detail.body.running, undefined);
  assert.ok(detail.body.messages.some((m) => m.subagent_id === start.task.id));
  assert.equal(detail.body.tasks[0].status, "done");
  assert.equal(detail.body.project, project);

  // continuing the same chat runs on the same HQ thread
  const before = c.frames.length;
  c.send({ type: "chat", run_id, content: "thanks, anything else?", project });
  const done2 = await c.waitFor((f) => f.type === "done" && f.run_id === run_id && c.frames.indexOf(f) >= before, 60000);
  assert.equal(done2.message.content, "Done.");
  assert.ok(done2.stats.tokens_in > done.stats.tokens_in, "tokens keep adding up across turns");

  // clean up the sandbox and the chat
  await api(`/api/sandboxes/${project}/stop`, { method: "POST", body: "{}" });
  const del = await api(`/api/history/${run_id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  c.close();
});

test("reject: the agent is told and the file is left alone", { skip, timeout: 240000 }, async () => {
  const c = await connect(srv.port, WEB);
  await c.waitFor((f) => f.type === "hello");
  const run_id = randomUUID();
  const project = `webrej-${run_id.slice(0, 6)}`;
  c.send({ type: "chat", run_id, content: "Build calc.py", project });
  const intr = await c.waitFor((f) => f.type === "interrupt" && f.run_id === run_id, 180000);
  c.send({ type: "interrupt", run_id, interrupt_id: intr.interrupt_id, decision: { action: "reject", note: "not now" } });
  await c.waitFor((f) => f.type === "done" && f.run_id === run_id, 120000);
  const rejected = c.frames.find((f) => f.type === "message" && f.message.role === "tool" && /not now/.test(f.message.content));
  assert.ok(rejected, "the rejection note reached the agent as the tool result");
  c.send({ type: "file", path: "/workspace/demo/calc.py", project });
  const file = await c.waitFor((f) => f.type === "file", 30000);
  assert.match(file.result.content, /return a - b/);
  await api(`/api/sandboxes/${project}/stop`, { method: "POST", body: "{}" });
  await api(`/api/history/${run_id}`, { method: "DELETE" });
  c.close();
});

test("stop ends the run without a final message", { skip, timeout: 120000 }, async () => {
  const c = await connect(srv.port, WEB);
  await c.waitFor((f) => f.type === "hello");
  const run_id = randomUUID();
  const project = `webstop-${run_id.slice(0, 6)}`;
  c.send({ type: "chat", run_id, content: "Build calc.py", project });
  await c.waitFor((f) => f.type === "todos" && f.run_id === run_id, 60000);
  c.send({ type: "control", run_id, cmd: "stop" });
  const done = await c.waitFor((f) => f.type === "done" && f.run_id === run_id, 30000);
  assert.equal(done.message, undefined);
  // the chat can continue afterwards
  const busy = c.frames.find((f) => f.type === "error" && f.code === "busy");
  assert.equal(busy, undefined);
  await api(`/api/sandboxes/${project}/stop`, { method: "POST", body: "{}" });
  await api(`/api/history/${run_id}`, { method: "DELETE" });
  c.close();
});

test("skill toggle and MCP add/remove go through HQ", { skip, timeout: 120000 }, async () => {
  const c = await connect(srv.port, WEB);
  await c.waitFor((f) => f.type === "skills");
  c.send({ type: "skills-toggle", name: "test-first-change" });
  await c.waitFor((f) => f.type === "skills" && f.skills.find((s) => s.name === "test-first-change")?.enabled === false, 30000);
  c.send({ type: "skills-toggle", name: "test-first-change" });
  await c.waitFor((f) => f.type === "skills" && f.skills.find((s) => s.name === "test-first-change")?.enabled === true && c.frames.filter((x) => x.type === "skills").length > 2, 30000);

  c.send({ type: "mcp-add", id: "nowhere", name: "nowhere", transport: "http", url: "http://127.0.0.1:9/mcp" });
  const added = await c.waitFor((f) => f.type === "mcp" && f.servers.some((s) => s.id === "nowhere" && s.status !== "connecting"), 60000);
  assert.equal(added.servers.find((s) => s.id === "nowhere").status, "error");
  c.send({ type: "mcp-remove", id: "nowhere" });
  await c.waitFor((f) => f.type === "mcp" && !f.servers.some((s) => s.id === "nowhere"), 30000);
  c.close();
});

test("pause and resume continue from the checkpoint", { skip, timeout: 240000 }, async () => {
  const c = await connect(srv.port, WEB);
  await c.waitFor((f) => f.type === "hello");
  const run_id = randomUUID();
  const project = `webpause-${run_id.slice(0, 6)}`;
  c.send({ type: "chat", run_id, content: "Build calc.py", project });
  await c.waitFor((f) => f.type === "todos" && f.run_id === run_id, 60000);
  c.send({ type: "control", run_id, cmd: "pause" });
  await c.waitFor((f) => f.type === "status" && f.run_id === run_id && f.status === "paused", 10000);
  c.send({ type: "control", run_id, cmd: "resume" });
  await c.waitFor((f) => f.type === "status" && f.run_id === run_id && f.status === "running" && c.frames.some((p) => p.type === "status" && p.status === "paused"), 10000);
  const intr = await c.waitFor((f) => f.type === "interrupt" && f.run_id === run_id, 180000);
  assert.equal(intr.tool, "edit_file");
  const errors = c.frames.filter((f) => f.type === "error" && f.run_id === run_id);
  assert.deepEqual(errors, []);
  c.send({ type: "control", run_id, cmd: "stop" });
  await c.waitFor((f) => f.type === "done" && f.run_id === run_id, 30000);
  await api(`/api/sandboxes/${project}/stop`, { method: "POST", body: "{}" });
  await api(`/api/history/${run_id}`, { method: "DELETE" });
  c.close();
});

test("a console restart mid-run picks the run back up, approval included", { skip, timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hqweb-restart-"));
  const env = { HQ_WEB_MODE: "live", HQ_API_URL: URL_, HQ_API_TOKEN: TOKEN, WEB_TOKEN: WEB, WEB_DATA_DIR: dir };
  let one = await startServer(env);
  const c = await connect(one.port, WEB);
  await c.waitFor((f) => f.type === "hello");
  const run_id = randomUUID();
  const project = `webrst-${run_id.slice(0, 6)}`;
  c.send({ type: "chat", run_id, content: "Build calc.py", project });
  await c.waitFor((f) => f.type === "todos" && f.run_id === run_id, 60000);
  one.stop(); // the console goes away while HQ keeps working
  c.close();

  const two = await startServer(env);
  try {
    const c2 = await connect(two.port, WEB);
    const intr = await c2.waitFor((f) => f.type === "interrupt" && f.run_id === run_id, 180000);
    assert.equal(intr.tool, "edit_file");
    c2.send({ type: "interrupt", run_id, interrupt_id: intr.interrupt_id, decision: { action: "approve" } });
    const done = await c2.waitFor((f) => f.type === "done" && f.run_id === run_id, 120000);
    assert.match(done.message.content, /Fixed and verified/);
    const detail = await fetch(`${two.url}/api/history/${run_id}`, { headers: { authorization: `Bearer ${WEB}` } }).then((r) => r.json());
    assert.ok(detail.messages.some((m) => m.role === "user" && m.content === "Build calc.py"));
    await fetch(`${two.url}/api/sandboxes/${project}/stop`, { method: "POST", headers: { authorization: `Bearer ${WEB}`, "content-type": "application/json" }, body: "{}" });
    await fetch(`${two.url}/api/history/${run_id}`, { method: "DELETE", headers: { authorization: `Bearer ${WEB}` } });
    c2.close();
  } finally {
    two.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HQ's reopen-interrupt safety net", { skip, timeout: 30000 }, async () => {
  const { HqClient } = await import("../src/live/hq.js");
  const hq = new HqClient({ apiUrl: URL_, apiToken: TOKEN });
  const tid = randomUUID();
  await hq.json("/threads", { body: { thread_id: tid } });
  const out = await hq.json(`/ops/threads/${tid}/reopen-interrupt`, { body: {} });
  assert.equal(out.status, "interrupted");
  assert.equal((await hq.json(`/threads/${tid}`)).status, "interrupted");
  await assert.rejects(hq.json(`/ops/threads/${randomUUID()}/reopen-interrupt`, { body: {} }), (/** @type {any} */ e) => e.status === 404);
  await hq.json(`/threads/${tid}`, { method: "DELETE" });
});

test("an approval raised inside a sub-agent", { skip, timeout: 240000 }, async () => {
  const c = await connect(srv.port, WEB);
  await c.waitFor((f) => f.type === "hello");
  const run_id = randomUUID();
  const project = `websub-${run_id.slice(0, 6)}`;
  c.send({ type: "chat", run_id, content: "Have the coder fix calc.py [scenario:coder-approval]", project });
  const start = await c.waitFor((f) => f.type === "task" && f.event === "start" && f.run_id === run_id, 90000);
  assert.equal(start.task.agent, "coder");
  const intr = await c.waitFor((f) => f.type === "interrupt" && f.run_id === run_id, 120000);
  assert.equal(intr.tool, "edit_file");
  c.send({ type: "interrupt", run_id, interrupt_id: intr.interrupt_id, decision: { action: "approve" } });
  const end = await c.waitFor((f) => f.type === "task" && f.event === "end" && f.subtask.id === start.task.id, 120000);
  assert.equal(end.subtask.status, "done");
  assert.match(end.subtask.report, /Fixed/);
  const done = await c.waitFor((f) => f.type === "done" && f.run_id === run_id, 120000);
  assert.match(done.message.content, /coder fixed/);
  const edited = c.frames.find((f) => f.type === "task" && f.event === "inner" && f.message?.role === "tool" && f.message.name === "edit_file");
  assert.ok(edited && edited.message.status === "ok", "the coder's edit ran after approval");
  c.send({ type: "file", path: "/workspace/demo/calc.py", project });
  const file = await c.waitFor((f) => f.type === "file", 30000);
  assert.match(file.result.content, /return a \+ b/);
  await api(`/api/sandboxes/${project}/stop`, { method: "POST", body: "{}" });
  await api(`/api/history/${run_id}`, { method: "DELETE" });
  c.close();
});
