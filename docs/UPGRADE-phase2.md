# Upgrading the VPS to Phase 2 (the web console)

About 10 minutes, most of it the first image build. Threads, memories, skills and sandboxes are untouched.

## 1. Get the code onto GitHub (PowerShell, on your PC)

```powershell
cd $HOME\Documents\hq
git pull $HOME\Downloads\hq-phase2.bundle main
git push origin main
```

## 2. Pull it on the VPS

```bash
ssh hq
cd ~/hq && git pull
```

## 3. Two settings in `.env`

```bash
nano .env
```

- `ENABLE_TODOS=true` so the plan checklist shows up in Chat and Tasks.
- Optional: `HQ_REQUIRE_APPROVAL=` lists tools that always wait for your OK, e.g. `HQ_REQUIRE_APPROVAL=edit_file,write_file`. Empty means only MCP tools in a server's `approve` list ask (sandboxes and the `hq/*`-only git gateway already contain the rest).

Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.

## 4. Build and start

```bash
make up                         # builds the new web image (first time ~3 min) and starts it
docker compose restart caddy    # Caddy only reads its config at start; this picks up the new routes
make ps                         # web should be "healthy"
```

## 5. Open it

1. On the VPS, show your token: `grep ^HQ_API_TOKEN .env` (don't paste it into a chat).
2. Open https://hq.quickprohub.co/ → **Settings** → paste the token into *Token* → **save & reconnect**.
3. The header shows the model name and **READY**. Send a message.

The token is kept in that browser only. On your phone, do the same once.

## Check it

- `make logs-web`: the console's log. You should see `HQ console server ... (live)`.
- `make smoke` still works: scripts and curl keep using `https://hq.quickprohub.co/api/...` as before.
- Toolkit → Servers: `github` shows *error: set GITHUB_MCP_TOKEN in .env* until you set that token. That's expected.

## If something's off

| Symptom | Fix |
|---|---|
| Page says *HQ is running. The web UI arrives in Phase 2.* | Caddy still has the old config: `docker compose restart caddy`. |
| Header says **NO ACCESS** | Wrong token in Settings. Copy `HQ_API_TOKEN` again (no spaces). |
| Header says **OFFLINE** and keeps retrying | `make ps`; if web isn't up, `make logs-web`. |
| *HQ is not answering* toast | The agent is down or still starting: `make logs`. |

## Rolling back

```bash
git checkout a6a6188 -- compose.yaml infra/caddy/Caddyfile
docker compose up -d --remove-orphans && docker compose restart caddy
```

That puts the routes back to Phase 1; nothing in `data/` needs undoing.
