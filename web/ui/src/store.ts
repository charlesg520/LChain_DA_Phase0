import { create } from "zustand";
import type {
  Accent,
  Downlink,
  DownlinkType,
  FsEntry,
  FsResult,
  HelloFrame,
  HistoryDetail,
  HistoryRun,
  InterruptDecision,
  InterruptFrame,
  McpServer,
  Message,
  RunStats,
  Settings,
  Skill,
  Subtask,
  Todo,
  Tool,
  Uplink,
} from "./types";
import { newId } from "./lib/format";

// ------------------------------------------------------------------ types
export type View = "chat" | "history" | "tasks" | "agents" | "files" | "memory" | "toolkit" | "console" | "settings";
export type DockTab = "tasks" | "agents" | "console";
export type ToolkitTab = "skills" | "tools" | "servers";
export type ConnStatus = "connecting" | "open" | "closed" | "unauthorized";
export type RunStatus = "idle" | "running" | "paused";

export type ConsoleEntry = { n: number; ts: number; type: string; raw: string };
export type Toast = { id: number; level: "info" | "ok" | "warn" | "error"; text: string };
export type InterruptOutcome = { interrupt_id: string; tool: string; action: "approve" | "reject"; edited: boolean; note?: string };

export const SETTINGS_KEY = "deepagent.settings";
export const UI_KEY = "deepagent.ui";
const CONSOLE_MAX = 1000;

export const DEFAULT_SETTINGS: Settings & { hitl_note: boolean } = {
  host: "",
  ws_path: "/ws",
  token: "",
  accent: "cyan",
  hitl_note: true,
};

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or storage blocked: settings just won't persist */
  }
}

type RunState = {
  id: string | null;
  title: string;
  project: string;
  status: RunStatus;
  order: string[];
  byId: Record<string, Message>;
  messages: Message[];
  streaming: string | null; // id of the message currently streaming (partial)
  todos: Todo[];
  tasks: Subtask[];
  stats: RunStats | null;
  current_interrupt: InterruptFrame | null;
  queued_interrupts: InterruptFrame[];
  interrupt_outcome: InterruptOutcome | null;
  decisions: (InterruptOutcome & { args: Record<string, unknown> })[];
  tool_times: Record<string, { start: number; end?: number }>;
  last_tool_duration: number | null;
  last_run_ms: number | null;
  now: number;
  from_history: boolean;
};

const emptyRun = (project: string): RunState => ({
  id: null,
  title: "",
  project,
  status: "idle",
  order: [],
  byId: {},
  messages: [],
  streaming: null,
  todos: [],
  tasks: [],
  stats: null,
  current_interrupt: null,
  queued_interrupts: [],
  interrupt_outcome: null,
  decisions: [],
  tool_times: {},
  last_tool_duration: null,
  last_run_ms: null,
  now: Date.now(),
  from_history: false,
});

type UiPersist = { sidebar_collapsed: boolean; dock: boolean; dock_tab: DockTab; toolkit_tab: ToolkitTab; project: string };
const uiPersist = loadJson<UiPersist>(UI_KEY, { sidebar_collapsed: false, dock: true, dock_tab: "tasks", toolkit_tab: "skills", project: "default" });

export type State = {
  connection: { status: ConnStatus; attempts: number; error?: string; hello?: HelloFrame; connected_once: boolean };
  run: RunState;
  fs: { path: string; entries: FsEntry[]; loading: boolean; open: string | null; files: Record<string, FsResult>; error?: string };
  mem: { files: { path: string; content: string }[]; drafts: Record<string, string>; active: string | null; saving: string | null };
  skills: Skill[];
  skill_pending: Record<string, Skill["status"]>; // optimistic toggles awaiting the server snapshot
  tools: Tool[];
  mcp: McpServer[];
  ui: {
    view: View;
    dock: boolean;
    sidebar_collapsed: boolean;
    accent: Accent;
    follow: boolean;
    dock_tab: DockTab;
    toolkit_tab: ToolkitTab;
    console_filter: Partial<Record<DownlinkType, boolean>>;
    console_follow: boolean;
    composer_focus: number; // bump to focus the composer
    draft: string; // composer text (shared with the header RUN button)
    expanded_agent: string | null;
  };
  console: ConsoleEntry[];
  console_n: number;
  history: { runs: HistoryRun[]; loading: boolean; error?: string; loaded: boolean };
  // Another chat that HQ is working in (or waiting on an approval in) while you look at this one.
  elsewhere: { run_id: string; status: "running" | "paused" | "approval" } | null;
  settings: Settings & { hitl_note: boolean };
  toasts: Toast[];

  // actions
  send: (f: Uplink) => void;
  setSender: (fn: (f: Uplink) => void) => void;
  applyFrame: (f: Downlink, replay?: boolean) => void;
  setConn: (patch: Partial<State["connection"]>) => void;
  chat: (content: string) => void;
  control: (cmd: "pause" | "resume" | "stop") => void;
  decide: (decision: InterruptDecision) => void;
  newChat: () => void;
  loadHistoryDetail: (d: HistoryDetail) => void;
  setHistory: (patch: Partial<State["history"]>) => void;
  setView: (v: View) => void;
  setUi: (patch: Partial<State["ui"]>) => void;
  setProject: (p: string) => void;
  saveSettings: (s: Partial<State["settings"]>) => void;
  resetSettings: () => void;
  toast: (level: Toast["level"], text: string) => void;
  dismissToast: (id: number) => void;
  openDir: (path: string) => void;
  openFile: (path: string | null) => void;
  setDraft: (path: string, content: string) => void;
  setMemActive: (path: string) => void;
  saveMemory: (path: string) => void;
  toggleSkill: (name: string) => void;
  addMcp: (s: Omit<McpServer, "status" | "tools">) => void;
  clearConsole: () => void;
  tickNow: () => void;
};

let sender: (f: Uplink) => void = () => {};

// While a chat is being fetched from history, its live frames are held so nothing
// that happens between the fetch and the load is lost.
let opening: { id: string; frames: Downlink[] } | null = null;
export function holdFrames(id: string) {
  opening = { id, frames: [] };
}
export function releaseFrames(apply: boolean) {
  const held = opening;
  opening = null;
  if (apply && held) for (const f of held.frames) useStore.getState().applyFrame(f, true);
}
let toastSeq = 1;

/** What to remember about the chat being navigated away from, if HQ is still busy in it. */
function leaving(x: State): State["elsewhere"] {
  const r = x.run;
  if (r.id && r.status !== "idle") return { run_id: r.id, status: r.current_interrupt && !r.interrupt_outcome ? "approval" : r.status === "paused" ? "paused" : "running" };
  return x.elsewhere;
}

function materialize(run: RunState): Message[] {
  return run.order.map((id) => run.byId[id]).filter(Boolean);
}

/** Upsert a message by id (first appearance fixes its position). */
function upsert(run: RunState, msg: Message, partial: boolean): RunState {
  const exists = msg.id in run.byId;
  const prev = run.byId[msg.id];
  const merged: Message = prev ? { ...prev, ...msg } : msg;
  const byId = { ...run.byId, [msg.id]: merged };
  const order = exists ? run.order : [...run.order, msg.id];
  let tool_times = run.tool_times;
  let last_tool_duration = run.last_tool_duration;
  const t = Date.now();
  if (!partial && merged.tool_calls?.length) {
    tool_times = { ...tool_times };
    for (const c of merged.tool_calls) if (!tool_times[c.id]) tool_times[c.id] = { start: merged.ts || t };
  }
  if (merged.role === "tool" && merged.tool_call_id) {
    const tt = tool_times[merged.tool_call_id];
    if (tt && !tt.end) {
      tool_times = { ...tool_times, [merged.tool_call_id]: { ...tt, end: t } };
      last_tool_duration = t - tt.start;
    }
  }
  const next: RunState = {
    ...run,
    byId,
    order,
    tool_times,
    last_tool_duration,
    streaming: partial ? msg.id : run.streaming === msg.id ? null : run.streaming,
  };
  next.messages = materialize(next);
  return next;
}

/** Once the run moves on after a decision, the pinned approval card goes away (the tool card keeps the badge). */
function clearOutcome(run: RunState): RunState {
  if (!run.interrupt_outcome) return run;
  return { ...run, interrupt_outcome: null, current_interrupt: null };
}

function upsertTask(tasks: Subtask[], t: Subtask): Subtask[] {
  const i = tasks.findIndex((x) => x.id === t.id);
  if (i === -1) return [...tasks, t];
  const copy = tasks.slice();
  copy[i] = { ...copy[i], ...t };
  return copy;
}

const RUN_FRAMES = new Set(["message", "todos", "task", "interrupt", "stats", "done", "status"]);

export const useStore = create<State>()((set, get) => ({
  connection: { status: "connecting", attempts: 0, connected_once: false },
  run: emptyRun(uiPersist.project || "default"),
  fs: { path: "/", entries: [], loading: false, open: null, files: {} },
  mem: { files: [], drafts: {}, active: null, saving: null },
  skills: [],
  skill_pending: {},
  tools: [],
  mcp: [],
  ui: {
    view: "chat",
    dock: uiPersist.dock,
    sidebar_collapsed: uiPersist.sidebar_collapsed,
    accent: (loadJson(SETTINGS_KEY, DEFAULT_SETTINGS).accent as Accent) || "cyan",
    follow: true,
    dock_tab: uiPersist.dock_tab,
    toolkit_tab: uiPersist.toolkit_tab,
    console_filter: {},
    console_follow: true,
    composer_focus: 0,
    draft: "",
    expanded_agent: null,
  },
  console: [],
  console_n: 0,
  history: { runs: [], loading: false, loaded: false },
  elsewhere: null,
  settings: loadJson(SETTINGS_KEY, DEFAULT_SETTINGS),
  toasts: [],

  send: (f) => sender(f),
  setSender: (fn) => {
    sender = fn;
  },
  setConn: (patch) => set((s) => ({ connection: { ...s.connection, ...patch } })),

  applyFrame: (f, replay = false) => {
    // console ring buffer (every downlink frame, once)
    if (!replay) set((s) => {
      const entry: ConsoleEntry = { n: s.console_n + 1, ts: Date.now(), type: f.type, raw: JSON.stringify(f) };
      const buf = s.console.length >= CONSOLE_MAX ? s.console.slice(s.console.length - CONSOLE_MAX + 1) : s.console.slice();
      buf.push(entry);
      return { console: buf, console_n: entry.n };
    });

    const s = get();
    // Run-scoped frames for another run (e.g. a second tab) are ignored.
    if (opening && RUN_FRAMES.has(f.type) && "run_id" in f && f.run_id === opening.id) {
      opening.frames.push(f); // replayed once the chat has loaded
      return;
    }
    if (RUN_FRAMES.has(f.type) && "run_id" in f && f.run_id !== s.run.id) {
      const el = s.elsewhere;
      if (f.type === "status") set({ elsewhere: f.status === "idle" ? (el?.run_id === f.run_id ? null : el) : { run_id: f.run_id, status: f.status } });
      else if (f.type === "interrupt") set({ elsewhere: { run_id: f.run_id, status: "approval" } });
      else if (f.type === "done" && el?.run_id === f.run_id) set({ elsewhere: null });
      else if ((f.type === "message" || f.type === "task") && el?.run_id === f.run_id && el.status === "approval") set({ elsewhere: { run_id: f.run_id, status: "running" } });
      return;
    }

    switch (f.type) {
      case "hello":
        set((st) => ({ connection: { ...st.connection, hello: f } }));
        return;
      case "message":
        set((st) => {
          let run = upsert(clearOutcome(st.run), f.message, f.partial);
          if (run.status === "idle") run = { ...run, status: "running" };
          return { run };
        });
        return;
      case "todos":
        set((st) => ({ run: { ...st.run, todos: f.todos } }));
        return;
      case "task":
        set((st) => {
          let run = clearOutcome(st.run);
          if (f.event === "start" && f.task) run = { ...run, tasks: upsertTask(run.tasks, f.task) };
          if (f.event === "inner" && f.message) {
            const msg: Message = { ...f.message, id: f.inner_id || f.message.id };
            run = upsert(run, msg, Boolean(f.partial));
          }
          if (f.event === "end" && f.subtask) {
            const cur = run.tasks.find((t) => t.id === f.subtask!.id);
            const ended: Subtask = {
              id: f.subtask.id,
              description: cur?.description ?? "",
              agent: cur?.agent ?? "sub-agent",
              started_at: cur?.started_at ?? Date.now(),
              ...cur,
              status: f.subtask.status,
              report: f.subtask.report,
              error: f.subtask.error,
              ended_at: Date.now(),
            };
            run = { ...run, tasks: upsertTask(run.tasks, ended) };
          }
          return { run };
        });
        return;
      case "interrupt":
        set((st) => {
          // reconnect catch-up resends pending approvals; don't queue one twice
          if (st.run.current_interrupt?.interrupt_id === f.interrupt_id || st.run.queued_interrupts.some((q) => q.interrupt_id === f.interrupt_id)) return {};
          if (st.run.current_interrupt && !st.run.interrupt_outcome) {
            return { run: { ...st.run, queued_interrupts: [...st.run.queued_interrupts, f] } };
          }
          return { run: { ...st.run, current_interrupt: f, interrupt_outcome: null, streaming: null } };
        });
        return;
      case "stats":
        set((st) => ({ run: { ...st.run, stats: f.stats } }));
        return;
      case "status":
        set((st) => ({ run: { ...st.run, status: f.status } }));
        return;
      case "done":
        set((st) => {
          let run = st.run;
          if (f.message) run = upsert(run, f.message, false);
          const ms = f.stats.ended_at ? f.stats.ended_at - f.stats.started_at : null;
          return {
            run: {
              ...run,
              status: "idle",
              streaming: null,
              stats: f.stats,
              last_run_ms: ms,
              queued_interrupts: [],
              current_interrupt: null,
              interrupt_outcome: null,
            },
          };
        });
        if (get().history.loaded) void import("./lib/history").then((m) => m.refreshHistory());
        return;
      case "error": {
        const st = get();
        const pending = Object.keys(st.skill_pending);
        if (pending.length) {
          // roll back optimistic skill toggles
          set((x) => ({
            skills: x.skills.map((sk) => (sk.name in x.skill_pending ? { ...sk, status: x.skill_pending[sk.name] } : sk)),
            skill_pending: {},
          }));
        }
        // "busy" / "stale_interrupt" mean the run is still going (e.g. from another tab)
        if (f.run_id && f.run_id === st.run.id && f.code !== "busy" && f.code !== "stale_interrupt") {
          set((x) => ({ run: { ...x.run, status: "idle", streaming: null } }));
        }
        if (f.code === "file_not_found") set((x) => ({ fs: { ...x.fs, error: f.message } }));
        get().toast("error", f.message);
        return;
      }
      case "fs":
        set((st) => (f.path === st.fs.path ? { fs: { ...st.fs, entries: f.entries, loading: false, error: undefined } } : {}));
        return;
      case "file":
        set((st) => ({ fs: { ...st.fs, files: { ...st.fs.files, [f.path]: f.result }, error: undefined } }));
        return;
      case "memory":
        set((st) => {
          const drafts = { ...st.mem.drafts };
          for (const file of f.files) if (drafts[file.path] === file.content) delete drafts[file.path];
          const saving = st.mem.saving;
          if (saving && f.files.find((x) => x.path === saving)) delete drafts[saving];
          const active = st.mem.active && f.files.some((x) => x.path === st.mem.active) ? st.mem.active : f.files[0]?.path ?? null;
          return { mem: { files: f.files, drafts, active, saving: null } };
        });
        return;
      case "skills":
        set({ skills: f.skills, skill_pending: {} });
        return;
      case "tools":
        set({ tools: f.tools });
        return;
      case "mcp": {
        const before = get().mcp;
        set({ mcp: f.servers });
        for (const srv of f.servers) {
          const prev = before.find((b) => b.id === srv.id);
          if (prev && prev.status !== srv.status) {
            if (srv.status === "connected") get().toast("ok", `MCP ${srv.name} connected (${srv.tools.length} tools)`);
            if (srv.status === "error") get().toast("error", `MCP ${srv.name}: ${srv.error || "error"}`);
          } else if (!prev && srv.status === "error" && get().connection.connected_once && before.length) {
            get().toast("error", `MCP ${srv.name}: ${srv.error || "error"}`);
          }
        }
        return;
      }
      case "notice":
        get().toast(f.level, f.message);
        return;
      case "pong":
        return;
    }
  },

  chat: (content) => {
    const st = get();
    const text = content.trim();
    if (!text || st.run.status !== "idle") return;
    const id = st.run.id || newId();
    const msg: Message = { id: newId("local-"), role: "user", content: text, ts: Date.now() };
    set((x) => {
      const base: RunState = x.run.id ? x.run : { ...emptyRun(x.run.project), id };
      let run = upsert({ ...base, id, title: base.title || text.slice(0, 80) }, msg, false);
      run = {
        ...run,
        status: "running",
        current_interrupt: null,
        interrupt_outcome: null,
        queued_interrupts: [],
        stats: { run_id: id, started_at: Date.now(), tokens_in: run.stats?.tokens_in ?? 0, tokens_out: run.stats?.tokens_out ?? 0 },
        now: Date.now(),
      };
      return { run, ui: { ...x.ui, follow: true, draft: "" } };
    });
    get().send({ type: "chat", run_id: id, content: text, project: st.run.project });
  },

  control: (cmd) => {
    const { run } = get();
    if (!run.id || run.status === "idle") return;
    get().send({ type: "control", run_id: run.id, cmd });
    if (cmd === "pause") set((x) => ({ run: { ...x.run, status: "paused" } }));
    if (cmd === "resume") set((x) => ({ run: { ...x.run, status: "running" } }));
  },

  decide: (decision) => {
    const { run } = get();
    const intr = run.current_interrupt;
    if (!intr || !run.id) return;
    get().send({ type: "interrupt", run_id: run.id, interrupt_id: intr.interrupt_id, decision });
    const outcome: InterruptOutcome = {
      interrupt_id: intr.interrupt_id,
      tool: intr.tool,
      action: decision.action,
      edited: Boolean(decision.edited_args),
      note: decision.note,
    };
    set((x) => {
      const decisions = [...x.run.decisions, { ...outcome, args: intr.args }];
      const [nextIntr, ...rest] = x.run.queued_interrupts;
      if (nextIntr) return { run: { ...x.run, decisions, current_interrupt: nextIntr, queued_interrupts: rest, interrupt_outcome: null } };
      return { run: { ...x.run, decisions, interrupt_outcome: outcome } };
    });
  },

  newChat: () => {
    set((x) => ({ run: emptyRun(x.run.project), elsewhere: leaving(x), ui: { ...x.ui, view: "chat", follow: true } }));
  },

  loadHistoryDetail: (d) => {
    set((x) => {
      let run: RunState = { ...emptyRun(d.project || x.run.project), id: d.id, title: d.title, from_history: true };
      for (const m of d.messages) run = upsert(run, m, false);
      run = {
        ...run,
        streaming: null,
        todos: d.todos || [],
        tasks: d.tasks || [],
        stats: d.stats,
        last_run_ms: d.stats?.ended_at ? d.stats.ended_at - d.stats.started_at : null,
        status: d.running ? "running" : "idle",
        current_interrupt: d.pending_interrupts?.[0] ?? null,
        queued_interrupts: d.pending_interrupts?.slice(1) ?? [],
      };
      run.tool_times = {}; // durations aren't recorded in history; cards just hide them
      const el = leaving(x);
      return { run, elsewhere: el?.run_id === d.id ? null : el, ui: { ...x.ui, view: "chat", follow: true } };
    });
  },

  setHistory: (patch) => set((x) => ({ history: { ...x.history, ...patch } })),

  setView: (v) => set((x) => ({ ui: { ...x.ui, view: v } })),
  setUi: (patch) =>
    set((x) => {
      const ui = { ...x.ui, ...patch };
      saveJson(UI_KEY, { sidebar_collapsed: ui.sidebar_collapsed, dock: ui.dock, dock_tab: ui.dock_tab, toolkit_tab: ui.toolkit_tab, project: x.run.project });
      return { ui };
    }),
  setProject: (p) =>
    set((x) => {
      const project = p.trim() || "default";
      saveJson(UI_KEY, { sidebar_collapsed: x.ui.sidebar_collapsed, dock: x.ui.dock, dock_tab: x.ui.dock_tab, toolkit_tab: x.ui.toolkit_tab, project });
      return { run: { ...x.run, project } };
    }),

  saveSettings: (patch) =>
    set((x) => {
      const settings = { ...x.settings, ...patch };
      saveJson(SETTINGS_KEY, settings);
      return { settings, ui: { ...x.ui, accent: (settings.accent as Accent) || "cyan" } };
    }),
  resetSettings: () => {
    saveJson(SETTINGS_KEY, DEFAULT_SETTINGS);
    set((x) => ({ settings: { ...DEFAULT_SETTINGS }, ui: { ...x.ui, accent: "cyan" } }));
  },

  toast: (level, text) => {
    const id = toastSeq++;
    set((x) => ({ toasts: [...x.toasts.filter((t) => t.text !== text), { id, level, text }].slice(-5) }));
    setTimeout(() => get().dismissToast(id), 4000);
  },
  dismissToast: (id) => set((x) => ({ toasts: x.toasts.filter((t) => t.id !== id) })),

  openDir: (path) => {
    set((x) => ({ fs: { ...x.fs, path, loading: true, open: null, error: undefined } }));
    get().send({ type: "files", path, project: get().run.project });
  },
  openFile: (path) => {
    set((x) => ({ fs: { ...x.fs, open: path, error: undefined } }));
    if (path) get().send({ type: "file", path, project: get().run.project });
  },

  setDraft: (path, content) =>
    set((x) => {
      const original = x.mem.files.find((f) => f.path === path)?.content;
      const drafts = { ...x.mem.drafts };
      if (content === original) delete drafts[path];
      else drafts[path] = content;
      return { mem: { ...x.mem, drafts } };
    }),
  setMemActive: (path) => set((x) => ({ mem: { ...x.mem, active: path } })),
  saveMemory: (path) => {
    const { mem } = get();
    const content = mem.drafts[path];
    if (content === undefined) return;
    set((x) => ({ mem: { ...x.mem, saving: path } }));
    get().send({ type: "memory-save", path, content });
  },

  toggleSkill: (name) => {
    const st = get();
    const skill = st.skills.find((s) => s.name === name);
    if (!skill) return;
    const live = st.connection.hello?.features?.includes("skill-enable");
    set((x) => ({
      skill_pending: { ...x.skill_pending, [name]: skill.status },
      skills: x.skills.map((s) =>
        s.name !== name ? s : live ? { ...s, enabled: !(s.enabled ?? true) } : { ...s, status: s.status === "loaded" ? "idle" : "loaded" },
      ),
    }));
    get().send({ type: "skills-toggle", name });
  },

  addMcp: (srv) => {
    set((x) => ({ mcp: [...x.mcp.filter((m) => m.id !== srv.id), { ...srv, status: "connecting", tools: [], started_at: Date.now() }] }));
    get().send({ type: "mcp-add", ...srv } as Uplink);
  },

  clearConsole: () => set({ console: [] }),
  tickNow: () => set((x) => ({ run: { ...x.run, now: Date.now() } })),
}));

// Drive `run.now` (elapsed timer + spinners) every 500ms, only while a run is active.
let ticker: ReturnType<typeof setInterval> | null = null;
useStore.subscribe((s) => {
  const active = s.run.status !== "idle";
  if (active && !ticker) {
    ticker = setInterval(() => useStore.getState().tickNow(), 500);
  } else if (!active && ticker) {
    clearInterval(ticker);
    ticker = null;
    useStore.getState().tickNow();
  }
});

// Apply the accent colour to the document.
useStore.subscribe((s, prev) => {
  if (s.ui.accent !== prev.ui.accent) document.documentElement.dataset.accent = s.ui.accent;
});
document.documentElement.dataset.accent = useStore.getState().ui.accent;

// ----------------------------------------------------------------- selectors
export const mainMessages = (messages: Message[]) => messages.filter((m) => !m.subagent_id);

/** Tool result message for a call id (search newest-first). */
export function resultFor(messages: Message[], callId: string): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id === callId) return m;
  }
  return undefined;
}

export function invocationCounts(messages: Message[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) for (const c of m.tool_calls || []) out[c.name] = (out[c.name] || 0) + 1;
  return out;
}

export function elapsedMs(run: RunState): number {
  if (!run.stats) return 0;
  return (run.stats.ended_at ?? (run.status === "idle" ? run.stats.started_at : run.now)) - run.stats.started_at;
}
