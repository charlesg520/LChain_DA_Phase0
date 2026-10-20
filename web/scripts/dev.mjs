// `pnpm start`: the console server (mock mode unless HQ_API_URL is set) plus
// the Vite dev server, which proxies /api, /media and /ws to it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs = [];
const run = (name, cmd, args, cwd, env = {}) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = name === "server" ? "\x1b[36m[server]\x1b[0m" : "\x1b[35m[ui]\x1b[0m";
  for (const s of [p.stdout, p.stderr]) s.on("data", (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `${tag} `)));
  p.on("exit", (code) => {
    console.log(`${tag} exited (${code})`);
    for (const q of procs) if (q !== p && q.exitCode === null) q.kill();
    process.exit(code ?? 0);
  });
  procs.push(p);
};

const port = process.env.PORT || "3000";
run("server", process.execPath, ["src/index.js"], path.join(root, "server"), { PORT: port });
run("ui", process.execPath, [path.join(root, "ui", "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"], path.join(root, "ui"), {
  HQ_WEB_SERVER: `http://127.0.0.1:${port}`,
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => procs.forEach((p) => p.kill()));
