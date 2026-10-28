// HQ console server.
//
//   HQ_WEB_MODE=mock  (default when HQ_API_URL is unset): standalone scripted demo
//   HQ_WEB_MODE=live: bridge to a running HQ (Aegra + /ops) at HQ_API_URL
//
// Browsers authenticate with WEB_TOKEN (live mode defaults it to HQ_API_TOKEN):
// as ?token= on the WebSocket and as a bearer header on REST. The HQ API token
// itself stays on this server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { VERSION, safeEqual } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const MODE = (env.HQ_WEB_MODE || (env.HQ_API_URL ? "live" : "mock")).toLowerCase();
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || "0.0.0.0";
const WS_PATH = env.WS_PATH || "/ws";
const TOKEN = env.WEB_TOKEN || (MODE === "live" ? env.HQ_API_TOKEN || "" : env.MOCK_TOKEN || "");
const UI_DIST = path.resolve(env.UI_DIST || path.join(HERE, "..", "..", "ui", "dist"));

if (MODE === "live" && TOKEN.length < 16) {
  console.error("live mode needs WEB_TOKEN or HQ_API_TOKEN (16+ chars) so the console isn't open to the internet");
  process.exit(1);
}

// ------------------------------------------------------------------- hub
/** @type {Set<{id:number, ws:import("ws").WebSocket, send:(f:any)=>void}>} */
const clients = new Set();
let nextId = 1;
const hub = {
  broadcast(frame) {
    const data = JSON.stringify(frame);
    for (const c of clients) if (c.ws.readyState === 1) c.ws.send(data);
  },
  get size() {
    return clients.size;
  },
};

/**
 * Both backends implement hello/snapshots/handle/routes; media (static assets)
 * and onConnect (catch-up for runs in progress) are optional.
 * @type {any}
 */
const backend =
  MODE === "live"
    ? new (await import("./live/backend.js")).LiveBackend(hub, {
        apiUrl: env.HQ_API_URL || "http://agent:8000",
        apiToken: env.HQ_API_TOKEN || "",
        dataDir: env.WEB_DATA_DIR || path.join(HERE, "..", "data"),
        assistant: env.HQ_ASSISTANT || "hq",
        notify: {
          url: env.NTFY_URL,
          topic: env.NTFY_TOPIC,
          token: env.NTFY_TOKEN,
          publicUrl: env.HQ_PUBLIC_URL,
          doneMinSeconds: env.NTFY_DONE_MIN_SECONDS ? Number(env.NTFY_DONE_MIN_SECONDS) : undefined,
        },
      })
    : new (await import("./mock/backend.js")).MockBackend(hub);

// ------------------------------------------------------------------ http
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  // Same-origin in production (served together); open CORS only for localhost dev tools.
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

function authorized(req) {
  if (!TOKEN) return true;
  const header = String(req.headers.authorization || "");
  const supplied = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : String(req.query.token || "");
  return safeEqual(supplied, TOKEN);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: MODE, version: VERSION, auth: Boolean(TOKEN) }));

// Public routes (no console token), e.g. one-time notification buttons.
if (backend.publicRoutes) backend.publicRoutes(app);

const api = express.Router();
api.use((req, res, next) => (authorized(req) ? next() : res.status(401).json({ error: "invalid or missing token" })));
backend.routes(api);
app.use("/api", api);

if (backend.media) backend.media(app, express);

if (fs.existsSync(path.join(UI_DIST, "index.html"))) {
  app.use(express.static(UI_DIST, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|media\/|ws$).*/, (_req, res) => res.sendFile(path.join(UI_DIST, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.type("text").send(`HQ console server (${MODE}). No built UI at ${UI_DIST}; run the Vite dev server (pnpm start) or pnpm build.`),
  );
}

app.use((err, _req, res, _next) => {
  console.error("http error:", err);
  res.status(err.status || 500).json({ error: String(err.message || err) });
});

// -------------------------------------------------------------------- ws
const server = http.createServer(app);
// Streaming re-sends the growing message, so compress anything non-trivial.
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: { threshold: 1024 } });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname !== WS_PATH) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (TOKEN && !safeEqual(url.searchParams.get("token") || "", TOKEN)) {
      ws.close(4401, "invalid or missing token");
      return;
    }
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws) => {
  const client = { id: nextId++, ws, send: (f) => ws.readyState === 1 && ws.send(JSON.stringify(f)) };
  clients.add(client);
  let alive = true;
  ws.on("pong", () => (alive = true));
  const beat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on("message", async (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return client.send({ type: "error", message: "frames must be JSON", code: "bad_frame" });
    }
    if (!frame || typeof frame.type !== "string") return client.send({ type: "error", message: "frame needs a type", code: "bad_frame" });
    if (frame.type === "ping") return client.send({ type: "pong", ts: frame.ts });
    try {
      await backend.handle(client, frame);
    } catch (e) {
      console.error(`handling ${frame.type}:`, e);
      client.send({ type: "error", run_id: frame.run_id, message: String(e?.message || e), code: "server_error" });
    }
  });
  ws.on("close", () => {
    clearInterval(beat);
    clients.delete(client);
  });

  try {
    client.send(await backend.hello());
    for (const f of await backend.snapshots(client)) client.send(f);
    if (backend.onConnect) await backend.onConnect(client);
  } catch (e) {
    client.send({ type: "error", message: `could not load initial state: ${e?.message || e}`, code: "backend_unavailable" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HQ console server ${VERSION} (${MODE}) on http://${HOST}:${PORT}  ws:${WS_PATH}  auth:${TOKEN ? "on" : "off"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    wss.clients.forEach((ws) => ws.close(1001, "server shutting down"));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
