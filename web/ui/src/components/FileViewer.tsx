import { Code2, Download, Eye, FileWarning, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { bytes } from "../lib/format";
import { langForMime } from "../lib/highlight";
import { useStore } from "../store";
import type { FsResult } from "../types";
import { CodeView } from "./Code";
import { Markdown } from "./Markdown";
import { CopyButton, Spinner, Tag } from "./ui";

function toBlob(r: FsResult): Blob {
  if (r.encoding === "utf8") return new Blob([r.content], { type: r.mime || "text/plain" });
  const bin = atob(r.content);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: r.mime || "application/octet-stream" });
}

function isText(r: FsResult) {
  return r.encoding === "utf8";
}

export function FileViewer({ path, onClose }: { path: string; onClose?: () => void }) {
  const result = useStore((s) => s.fs.files[path]);
  const error = useStore((s) => s.fs.error);
  const [mode, setMode] = useState<"source" | "rendered">("rendered");
  const blobUrl = useMemo(() => (result ? URL.createObjectURL(toBlob(result)) : null), [result]);
  useEffect(() => () => void (blobUrl && URL.revokeObjectURL(blobUrl)), [blobUrl]);

  const name = path.split("/").pop() || path;
  const isMd = Boolean(result && isText(result) && (result.mime.includes("markdown") || /\.mdx?$/i.test(path)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate font-mono text-[12.5px] text-text">{path}</span>
        {result && (
          <>
            <Tag>{result.mime}</Tag>
            <span className="font-mono text-[11px] text-muted">{bytes(result.size)}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {isMd && (
            <div className="mr-1 flex rounded-card border border-border p-0.5">
              <button className={`btn btn-sm h-6 border-0 ${mode === "rendered" ? "bg-panel-hi text-text" : "bg-transparent text-muted"}`} onClick={() => setMode("rendered")}>
                <Eye className="h-3.5 w-3.5" /> rendered
              </button>
              <button className={`btn btn-sm h-6 border-0 ${mode === "source" ? "bg-panel-hi text-text" : "bg-transparent text-muted"}`} onClick={() => setMode("source")}>
                <Code2 className="h-3.5 w-3.5" /> source
              </button>
            </div>
          )}
          {result && isText(result) && <CopyButton text={result.content} />}
          {blobUrl && (
            <a className="btn btn-sm" href={blobUrl} download={name}>
              <Download className="h-3.5 w-3.5" /> download
            </a>
          )}
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close file">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!result ? (
          error ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-err">
              <FileWarning className="h-4 w-4" /> {error}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-muted">
              <Spinner /> loading {name}…
            </div>
          )
        ) : (
          <Body result={result} url={blobUrl!} mode={mode} isMd={isMd} />
        )}
      </div>
    </div>
  );
}

function Body({ result, url, mode, isMd }: { result: FsResult; url: string; mode: "source" | "rendered"; isMd: boolean }) {
  const mime = result.mime || "";
  if (mime.startsWith("image/")) {
    return (
      <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(#121824_0%_25%,#0e131c_0%_50%)] bg-[length:20px_20px] p-6">
        <img src={url} alt={result.path} className="max-h-[75vh] max-w-full rounded-card border border-border [image-rendering:auto]" />
      </div>
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <video src={url} controls className="max-h-[75vh] max-w-full rounded-card border border-border bg-black" />
      </div>
    );
  }
  if (mime.startsWith("audio/")) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <audio src={url} controls className="w-full max-w-lg" />
      </div>
    );
  }
  if (mime === "application/pdf") {
    return (
      <div className="flex h-full min-h-[70vh] flex-col">
        <div className="flex h-8 shrink-0 items-center justify-end border-b border-border px-3 text-[12px]">
          <a className="text-accent hover:underline" href={url} target="_blank" rel="noreferrer">
            open in a new tab
          </a>
        </div>
        <iframe title={result.path} src={url} className="min-h-0 w-full flex-1 border-0 bg-white" />
      </div>
    );
  }
  if (!isText(result)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-muted">
        <FileWarning className="h-6 w-6" />
        Binary file ({mime || "unknown type"}). Use download to open it.
      </div>
    );
  }
  if (isMd && mode === "rendered") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-5">
        <Markdown text={result.content} />
      </div>
    );
  }
  return <CodeView code={result.content} lang={langForMime(mime, result.path)} className="py-2" />;
}
