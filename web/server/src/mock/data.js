// Fixtures for the standalone mock: a small virtual filesystem, memory,
// skills, tools, MCP servers and two past runs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
export const asset = (name) => fs.readFileSync(path.join(ASSETS, name));
export const ASSET_DIR = ASSETS;

export const MEMORY_AGENTS =
  "# House rules\n- Always verify edits with grep before declaring success\n- Prefer edit_file over write_file\n";

export const README = `# demo-app

A tiny service with JWT auth, used by the HQ console mock.

- \`src/auth.ts\`: login + middleware
- \`src/token.ts\`: token issue/verify, refresh rotation
- \`docs/notes.md\`: design notes
`;

export const AUTH_TS = `import { verifyAccess, rotateRefresh } from "./token";

export interface Session {
  userId: string;
  roles: string[];
}

// Express-style middleware: reads the bearer token and attaches the session.
export function requireAuth(req: any, res: any, next: () => void) {
  const header: string = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  const session = verifyAccess(token);
  if (!session) return res.status(401).json({ error: "invalid token" });
  req.session = session as Session;
  next();
}

export async function refresh(req: any, res: any) {
  const pair = await rotateRefresh(req.body.refresh_token);
  if (!pair) return res.status(401).json({ error: "refresh rejected" });
  res.json(pair); // { access, refresh }
}
`;

export const TOKEN_TS = `const ACCESS_TTL = 15 * 60; // seconds
const REFRESH_TTL = 30 * 24 * 3600;

type Claims = { sub: string; exp: number; kind: "access" | "refresh" };

function decode(token: string): Claims | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function verifyAccess(token: string) {
  const claims = decode(token);
  if (!claims || claims.kind !== "access") return null;
  return { userId: claims.sub, roles: ["user"] };
}

export async function rotateRefresh(token: string) {
  const claims = decode(token);
  const now = Math.floor(Date.now() / 1000);
  const reject = () => { throw new Error("refresh rejected"); };
  if (!claims || claims.kind !== "refresh") return null;
  if (exp < now) reject();
  return { access: sign(claims.sub, "access", ACCESS_TTL), refresh: sign(claims.sub, "refresh", REFRESH_TTL) };
}

declare function sign(sub: string, kind: string, ttl: number): string;
declare const exp: number;
`;

export const NOTES_MD = `# Design notes

## Tokens
- Access tokens live 15 minutes, refresh tokens 30 days.
- Refresh tokens rotate on every use.

| Token   | TTL      | Rotates |
|---------|----------|---------|
| access  | 15 min   | no      |
| refresh | 30 days  | yes     |

> Open question: should \`exp == now\` count as expired? (yes, per RFC 7519)
`;

export function buildFs() {
  const t = Date.now();
  /** @type {Map<string, {type:"dir"|"file", content?:Buffer, mime?:string, modified_at:number}>} */
  const tree = new Map();
  const dir = (p) => tree.set(p, { type: "dir", modified_at: t - 3600_000 });
  const file = (p, content, mime) =>
    tree.set(p, { type: "file", content: Buffer.isBuffer(content) ? content : Buffer.from(content), mime, modified_at: t - 600_000 });
  dir("/");
  dir("/workspace");
  dir("/workspace/src");
  dir("/workspace/docs");
  dir("/workspace/media");
  file("/README.md", README, "text/markdown");
  file("/AGENTS.md", MEMORY_AGENTS, "text/markdown");
  file("/workspace/src/auth.ts", AUTH_TS, "text/typescript");
  file("/workspace/src/token.ts", TOKEN_TS, "text/typescript");
  file("/workspace/docs/notes.md", NOTES_MD, "text/markdown");
  file("/workspace/media/logo.png", asset("logo.png"), "image/png");
  file("/workspace/media/sample.mp4", asset("sample.mp4"), "video/mp4");
  file("/workspace/media/sample.wav", asset("sample.wav"), "audio/wav");
  file("/workspace/media/report.pdf", asset("report.pdf"), "application/pdf");
  return tree;
}

export function initialSkills() {
  return [
    { name: "crypto-tools", description: "Helpers for hashing and signing", file: "/skills/crypto-tools", source: "built-in", status: "idle", category: "security", enabled: true, version: 1 },
    { name: "web-scraper", description: "Fetch and extract page HTML", file: "/skills/web-scraper", source: "built-in", status: "idle", category: "web", enabled: true, version: 1 },
    { name: "db-query", description: "SQL templates for the orders DB", file: "/skills/db-query", source: "path:/workspace/.skills", status: "idle", category: "data", enabled: true, version: 2 },
  ];
}

export const SKILL_BODIES = {
  "crypto-tools":
    "---\nname: crypto-tools\ndescription: Helpers for hashing and signing\n---\n\n# Crypto tools\n\n- Hash with SHA-256 via `node:crypto`; never MD5 for security.\n- Compare secrets with `timingSafeEqual`.\n- JWT `exp` is seconds since epoch; a token with `exp <= now` is expired.\n",
  "web-scraper":
    "---\nname: web-scraper\ndescription: Fetch and extract page HTML\n---\n\n# Web scraper\n\n1. `fetch_url` the page.\n2. Extract with CSS selectors; prefer JSON-LD when present.\n3. Respect robots.txt and rate limits.\n",
  "db-query":
    "---\nname: db-query\ndescription: SQL templates for the orders DB\n---\n\n# Orders DB\n\n```sql\nSELECT id, total_cents, status FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50;\n```\n",
};

const schema = (props, required) =>
  JSON.stringify({ type: "object", properties: props, required: required ?? Object.keys(props) }, null, 2);

export const TOOLS = [
  { name: "ls", description: "List directory contents", schema: schema({ path: { type: "string", description: "Absolute directory path" } }) },
  { name: "read_file", description: "Read a file from the virtual FS", schema: schema({ file_path: { type: "string", description: "Absolute file path" }, offset: { type: "integer", description: "First line (0-based)" }, limit: { type: "integer", description: "Max lines" } }, ["file_path"]) },
  { name: "write_file", description: "Write a file", schema: schema({ file_path: { type: "string", description: "Absolute file path" }, content: { type: "string", description: "Full file content" } }) },
  { name: "edit_file", description: "Apply an old_string/new_string patch", schema: schema({ file_path: { type: "string", description: "File to edit" }, old_string: { type: "string", description: "Exact text to replace" }, new_string: { type: "string", description: "Replacement" }, replace_all: { type: "boolean", description: "Replace every occurrence" } }, ["file_path", "old_string", "new_string"]) },
  { name: "grep", description: "Regex search across the virtual FS", schema: schema({ pattern: { type: "string", description: "Regular expression" }, path: { type: "string", description: "Directory to search" } }, ["pattern"]) },
  { name: "task", description: "Spawn a focused sub-agent", schema: schema({ description: { type: "string", description: "Self-contained task" }, subagent_type: { type: "string", description: "Which sub-agent" } }) },
  { name: "memory", description: "Read/write persistent memory files", schema: schema({ action: { type: "string", description: "read | write" }, path: { type: "string", description: "Memory file" }, content: { type: "string", description: "New content (write)" } }, ["action", "path"]) },
].map((t) => ({ ...t, agents: ["orchestrator", "general-purpose"], source: "harness" }));

export function initialMcp(t = Date.now()) {
  return [
    { id: "fs-ops", name: "filesystem-ops", transport: "stdio", command: "node mcp-fs.js", status: "connecting", tools: [], started_at: t },
    { id: "web-search", name: "search-web", transport: "sse", url: "http://localhost:9099/sse", status: "error", tools: [], error: "connect ECONNREFUSED localhost:9099" },
  ];
}

export function seededHistory() {
  const day = 24 * 3600_000;
  const t1 = Date.now() - 2 * day;
  const t2 = Date.now() - 5 * 3600_000;
  const m = (id, role, content, ts, extra = {}) => ({ id, role, content, ts, ...extra });
  return [
    {
      id: "run-7f3a1c2e",
      title: "Audit auth middleware for missing checks",
      updated_at: t1,
      stats: { run_id: "run-7f3a1c2e", started_at: t1 - 95_000, ended_at: t1, tokens_in: 21877, tokens_out: 3120 },
      todos: [
        { content: "Read auth middleware", status: "completed" },
        { content: "List unchecked routes", status: "completed" },
      ],
      messages: [
        m("h1-u", "user", "Audit src/auth.ts for routes that skip requireAuth.", t1 - 95_000),
        m("h1-a1", "assistant", "Reading the middleware first.", t1 - 93_000, {
          tool_calls: [{ id: "h1-c1", name: "read_file", args: { file_path: "/workspace/src/auth.ts" } }],
          usage: { input_tokens: 4100, output_tokens: 180 },
        }),
        m("h1-t1", "tool", AUTH_TS, t1 - 92_000, { name: "read_file", tool_call_id: "h1-c1" }),
        m("h1-a2", "assistant", "**Result:** `requireAuth` is applied correctly. `refresh` is intentionally public, since it authenticates with the refresh token itself.\n\nNo missing checks found.", t1 - 2_000, { usage: { input_tokens: 17777, output_tokens: 2940 } }),
      ],
    },
    {
      id: "run-b81d44a0",
      title: "Summarize design notes",
      updated_at: t2,
      stats: { run_id: "run-b81d44a0", started_at: t2 - 31_000, ended_at: t2, tokens_in: 6040, tokens_out: 812 },
      todos: [],
      messages: [
        m("h2-u", "user", "Summarize docs/notes.md in three bullets.", t2 - 31_000),
        m("h2-a1", "assistant", "", t2 - 30_000, { tool_calls: [{ id: "h2-c1", name: "read_file", args: { file_path: "/workspace/docs/notes.md" } }] }),
        m("h2-t1", "tool", NOTES_MD, t2 - 29_500, { name: "read_file", tool_call_id: "h2-c1" }),
        m("h2-a2", "assistant", "- Access tokens: 15 min; refresh tokens: 30 days.\n- Refresh tokens rotate on every use.\n- Open question: `exp == now` should count as expired (RFC 7519).", t2, { usage: { input_tokens: 6040, output_tokens: 812 } }),
      ],
    },
  ];
}
