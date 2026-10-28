import { ArrowDown, Bot, Code2, FileSearch, GitPullRequest, LineChart, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Composer } from "../components/Composer";
import { InterruptCard } from "../components/InterruptCard";
import { MessageRow } from "../components/MessageRow";
import { TodosCard } from "../components/Todos";
import { cx } from "../components/ui";
import { openHistory, refreshHistory } from "../lib/history";
import { useStore } from "../store";

const STARTERS = [
  { icon: <Code2 />, text: "Clone github.com/charlesg520/LChain_DA_Phase0, run the tests, and tell me what fails." },
  { icon: <GitPullRequest />, text: "Review my last commit for bugs and security issues." },
  { icon: <FileSearch />, text: "Research the best way to self-host a vector DB on 8 GB RAM and summarize with sources." },
  { icon: <LineChart />, text: "Write a Pine Script v6 strategy for a 20/50 EMA crossover with ATR stops, and a Python backtest." },
];

export function ChatView() {
  const messages = useStore((s) => s.run.messages);
  const streaming = useStore((s) => s.run.streaming);
  const todos = useStore((s) => s.run.todos);
  const status = useStore((s) => s.run.status);
  const statusDetail = useStore((s) => s.run.status_detail);
  const parallel = useStore((s) => Boolean(s.connection.hello?.features?.includes("parallel-chats")));
  const title = useStore((s) => s.run.title);
  const fromHistory = useStore((s) => s.run.from_history);
  const hasInterrupt = useStore((s) => Boolean(s.run.current_interrupt));
  const follow = useStore((s) => s.ui.follow);
  const setUi = useStore((s) => s.setUi);
  const newChat = useStore((s) => s.newChat);
  const tasks = useStore((s) => s.run.tasks);
  const runningTasks = useMemo(() => tasks.filter((t) => t.status === "running"), [tasks]);
  const scroller = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);

  // Main flow: no sub-agent messages; tool results render inside their ToolCard.
  const flow = useMemo(() => {
    const calls = new Set<string>();
    for (const m of messages) if (!m.subagent_id) for (const c of m.tool_calls || []) calls.add(c.id);
    return messages.filter((m) => !m.subagent_id && !(m.role === "tool" && m.tool_call_id && calls.has(m.tool_call_id)));
  }, [messages]);
  const lastAssistant = useMemo(() => {
    for (let i = flow.length - 1; i >= 0; i--) if (flow[i].role === "assistant") return i;
    return -1;
  }, [flow]);

  // Auto-scroll while following; a manual scroll up unfollows.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !follow) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      if (programmatic.current) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      const st = useStore.getState();
      if (atBottom !== st.ui.follow) st.setUi({ follow: atBottom });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const empty = flow.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ElsewhereBanner />
      {(title || fromHistory) && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-5 text-[12.5px]">
          <span className="truncate font-medium text-text/90">{title || "Untitled chat"}</span>
          {fromHistory && status === "idle" && <span className="tag border-border text-muted">from history</span>}
          <button className="btn btn-ghost btn-sm ml-auto" onClick={newChat} disabled={status !== "idle" && !parallel}>
            <Plus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">new chat</span>
          </button>
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <Welcome />
        ) : (
          <div className="mx-auto max-w-[920px] space-y-3 px-4 py-6 md:px-6">
            {flow.map((m, i) => (
              <div key={m.id} className="animate-slidein">
                <MessageRow m={m} messages={messages} streaming={streaming === m.id} />
                {i === lastAssistant && todos.length > 0 && !hasInterrupt && (
                  <div className="ml-9 mt-3">
                    <TodosCard todos={todos} />
                  </div>
                )}
              </div>
            ))}
            {lastAssistant === -1 && todos.length > 0 && <TodosCard todos={todos} />}
            {runningTasks.length > 0 && (
              <div className="ml-9 flex flex-wrap gap-2">
                {runningTasks.map((t) => (
                  <button
                    key={t.id}
                    className="flex items-center gap-2 rounded-card border border-info/40 bg-info/[0.07] px-2.5 py-1.5 text-[12px] text-[#c4b5fd] hover:bg-info/15"
                    onClick={() => {
                      setUi({ expanded_agent: t.id });
                      useStore.getState().setView("agents");
                    }}
                  >
                    <Bot className="h-3.5 w-3.5 animate-pulsedot" />
                    <span className="font-mono">{t.agent}</span>
                    <span className="max-w-[340px] truncate text-muted">{t.description}</span>
                  </button>
                ))}
              </div>
            )}
            {hasInterrupt && (
              <div className="ml-9 space-y-3">
                <InterruptCard />
                {todos.length > 0 && <TodosCard todos={todos} />}
              </div>
            )}
            {status !== "idle" && !streaming && !hasInterrupt && (
              <div className="ml-9 flex items-center gap-2 text-[12px] text-muted">
                <span className="flex gap-1">
                  {[0, 1, 2].map((d) => (
                    <span key={d} className="h-1.5 w-1.5 animate-pulsedot rounded-full bg-accent" style={{ animationDelay: `${d * 160}ms` }} />
                  ))}
                </span>
                {status === "paused" ? "paused" : "working"}
                {statusDetail && status !== "paused" && <span className="text-warn">· {statusDetail}</span>}
              </div>
            )}
            <div className="h-2" />
          </div>
        )}
      </div>
      {!follow && !empty && (
        <button
          className="absolute bottom-[104px] left-1/2 z-20 flex -translate-x-1/2 animate-slidein items-center gap-1.5 rounded-full border border-accent/50 bg-panel px-3 py-1.5 text-[12px] text-accent shadow-xl hover:bg-panel-hi"
          onClick={() => setUi({ follow: true })}
        >
          <ArrowDown className="h-3.5 w-3.5" /> jump to latest
        </button>
      )}
      <Composer />
    </div>
  );
}

function Welcome() {
  const setUi = useStore((s) => s.setUi);
  const hello = useStore((s) => s.connection.hello);
  const conn = useStore((s) => s.connection.status);
  return (
    <div className="mx-auto flex h-full max-w-[760px] flex-col justify-center px-6 py-10">
      <div className="mb-6">
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-accent/40 bg-accent/10 font-mono text-[15px] font-bold text-accent">
          HQ
        </div>
        <h2 className="text-[22px] font-semibold tracking-tight">What are we building?</h2>
        <p className="mt-1 text-[13.5px] text-muted">
          HQ plans, codes in its own sandbox, delegates to sub-agents, and pushes <span className="font-mono text-text/80">hq/*</span> branches. Anything risky
          waits for your approval.
          {hello?.mode === "mock" && <span className="text-warn"> Mock mode: any message plays a scripted demo run.</span>}
        </p>
        {conn === "unauthorized" && <p className="mt-2 text-[13px] text-err">Not signed in: paste your HQ token in Settings.</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button
            key={s.text}
            onClick={() => setUi({ draft: s.text, composer_focus: Date.now() })}
            className={cx("card group flex items-start gap-3 p-3.5 text-left text-[12.5px] text-muted transition-colors hover:border-accent/40 hover:text-text")}
          >
            <span className="mt-0.5 text-accent/80 [&>svg]:h-4 [&>svg]:w-4">{s.icon}</span>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** HQ is still busy (or waiting on you) in a chat you navigated away from. */
// Right after the page loads (a refresh, or a second device), jump straight into a
// chat HQ is still working in instead of showing an empty one.
// (Not when the page was opened from a notification link: that names its own chat.)
let autoOpen = !new URLSearchParams(window.location.search).has("chat");
setTimeout(() => (autoOpen = false), 8000);

function ElsewhereBanner() {
  const el = useStore((s) => s.elsewhere);
  const runs = useStore((s) => s.history.runs);
  const historyLoaded = useStore((s) => s.history.loaded);
  const blank = useStore((s) => !s.run.id && s.run.order.length === 0);
  const known = Boolean(el && runs.some((r) => r.id === el.run_id));
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!el) return;
    if (autoOpen && blank) {
      autoOpen = false;
      openHistory(el.run_id);
    } else if ((!historyLoaded || !known) && asked.current !== el.run_id) {
      asked.current = el.run_id; // once per chat, to learn its title
      refreshHistory();
    }
  }, [el, blank, historyLoaded, known]);
  if (!el) return null;
  const title = runs.find((r) => r.id === el.run_id)?.title || "another chat";
  const approval = el.status === "approval";
  return (
    <div
      className={cx(
        "flex shrink-0 items-center gap-2 border-b px-5 py-1.5 text-[12.5px]",
        approval ? "border-warn/40 bg-warn/10 text-warn" : "border-accent/30 bg-accent/5 text-accent",
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" />
      <span className="min-w-0 truncate">
        {approval ? "Waiting for your approval in " : el.status === "paused" ? "Paused in " : "HQ is working in "}
        <span className="font-medium">{title}</span>
      </span>
      <button className="btn btn-ghost btn-sm ml-auto shrink-0" onClick={() => openHistory(el.run_id)}>
        open
      </button>
    </div>
  );
}
