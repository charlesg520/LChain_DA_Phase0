// The wire contract between the UI and the server (mock or live bridge).
// Fields marked "HQ extension" are additive and optional: a server that only
// implements the base contract still works with this UI.

export type Role = "user" | "assistant" | "tool" | "system";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

export type Subtask = {
  id: string;
  description: string;
  agent: string;
  status: "running" | "done" | "error";
  started_at: number;
  ended_at?: number;
  report?: string;
  error?: string;
};

export type RunStats = { run_id: string; started_at: number; ended_at?: number; tokens_in: number; tokens_out: number };

export type FsEntry = { name: string; path: string; type: "dir" | "file"; size: number; mime: string; modified_at: number };

export type Skill = {
  name: string;
  description: string;
  file: string;
  source: string;
  status: "idle" | "loaded" | "error";
  // HQ extension
  category?: string;
  enabled?: boolean;
  version?: number | null;
  builtin_update?: boolean;
  error?: string;
};

export type Tool = {
  name: string;
  description: string;
  schema: string; // JSON-schema-like object, pretty-printed
  // HQ extension: which agents get this tool, and whether it pauses for approval
  agents?: string[];
  source?: string;
  approval?: boolean;
};

export type McpTransport = "stdio" | "sse" | "http"; // "http" = streamable HTTP (HQ extension)

export type McpServer = {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  status: "disconnected" | "connecting" | "connected" | "error";
  tools: string[];
  error?: string;
  started_at?: number;
  // HQ extension: per-agent tool allowlist (glob patterns)
  agents?: Record<string, string[]>;
};

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Message = {
  id: string;
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  subagent_id?: string;
  ts: number;
  usage?: { input_tokens: number; output_tokens: number };
  // HQ extension: tool result status, and model reasoning when the model exposes it
  status?: "ok" | "error";
  thinking?: string;
};

export type FsResult = { path: string; content: string; encoding: "utf8" | "base64"; mime: string; size: number };

export type Settings = { host: string; ws_path: string; token: string; accent: string };

export type Accent = "cyan" | "violet" | "green" | "amber";

export type HistoryRun = { id: string; title: string; updated_at: number; project?: string; status?: "running" | "approval" }; // status: HQ extension

export type HistoryDetail = {
  id: string;
  title: string;
  updated_at: number;
  stats: RunStats;
  messages: Message[];
  todos?: Todo[]; // HQ extension
  tasks?: Subtask[]; // HQ extension
  project?: string;
  // HQ extension: the chat is still being worked on (opened mid-run)
  running?: boolean;
  pending_interrupts?: InterruptFrame[];
};

export type InterruptDecision = { action: "approve" | "reject"; edited_args?: Record<string, unknown>; note?: string };

// ---------------------------------------------------------------- downlink
export type HelloFrame = {
  type: "hello";
  version: string;
  model: string;
  // HQ extension
  mode?: "mock" | "live";
  features?: string[];
  projects?: string[];
};
export type MessageFrame = { type: "message"; run_id: string; id: string; partial: boolean; message: Message };
export type TodosFrame = { type: "todos"; run_id: string; todos: Todo[] };
export type TaskFrame = {
  type: "task";
  run_id: string;
  event: "start" | "inner" | "end";
  task?: Subtask;
  inner_id?: string;
  message?: Message;
  subtask?: { id: string; status: "done" | "error"; report?: string; error?: string };
  partial?: boolean; // HQ extension: inner token stream
};
export type InterruptFrame = {
  type: "interrupt";
  run_id: string;
  interrupt_id: string;
  tool: string;
  args: Record<string, unknown>;
  message?: string;
};
export type StatsFrame = { type: "stats"; run_id: string; stats: RunStats };
export type FsFrame = { type: "fs"; path: string; entries: FsEntry[] };
export type FileFrame = { type: "file"; path: string; result: FsResult };
export type MemoryFrame = { type: "memory"; files: { path: string; content: string }[] };
export type SkillsFrame = { type: "skills"; skills: Skill[] };
export type ToolsFrame = { type: "tools"; tools: Tool[] };
export type McpFrame = { type: "mcp"; servers: McpServer[] };
export type DoneFrame = { type: "done"; run_id: string; message?: Message; stats: RunStats };
export type ErrorFrame = { type: "error"; run_id?: string; message: string; code?: string };
export type PongFrame = { type: "pong"; ts: number };
// HQ extension: run lifecycle acknowledgements (paused/resumed) and toasts from the server
// HQ extension: `detail` says what the run is waiting on (e.g. the model provider timing out); null clears it.
export type StatusFrame = { type: "status"; run_id: string; status: "running" | "paused" | "idle"; detail?: string | null };
export type NoticeFrame = { type: "notice"; level: "info" | "ok" | "warn" | "error"; message: string };

export type Downlink =
  | HelloFrame
  | MessageFrame
  | TodosFrame
  | TaskFrame
  | InterruptFrame
  | StatsFrame
  | FsFrame
  | FileFrame
  | MemoryFrame
  | SkillsFrame
  | ToolsFrame
  | McpFrame
  | DoneFrame
  | ErrorFrame
  | PongFrame
  | StatusFrame
  | NoticeFrame;

export type DownlinkType = Downlink["type"];

// ------------------------------------------------------------------ uplink
export type Uplink =
  | { type: "chat"; run_id: string; content: string; project?: string }
  | { type: "interrupt"; run_id: string; interrupt_id: string; decision: InterruptDecision }
  | { type: "control"; run_id: string; cmd: "pause" | "resume" | "stop" }
  | { type: "files"; path?: string; project?: string }
  | { type: "file"; path: string; project?: string }
  | { type: "memory" }
  | { type: "memory-save"; path: string; content: string }
  | { type: "skills" }
  | { type: "skills-toggle"; name: string }
  | { type: "tools" }
  | { type: "mcp" }
  | {
      type: "mcp-add";
      id: string;
      name: string;
      transport: McpTransport;
      command?: string;
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
      agents?: Record<string, string[]>;
    }
  | { type: "mcp-remove"; id: string }
  | { type: "mcp-toggle"; id: string; enabled: boolean }
  | { type: "ping"; ts: number };

// ---------------------------------------------------- HQ extension: skill studio (REST)
export type SkillDetail = {
  category: string;
  name: string;
  files: Record<string, string>;
  hash: string;
  history: { version: number | null; ts: number; source: string; note: string; hash: string | null }[];
};

export type SkillProposal = {
  id: string;
  category: string;
  name: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  created_at: number;
  proposed_by: string;
  decided_at?: number | null;
  decision_note?: string | null;
  version?: number | null;
  files?: Record<string, string>;
  diff?: string;
  live_changed_since_proposed?: boolean;
};

export type SandboxInfo = {
  hosts: Record<
    string,
    {
      reachable: boolean;
      error?: string;
      stop_after_s?: number;
      sandboxes?: { name: string; project: string; status: string; idle_s: number | null; busy: boolean; pinned_until: number | null }[];
    }
  >;
  reaper?: { enabled: boolean; running: boolean; idle_stop_minutes: number; idle_remove_hours: number };
};
