import { Hammer, Puzzle, Server, Wrench } from "lucide-react";
import { ViewHeader, cx } from "../components/ui";
import { useStore, type ToolkitTab } from "../store";
import { ServersTab } from "./toolkit/ServersTab";
import { SkillsTab } from "./toolkit/SkillsTab";
import { ToolsTab } from "./toolkit/ToolsTab";

export function ToolkitView() {
  const tab = useStore((s) => s.ui.toolkit_tab);
  const setUi = useStore((s) => s.setUi);
  const skills = useStore((s) => s.skills.length);
  const tools = useStore((s) => s.tools.length);
  const servers = useStore((s) => s.mcp);
  const tabs: { id: ToolkitTab; label: string; icon: React.ReactNode; count: number; alert?: boolean }[] = [
    { id: "skills", label: "Skills", icon: <Puzzle className="h-3.5 w-3.5" />, count: skills },
    { id: "tools", label: "Tools", icon: <Hammer className="h-3.5 w-3.5" />, count: tools },
    { id: "servers", label: "Servers", icon: <Server className="h-3.5 w-3.5" />, count: servers.length, alert: servers.some((s) => s.status === "error") },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader icon={<Wrench />} title="Toolkit" subtitle="What HQ knows how to do, and what it can reach" />
      <div className="flex h-11 shrink-0 items-end gap-1 border-b border-border px-4" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setUi({ toolkit_tab: t.id })}
            className={cx(
              "-mb-px flex h-10 items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium",
              tab === t.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.icon}
            {t.label}
            <span className={cx("rounded-full px-1.5 font-mono text-[10.5px]", t.alert ? "bg-err/20 text-err" : "bg-panel-hi text-muted")}>{t.count}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-5">
          {tab === "skills" && <SkillsTab />}
          {tab === "tools" && <ToolsTab />}
          {tab === "servers" && <ServersTab />}
        </div>
      </div>
    </div>
  );
}
