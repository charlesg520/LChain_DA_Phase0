// WebSocket connection: exponential-backoff reconnect (500ms..8s), queues uplink
// frames while closed, flushes and refetches state on reopen, pings every 15s.
import { useStore } from "./store";
import type { Downlink, Uplink } from "./types";

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 8000;
const QUEUE_MAX = 200;

let ws: WebSocket | null = null;
let backoff = MIN_BACKOFF;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let queue: Uplink[] = [];
let generation = 0;

export function wsUrl(): string {
  const { host, ws_path, token } = useStore.getState().settings;
  const path = ws_path.startsWith("/") ? ws_path : `/${ws_path}`;
  let base: string;
  const h = host.trim().replace(/\/+$/, "");
  if (!h) base = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  else if (/^wss?:\/\//.test(h)) base = h;
  else if (/^https?:\/\//.test(h)) base = h.replace(/^http/, "ws");
  else base = `${location.protocol === "https:" ? "wss:" : "ws:"}//${h}`;
  return `${base}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

function rawSend(f: Uplink): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(f));
    return true;
  }
  return false;
}

export function send(f: Uplink) {
  if (rawSend(f)) return;
  if (f.type === "ping") return;
  queue.push(f);
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
  if (f.type === "chat") useStore.getState().toast("warn", "Not connected: your message is queued and will send on reconnect");
}

function refetch() {
  const st = useStore.getState();
  rawSend({ type: "files", path: st.fs.path, project: st.run.project });
  rawSend({ type: "memory" });
  rawSend({ type: "skills" });
  rawSend({ type: "tools" });
}

export function connect() {
  const gen = ++generation;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  const st = useStore.getState();
  st.setConn({ status: "connecting" });
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch (e) {
    st.setConn({ status: "closed", error: (e as Error).message });
    scheduleReconnect(gen);
    return;
  }
  ws = sock;

  sock.onopen = () => {
    if (gen !== generation) return;
    backoff = MIN_BACKOFF;
    const s = useStore.getState();
    const again = s.connection.connected_once;
    s.setConn({ status: "open", attempts: 0, error: undefined, connected_once: true });
    s.toast("ok", again ? "Reconnected" : "Connected");
    const pending = queue;
    queue = [];
    for (const f of pending) rawSend(f);
    if (again) refetch();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => rawSend({ type: "ping", ts: Date.now() }), 15_000);
  };

  sock.onmessage = (ev) => {
    let frame: Downlink;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    useStore.getState().applyFrame(frame);
  };

  sock.onclose = (ev) => {
    if (gen !== generation) return;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    const s = useStore.getState();
    const wasOpen = s.connection.status === "open";
    if (ev.code === 4401) {
      s.setConn({ status: "unauthorized", error: ev.reason || "token rejected" });
      s.toast("error", "The server rejected your token. Set it in Settings.");
      return;
    }
    s.setConn({ status: "closed", attempts: s.connection.attempts + 1, error: ev.reason || undefined });
    if (wasOpen) s.toast("warn", "Connection lost, retrying…");
    if (s.run.status !== "idle") {
      // The server keeps the run going; frames resume after reconnect.
    }
    scheduleReconnect(gen);
  };
}

function scheduleReconnect(gen: number) {
  if (gen !== generation) return;
  const delay = backoff;
  backoff = Math.min(MAX_BACKOFF, backoff * 2);
  retryTimer = setTimeout(() => {
    if (gen === generation) connect();
  }, delay);
}

/** Reconnect now with the latest settings (used after saving Settings). */
export function reconnect() {
  backoff = MIN_BACKOFF;
  connect();
}

export function initConnection() {
  useStore.getState().setSender(send);
  connect();
  window.addEventListener("online", () => {
    if (useStore.getState().connection.status !== "open") reconnect();
  });
}
