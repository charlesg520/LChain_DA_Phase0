// Small helpers shared by the mock and live backends.
import crypto from "node:crypto";
import path from "node:path";

export const VERSION = "0.3.0";

export const now = () => Date.now();

export const uid = (prefix = "") => prefix + crypto.randomBytes(8).toString("hex");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Constant-time string compare that tolerates different lengths. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

const MIME = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/x-toml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".sh": "text/x-sh",
  ".bash": "text/x-sh",
  ".pine": "text/x-pine",
  ".sql": "text/x-sql",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".xml": "application/xml",
  ".env": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

const TEXT_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE", "README", ".gitignore", ".dockerignore", ".env.example"]);

export function mimeFor(filePath) {
  const base = path.posix.basename(filePath);
  if (TEXT_NAMES.has(base)) return "text/plain";
  return MIME[path.posix.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function isTextMime(mime) {
  return (
    mime.startsWith("text/") ||
    ["application/json", "application/x-ndjson", "application/xml", "image/svg+xml"].includes(mime)
  );
}

/** Heuristic: bytes with no NUL in the first 8 KB and valid UTF-8 are text. */
export function looksLikeText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}

/** Normalize a client-supplied virtual path: absolute, no "..", no trailing slash (except "/"). */
export function cleanPath(raw) {
  const p = path.posix.normalize("/" + String(raw || "/").replace(/\\/g, "/"));
  if (p.split("/").includes("..")) return "/";
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** MOCK_SPEED=10 runs the scripted demo ten times faster (tests use this). */
export const SPEED = Math.max(0.1, Number(process.env.MOCK_SPEED || 1));

export class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

/**
 * Pause/stop control for a scripted run. `tick(ms)` sleeps, holding while
 * paused and throwing Stopped once stop() is called.
 */
export class RunControl {
  constructor() {
    this.paused = false;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async tick(ms) {
    let left = ms / SPEED;
    while (left > 0 || this.paused) {
      if (this.stopped) throw new Stopped();
      const step = this.paused ? 50 : Math.max(1, Math.min(50, left));
      await sleep(step);
      if (!this.paused) left -= step;
    }
    if (this.stopped) throw new Stopped();
  }
}

/** Split text into stream-sized chunks (words with their trailing whitespace). */
export function chunks(text, size = 3) {
  const words = text.match(/\S+\s*|\s+/g) || [];
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(""));
  return out;
}
