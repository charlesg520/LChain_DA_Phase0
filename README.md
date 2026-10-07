# HQ: a self-hosted DeepAgent

A coding-first [LangChain DeepAgent](https://github.com/langchain-ai/deepagents) that runs entirely on your own infrastructure. No LangSmith Deployments, no paid sandboxes, no per-seat fees.

| Layer | What runs it |
|---|---|
| Agent harness | `deepagents==0.7.19` (pinned): orchestrator + `coder`, `reviewer`, `researcher` subagents |
| Server | [Aegra](https://github.com/aegra/aegra) `0.6.0`: Agent Protocol API, Postgres checkpoints, streaming, human-in-the-loop |
| Code execution | Our own Docker sandbox backend: one hardened container per project, home machine first, VPS fallback |
| Memory | Plain Markdown in `data/memories/` (`AGENTS.md` is loaded into every conversation) |
| Skills | `skills/<category>/<name>/SKILL.md`, bind-mounted, so skill upgrades show up in `git diff` |
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
    models.py          provider:model routing with local-model fallback
    tools.py           web_search (SearXNG), fetch_url (SSRF-guarded)
    ops.py             /ops API for the web UI
    security.py        owner bearer-token check
  auth.py              Aegra auth handler
sandbox/Dockerfile     the image agent code runs in
skills/                the agent's playbooks
infra/                 Caddy, SearXNG, home-node compose
compose.yaml           the whole stack
```

## What the agent sees

```
/workspace/   per-project Linux sandbox (Python 3.12, Node 22, git, uv, data stack)
/memories/    long-term memory (writes allowed)
/skills/      playbooks (writes pause for your approval)
```

Pick the project per run with `config={"configurable": {"project": "my-app"}}`. Each project gets its own container and persistent workspace volume.

## Deploy to the VPS

On a fresh Ubuntu VPS with Docker installed:

```bash
git clone <your-repo> hq && cd hq
make init                  # creates .env, generates API token + DB password + secrets
nano .env                  # add ANTHROPIC_API_KEY, set HQ_DOMAIN (DNS A record -> VPS IP)
make sandbox-image         # build the sandbox image on this host
make up                    # postgres, agent, docker-proxy, searxng, caddy
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

## Security model

- **API:** every Agent Protocol and `/ops` route needs `Authorization: Bearer <HQ_API_TOKEN>`. If the token is missing or shorter than 32 characters, every protected route answers 503 (fails closed, never open). API docs are not exposed through Caddy.
- **Sandboxes:** read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, uid 1000, memory/CPU/PID caps, and their own network with no route to Postgres, the Docker proxy or the agent. The backend only reuses containers it labelled itself.
- **Docker access:** the agent never gets the raw Docker socket. It talks to a socket proxy that only exposes the endpoints the sandbox backend needs, on a network with no internet access.
- **fetch_url:** refuses private, loopback, link-local and metadata addresses, checking every redirect hop before following it.
- **Skills:** any write under `/skills/` pauses for human approval.
- **Trading:** the agent has no broker, exchange or webhook credentials, and its prompt forbids trading. Strategies are deployed by you on TradingView.

## Tests

```bash
make test          # unit tests, no Docker needed
make test-docker   # sandbox integration tests (needs Docker + sandbox image)
```

## Upstream issues found while building (and how they're handled)

- **aegra-api 0.6.0 is missing a dependency:** it imports SQLAlchemy asyncio without declaring `greenlet`, so the server crashes at startup. Pinned `greenlet` in `agent/pyproject.toml`.
- **Aegra's `enable_custom_route_auth` has no effect** in 0.6.0 (it adds the dependency after FastAPI has compiled the routes). The `/ops` router enforces the token itself; a test checks every ops route rejects unauthenticated calls.
- **No cron API in aegra-api 0.6.0** (its capability flag reports `crons: false`, despite the package description). Phase 4 adds HQ's own scheduler to the ops API.
- **deepagents 0.7 removed backend factories**, so the sandbox backend picks the project's container at call time from the run config.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Stack, agent core, Docker sandbox, auth, tests | done |
| 1 | Git credentials per repo, MCP tools, skill-upgrade flow, idle sandbox reaper | next |
| 2 | Web UI v1: chat, streaming, subagent tree, approvals inbox, file workbench | |
| 3 | Markets team (analyst, quant, risk), data connectors, Pine Script v6 output, TradingView-parity backtests, paper trading, readiness pipeline | |
| 4 | Scheduler, cost/token tracking, backups, VPS hardening | |
| 5 | UI v2: markets cockpit, skill studio, dashboards | |
| 6 | Evals, security review, sandbox escape tests | |
