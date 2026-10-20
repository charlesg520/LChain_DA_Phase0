import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import WebSocket from "ws";

/** Start the server on a free port with the given env; resolves once it's listening. */
export async function startServer(env = {}) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ["src/index.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", UI_DIST: "/nonexistent", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (log.includes("HQ console server")) break;
    if (proc.exitCode !== null) throw new Error("server exited: " + log);
    await wait(50);
  }
  return { port, url: `http://127.0.0.1:${port}`, proc, log: () => log, stop: () => proc.kill() };
}

/** A ws client that records every frame and can wait for one matching a predicate. */
export async function connect(port, token = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  const frames = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  const closed = new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); ws.on("close", resolve); });
  return {
    ws,
    frames,
    closed,
    send: (f) => ws.send(JSON.stringify(f)),
    waitFor(pred, ms = 20000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for frame; last: " + JSON.stringify(frames.slice(-3)))), ms);
        waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
      });
    },
    close: () => ws.close(),
  };
}
