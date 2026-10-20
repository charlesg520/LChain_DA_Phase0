import { ChevronRight, File, FileCode, FileText, Film, Folder, FolderTree, Home, Image, Music, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { FileViewer } from "../components/FileViewer";
import { Empty, Spinner, ViewHeader, cx } from "../components/ui";
import { bytes, relTime } from "../lib/format";
import { useStore } from "../store";
import type { FsEntry } from "../types";

function iconFor(e: FsEntry) {
  if (e.type === "dir") return <Folder className="h-4 w-4 text-accent/80" />;
  const m = e.mime || "";
  if (m.startsWith("image/")) return <Image className="h-4 w-4 text-[#f0abfc]" />;
  if (m.startsWith("video/")) return <Film className="h-4 w-4 text-[#fca5a5]" />;
  if (m.startsWith("audio/")) return <Music className="h-4 w-4 text-[#fcd34d]" />;
  if (m.includes("markdown") || m === "text/plain") return <FileText className="h-4 w-4 text-muted" />;
  if (m.startsWith("text/") || m.includes("json")) return <FileCode className="h-4 w-4 text-[#93c5fd]" />;
  return <File className="h-4 w-4 text-muted" />;
}

export function FilesView() {
  const fs = useStore((s) => s.fs);
  const conn = useStore((s) => s.connection.status);
  const project = useStore((s) => s.run.project);
  const openDir = useStore((s) => s.openDir);
  const openFile = useStore((s) => s.openFile);
  const live = useStore((s) => s.connection.hello?.mode === "live");

  useEffect(() => {
    if (conn === "open") openDir(fs.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, project]);

  const parts = fs.path.split("/").filter(Boolean);
  const crumbs = parts.map((p, i) => ({ name: p, path: "/" + parts.slice(0, i + 1).join("/") }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        icon={<FolderTree />}
        title="Files"
        subtitle={live ? `sandbox workspace, memory and skills · project ${project}` : "the agent's virtual filesystem"}
        right={
          <button className="btn btn-sm" onClick={() => openDir(fs.path)}>
            {fs.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} refresh
          </button>
        }
      />
      <nav className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 font-mono text-[12.5px]" aria-label="Breadcrumb">
        <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-panel-hi hover:text-text" onClick={() => openDir("/")}>
          <Home className="h-3.5 w-3.5" /> /
        </button>
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted/60" />
            <button
              className={cx("rounded px-1.5 py-0.5 hover:bg-panel-hi", i === crumbs.length - 1 ? "text-text" : "text-muted hover:text-text")}
              onClick={() => openDir(c.path)}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <div className={cx("min-h-0 overflow-y-auto border-border", fs.open ? "hidden w-[320px] shrink-0 border-r lg:block" : "flex-1")}>
          {fs.loading && fs.entries.length === 0 ? (
            <div className="flex h-32 items-center justify-center gap-2 text-muted">
              <Spinner /> loading
            </div>
          ) : fs.entries.length === 0 ? (
            <Empty icon={<Folder />} title="Empty folder" hint={fs.error || (fs.path === "/" ? "Nothing here yet." : "This folder has no files yet.")} />
          ) : (
            <table className="w-full text-[13px]">
              {!fs.open && (
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted">
                    <th className="px-4 py-2 font-semibold">name</th>
                    <th className="w-24 px-3 py-2 text-right font-semibold">size</th>
                    <th className="hidden w-32 px-4 py-2 text-right font-semibold sm:table-cell">modified</th>
                  </tr>
                </thead>
              )}
              <tbody>
                {fs.entries.map((e) => (
                  <tr
                    key={e.path}
                    className={cx("cursor-pointer border-b border-border/60 hover:bg-panel", fs.open === e.path && "bg-accent/[0.07]")}
                    onClick={() => (e.type === "dir" ? openDir(e.path) : openFile(e.path))}
                  >
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2.5">
                        {iconFor(e)}
                        <span className={cx("truncate", e.type === "dir" ? "font-medium text-text" : "text-text/90")}>{e.name}</span>
                      </span>
                    </td>
                    {!fs.open && (
                      <>
                        <td className="px-3 py-2 text-right font-mono text-[11.5px] text-muted">{e.type === "dir" ? "–" : bytes(e.size)}</td>
                        <td className="hidden px-4 py-2 text-right font-mono text-[11.5px] text-muted sm:table-cell">{e.modified_at ? relTime(e.modified_at) : "–"}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {fs.open && (
          <div className="min-h-0 min-w-0 flex-1">
            <FileViewer path={fs.open} onClose={() => openFile(null)} />
          </div>
        )}
      </div>
    </div>
  );
}
