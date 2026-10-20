export function mmss(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return mmss(ms);
}

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return "just now";
  if (d < 3600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)}h ago`;
  if (d < 7 * 86400_000) return `${Math.round(d / 86400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** One-line summary of tool args for card headers. */
export function argsSummary(args: Record<string, unknown> | undefined, max = 90): string {
  if (!args) return "";
  const preferred = ["command", "file_path", "path", "file", "pattern", "url", "query", "description", "subagent_type"];
  const keys = [...preferred.filter((k) => k in args), ...Object.keys(args).filter((k) => !preferred.includes(k))];
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(keys.length === 1 || preferred.includes(k) ? s : `${k}=${s}`);
    if (parts.join("  ").length > max) break;
  }
  const out = parts.join("  ").replace(/\s+/g, " ");
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return "--------";
  return id.replace(/^run-/, "").replace(/-/g, "").slice(0, n);
}

export function newId(prefix = ""): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return prefix + c.randomUUID();
  return prefix + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export function clampLines(text: string, maxLines: number): { text: string; clipped: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, clipped: 0 };
  return { text: lines.slice(0, maxLines).join("\n"), clipped: lines.length - maxLines };
}
