import { useEffect, useState } from "react";
import { Dock, Header, Rail } from "./components/Shell";
import { Toasts } from "./components/Toasts";
import { useStore } from "./store";
import { AgentsView } from "./views/AgentsView";
import { ChatView } from "./views/ChatView";
import { ConsoleView } from "./views/ConsoleView";
import { FilesView } from "./views/FilesView";
import { HistoryView } from "./views/HistoryView";
import { MemoryView } from "./views/MemoryView";
import { SettingsView } from "./views/SettingsView";
import { TasksView } from "./views/TasksView";
import { ToolkitView } from "./views/ToolkitView";

function useWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function App() {
  const view = useStore((s) => s.ui.view);
  const dock = useStore((s) => s.ui.dock);
  const conn = useStore((s) => s.connection.status);
  const setView = useStore((s) => s.setView);
  const width = useWidth();
  const narrow = width < 768;
  const overlayDock = width < 1280;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        st.setUi({ view: "chat", composer_focus: Date.now() });
        return;
      }
      if (e.key === "Escape" && st.run.status !== "idle") {
        const el = document.activeElement as HTMLElement | null;
        const typing = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && el.getAttribute("aria-label") !== "Message";
        if (!typing) {
          e.preventDefault();
          st.control("stop");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header />
      {conn === "unauthorized" && view !== "settings" && (
        <div className="flex shrink-0 items-center justify-center gap-3 border-b border-err/30 bg-err/[0.08] px-4 py-2 text-[12.5px] text-err">
          The server needs your access token.
          <button className="btn btn-err btn-sm h-6" onClick={() => setView("settings")}>
            open settings
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <Rail narrow={narrow} />
        <main className="min-w-0 flex-1 overflow-hidden">
          {view === "chat" && <ChatView />}
          {view === "history" && <HistoryView />}
          {view === "tasks" && <TasksView />}
          {view === "agents" && <AgentsView />}
          {view === "files" && <FilesView />}
          {view === "memory" && <MemoryView />}
          {view === "toolkit" && <ToolkitView />}
          {view === "console" && <ConsoleView />}
          {view === "settings" && <SettingsView />}
        </main>
        {dock && <Dock overlay={overlayDock} />}
      </div>
      <Toasts />
    </div>
  );
}
