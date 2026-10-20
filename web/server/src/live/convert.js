// LangChain message dicts (as Aegra serializes them) -> the console's Message shape.

/** Text and reasoning out of a string or a list of content blocks. */
export function splitContent(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  const text = [];
  const thinking = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (typeof b === "string") text.push(b);
    else if (b && b.type === "text" && typeof b.text === "string") text.push(b.text);
    else if (b && (b.type === "thinking" || b.type === "reasoning") && typeof (b.thinking ?? b.reasoning) === "string") thinking.push(b.thinking ?? b.reasoning);
  }
  return { text: text.join(""), thinking: thinking.join("\n") };
}

const ROLE = { human: "user", ai: "assistant", tool: "tool", system: "system", AIMessageChunk: "assistant" };

/**
 * @param {any} m LangChain message dict
 * @param {number} ts first time we saw it
 * @param {string} [subagent]
 */
export function toMessage(m, ts, subagent) {
  const role = ROLE[m.type] || "assistant";
  const { text, thinking } = splitContent(m.content);
  /** @type {any} */
  const out = { id: m.id || `${role}-${ts}`, role, content: text, ts };
  if (thinking) out.thinking = thinking;
  if (m.name && role !== "user") out.name = m.name;
  if (role === "assistant") {
    const calls = (m.tool_calls || []).filter((c) => c && c.name);
    if (calls.length) out.tool_calls = calls.map((c) => ({ id: c.id, name: c.name, args: c.args || {} }));
    const u = m.usage_metadata;
    if (u && (u.input_tokens || u.output_tokens)) out.usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 };
  }
  if (role === "tool") {
    out.tool_call_id = m.tool_call_id;
    out.status = m.status === "error" ? "error" : "ok";
  }
  if (role === "user" && m.additional_kwargs?.hq_push_reminder) {
    out.role = "system";
    out.content = "Push check: reminded the agent to push its commits before finishing.";
  }
  if (subagent) out.subagent_id = subagent;
  return out;
}

/** Accumulates streamed AIMessageChunks (messages-tuple mode) into a growing snapshot. */
export class ChunkBuffer {
  constructor() {
    /** @type {Map<string, {text: string, thinking: string, tools: Map<number, {name: string, args: string}>, ts: number}>} */
    this.byId = new Map();
  }

  /** @returns {{id: string, text: string, thinking: string, toolNames: string[], ts: number} | null} */
  add(chunk) {
    const id = chunk?.id;
    if (!id) return null;
    let s = this.byId.get(id);
    if (!s) {
      s = { text: "", thinking: "", tools: new Map(), ts: Date.now() };
      this.byId.set(id, s);
    }
    const { text, thinking } = splitContent(chunk.content);
    s.text += text;
    s.thinking += thinking;
    for (const tc of chunk.tool_call_chunks || []) {
      const key = tc.index ?? 0;
      const cur = s.tools.get(key) || { name: "", args: "" };
      if (tc.name) cur.name = tc.name;
      if (tc.args) cur.args += tc.args;
      s.tools.set(key, cur);
    }
    return { id, text: s.text, thinking: s.thinking, toolNames: [...s.tools.values()].map((t) => t.name).filter(Boolean), ts: s.ts };
  }

  firstSeen(id) {
    return this.byId.get(id)?.ts;
  }

  drop(id) {
    this.byId.delete(id);
  }
}

/** Seconds -> milliseconds for timestamps coming from Python (time.time()). */
export function msTimes(value) {
  if (Array.isArray(value)) return value.map(msTimes);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = ["ts", "created_at", "decided_at", "updated_at", "loaded_at", "pinned_until", "started_at"].includes(k) && typeof v === "number" && v > 0 && v < 1e12 ? Math.round(v * 1000) : msTimes(v);
    }
    return out;
  }
  return value;
}

/** Map an /ops skill to the console's Skill shape. */
export function toSkill(s, loaded) {
  const key = `${s.category}/${s.name}`;
  return {
    name: s.name,
    description: s.description || "",
    file: s.path || `/skills/${key}/SKILL.md`,
    source: s.builtin ? "built-in" : s.version ? "approved" : "local",
    status: loaded.has(key) ? "loaded" : "idle",
    category: s.category,
    enabled: s.enabled !== false,
    version: s.version ?? null,
    builtin_update: Boolean(s.builtin_update_available),
  };
}

/** /skills/<category>/<name>/... path -> "category/name", if it is one. */
export function skillKeyFromPath(p) {
  const m = /^\/skills\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\//.exec(String(p || ""));
  return m ? `${m[1]}/${m[2]}` : null;
}
