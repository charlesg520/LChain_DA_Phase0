# HQ: a self-hosted DeepAgent

A coding-first [LangChain DeepAgent](https://github.com/langchain-ai/deepagents) that runs entirely on your own infrastructure. No LangSmith Deployments, no paid sandboxes, no per-seat fees.

| Layer | What runs it |
|---|---|
| Agent harness | `deepagents==0.7.19` (pinned): orchestrator + `coder`, `reviewer`, `researcher` subagents |
| Server | [Aegra](https://github.com/aegra/aegra) `0.6.0`: Agent Protocol API, Postgres checkpoints, streaming, human-in-the-loop |
| Code execution | Our own Docker sandbox backend: one hardened container per project, home machine first, VPS fallback |
| Memory | Plain Markdown in `data/memories/` (`AGENTS.md` is loaded into every conversation) |
| Skills | `SKILL.md` folders. The agent proposes upgrades; you approve; every version is kept and restorable |
| Git | Our own git gateway: sandboxes clone and push with no credential inside them; only `hq/*` branches |
| Tools | MCP servers from `config/mcp.json`, allowlisted per agent |
| Web search | Self-hosted SearXNG (no API bill) |
| Tracing | Arize Phoenix (optional profile) |
| Edge | Caddy with automatic HTTPS |

## Layout

```
agent/                 Python package, Aegra config, tests
  src/hq_agent/
    graph.py           builds the agent (entry point: make_graph)
    subagents.py       coder / reviewer / researcher
    backends/          Docker sandbox + storage routing
    git_gateway.py     credential-holding git proxy for sandboxes (its own container)
    reaper.py          stops idle sandboxes, removes long-stopped ones
    mcp.py             MCP servers from config/mcp.json, per-agent allowlists
    skills_store.py    skill proposals, approvals, versions, rollback
    middleware.py      push-before-done check
    models.py          provider:model routing with local-model fallback
    tools.py           web_search (SearXNG), fetch_url (SSRF-guarded), propose_skill
    ops.py             /ops API for the web UI
    security.py        owner bearer-token check
  auth.py              Aegra auth handler
sandbox/Dockerfile     the image agent code runs in
skills/                built-in playbooks (copied into data/skills/ on startup)
config/mcp.json        MCP servers and which agent gets which tools
secrets/               git-gateway.env (GitHub token; only the gateway reads it)
infra/                 Caddy, SearXNG, home-node compose
compose.yaml           the whole stack
```

## What the agent sees

```
/workspace/   per-project Linux sandbox (Python 3.12, Node 22, git, uv, data stack)
/memories/    long-term memory (writes allowed)
/skills/      playbooks (read-only; changes go through propose_skill -> your review)
```

Pick the project per run with `config={"configurable": {"project": "my-app"}}`. Each project gets its own container and persistent workspace volume.

## Deploy to the VPS

On a fresh Ubuntu VPS with Docker installed:

```bash
git clone <your-repo> hq && cd hq
make init                  # creates .env + secrets/git-gateway.env, generates all secrets
nano .env                  # model key, HQ_DOMAIN (DNS A record -> VPS IP), optional GITHUB_MCP_TOKEN
nano secrets/git-gateway.env   # GitHub token + which repos HQ may push to
make sandbox-image         # build the sandbox image on this host
make up                    # postgres, agent, git-gateway, docker-proxy, searxng, caddy
make smoke                 # calls /api/ops/info through Caddy with your token
```

Add tracing with `make up PROFILES=obs` and set `OTEL_TARGETS=PHOENIX` in `.env`. Phoenix listens on `127.0.0.1:6006` only; reach it through an SSH tunnel or Tailscale.

### Talk to it

```python
from langgraph_sdk import get_client

client = get_client(url="https://hq.example.com/api", headers={"Authorization": "Bearer <HQ_API_TOKEN>"})
thread = await client.threads.create()
async for chunk in client.runs.stream(
    thread["thread_id"], "hq",
    input={"messages": [{"role": "user", "content": "Clone github.com/me/app and make the tests pass"}]},
    config={"configurable": {"project": "app"}},
    stream_mode=["messages-tuple", "updates"],
):
    print(chunk)
```

### Home node (optional, recommended)

Runs heavy sandboxes on your own hardware over Tailscale, with the VPS as fallback. See `infra/home-node/compose.yaml`. Then in the VPS `.env`:

```
SANDBOX_DOCKER_HOSTS=tcp://100.x.y.z:2375,tcp://docker-proxy:2375
OLLAMA_BASE_URL=http://100.x.y.z:11434      # optional local models
```

The backend probes hosts in order (5s timeout) and re-checks every 60s, so work moves back home when your machine wakes up. Workspaces are per host; use git to move work between them.

## Git: how the agent pushes without holding a token

```
sandbox ── plain `git clone/push https://github.com/...` ──► git-gateway ── + token ──► GitHub
          (GIT_CONFIG_* env rewrites the URL)              (checks repo + branch, logs it)
```

- The GitHub token lives in `secrets/git-gateway.env` and only the `git-gateway` container reads it. Nothing in a sandbox can see it: env, `/proc`, git config, and hooks all come up empty, and a test checks this.
- **Pushes:** only to repos in `GIT_GATEWAY_ALLOWED_REPOS`, and only to branches under `hq/`. A push to `main` is refused before anything reaches GitHub. The agent sees `! [remote rejected] main (HQ only pushes branches under hq/)`.
- **Clones:** allowlisted repos use the token, so private repos work. Any other public repo is cloned anonymously.
- **Audit:** every request is logged to `data/audit/git-gateway.jsonl`; see `GET /ops/git/audit` or `make logs-gateway`.
- **Push before done:** when the coder (or orchestrator) finishes with commits that exist on no remote, it gets one reminder to push or to say why not.
- **Token:** use a fine-grained token with *Only select repositories*, Contents read/write. For belt and braces, add a ruleset on `main` in each repo (require PRs, no bypass). Then even a leaked token can't touch `main`.
- **Home-machine sandboxes** reach the gateway over Tailscale. Set `GIT_GATEWAY_BIND=<VPS Tailscale IP>` and `GIT_GATEWAY_URL_OVERRIDES=tcp://<home IP>:2375=http://<VPS Tailscale IP>:8081`.

## Skills: how the agent upgrades itself

1. The agent learns something reusable and calls `propose_skill` with the full new `SKILL.md` and its reason. Bad proposals (no frontmatter, name mismatch, hidden or binary files, too big) come straight back with a fixable error.
2. You review in the ops API (the UI in Phase 2): `GET /ops/skill-proposals`, `GET /ops/skill-proposals/{id}` shows the diff, then `POST .../approve` (optionally with your edits) or `.../reject`.
3. Every change is a version: `GET /ops/skills/{category}/{name}` shows history, and `POST .../rollback {"version": N}` restores one. A rollback is itself a new version, so history is never rewritten.

Skills shipped in `skills/` are copied into `data/skills/` on startup. If you edit one in the repo later, the change flows in automatically, unless an approved proposal changed it, in which case it's flagged (`builtin_update_available`) rather than overwritten; `POST .../adopt-builtin` takes the repo version. Set `REQUIRE_SKILL_APPROVAL=false` to auto-approve (still versioned).

## MCP tools

Servers are listed in `config/mcp.json`, with secrets as `${VAR}` from `.env`. Each server says which agent gets which tools (glob patterns on the server's tool names). Anything not listed is never offered, and `approve` lists tools that pause for your OK. GitHub's hosted MCP server ships configured and switches on when you set `GITHUB_MCP_TOKEN`. A server that's down is reported in `GET /ops/mcp` and skipped; the agent still starts, and a failure mid-run comes back to the model as an error. Restart the agent after editing (`make restart`).

## Sandbox lifecycle

The idle reaper runs inside the agent server and sweeps every Docker host, including the VPS while you're working from home:

| State | After | Action |
|---|---|---|
| Running, no command/upload/download | `SANDBOX_IDLE_STOP_MINUTES` (30) | stopped |
| Stopped | `SANDBOX_IDLE_REMOVE_HOURS` (24) | container removed; recreated from the current image on next use |
| Command still running | never | left alone, however long it takes |
| Pinned (`POST /ops/sandboxes/{project}/pin {"hours": 6}`) | until the pin expires | left alone |

`/workspace` volumes are never deleted by the reaper (only by `DELETE /ops/sandboxes/{project}?workspace=true`). Background processes started with `nohup` die when a sandbox is stopped, so pin the project if you need one running. Sandboxes are also rebuilt automatically when their settings or the sandbox image change, keeping the workspace. `GET /ops/sandboxes` shows every sandbox's idle time; `POST /ops/sandboxes/reap` previews a sweep (dry run by default).

## Security model

- **API:** every Agent Protocol and `/ops` route needs `Authorization: Bearer <HQ_API_TOKEN>`. If the token is missing or shorter than 32 characters, every protected route answers 503 (fails closed, never open). API docs are not exposed through Caddy.
- **Sandboxes:** read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, uid 1000, memory/CPU/PID caps, and their own network with no route to Postgres, the Docker proxy or the agent. The backend only reuses containers it labelled itself.
- **Docker access:** the agent never gets the raw Docker socket. It talks to a socket proxy that only exposes the endpoints the sandbox backend needs, on a network with no internet access.
- **fetch_url:** refuses private, loopback, link-local and metadata addresses, checking every redirect hop before following it.
- **Git:** sandboxes never hold a credential; the gateway enforces repo allowlist + `hq/*`-only pushes and logs everything. Only the gateway container can read the GitHub token.
- **Skills:** `/skills/` is read-only to every agent; changes are proposals you approve, and every version is kept.
- **MCP:** per-agent tool allowlists; MCP output is treated as untrusted input (it can carry prompt injections), so the reviewer and researcher get read-only tools only.
- **Trading:** the agent has no broker, exchange or webhook credentials, and its prompt forbids trading. Strategies are deployed by you on TradingView.

## Tests

```bash
make test          # unit tests, no Docker needed (incl. a real git client through the gateway, a real MCP server)
make test-docker   # sandbox integration tests (needs Docker + sandbox image)
make test-all      # everything
```

## Upstream issues found while building (and how they're handled)

- **aegra-api 0.6.0 is missing a dependency:** it imports SQLAlchemy asyncio without declaring `greenlet`, so the server crashes at startup. Pinned `greenlet` in `agent/pyproject.toml`.
- **Aegra's `enable_custom_route_auth` has no effect** in 0.6.0 (it adds the dependency after FastAPI has compiled the routes). The `/ops` router enforces the token itself; a test checks every ops route rejects unauthenticated calls.
- **No cron API in aegra-api 0.6.0** (its capability flag reports `crons: false`, despite the package description). Phase 4 adds HQ's own scheduler to the ops API.
- **deepagents 0.7 removed backend factories**, so the sandbox backend picks the project's container at call time from the run config.
- **Aegra builds graphs lazily** (on the first run), so skill sync and MCP connections also start from the ops app's lifespan; otherwise the UI would show nothing until the first chat.
- **deepagents caches each thread's skill list** in state. New threads see approved skills immediately; to refresh an open thread, send its next run with input `{"skills_metadata": null}`.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Stack, agent core, Docker sandbox, auth, tests | done |
| 1 | Git gateway, MCP tools, skill-upgrade flow, idle sandbox reaper, repo tidy | done |
| 2 | Web UI v1: chat, streaming, subagent tree, approvals inbox (skill proposals, MCP approvals), file workbench, sandbox panel | next |
| 3 | Markets team (analyst, quant, risk), data connectors, Pine Script v6 output, TradingView-parity backtests, paper trading, readiness pipeline | |
| 4 | Scheduler, cost/token tracking, backups, VPS hardening | |
| 5 | UI v2: markets cockpit, skill studio, dashboards | |
| 6 | Evals, security review, sandbox escape tests | |
