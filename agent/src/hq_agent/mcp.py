"""MCP tools, loaded from one JSON config file (HQ_MCP_CONFIG, default config/mcp.json).

    {
      "servers": {
        "github": {
          "transport": "streamable_http",            // or "sse", "stdio"
          "url": "https://api.githubcopilot.com/mcp/",
          "headers": {"Authorization": "Bearer ${GITHUB_MCP_TOKEN}"},
          "requires_env": ["GITHUB_MCP_TOKEN"],      // skipped (not an error) until these are set
          "enabled": true,
          "timeout_seconds": 30,
          "agents": {                                // who gets which tools; unlisted agents get none
            "orchestrator": ["get_*", "list_*", "search_*"],
            "coder": ["get_*", "list_*", "search_*", "create_pull_request"]
          },
          "approve": ["create_pull_request"]         // pause for C's approval before these run
        }
      }
    }

- Secrets stay in `.env`: `${VAR}` and `${VAR:-default}` are expanded at load time.
- Patterns match the server's own tool names; the agent sees them prefixed with
  the server name (`github_create_pull_request`) so two servers can't collide.
- A server that fails to load is reported in `/ops/mcp` and skipped; the agent
  still starts. Tool calls that fail mid-run come back to the model as errors
  instead of crashing the run.
- Tool output from MCP servers is untrusted input (a GitHub issue body can carry
  a prompt injection), which is one more reason the allowlists are per agent.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import shlex
import shutil
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)

AGENT_ROLES = ("orchestrator", "coder", "reviewer", "researcher")
_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
_TRANSPORTS = {"streamable_http", "sse", "stdio"}
_CONNECTION_KEYS = {
    "streamable_http": ("url", "headers", "timeout", "sse_read_timeout"),
    "sse": ("url", "headers", "timeout", "sse_read_timeout"),
    "stdio": ("command", "args", "env", "cwd"),
}


class MCPConfigError(ValueError):
    pass


def expand_env(value: Any, missing: set[str]) -> Any:
    """Expand ${VAR} / ${VAR:-default} in every string, recording unset variables."""
    if isinstance(value, str):

        def repl(match: re.Match[str]) -> str:
            name, default = match.group(1), match.group(2)
            resolved = os.environ.get(name, "")
            if not resolved and default is None:
                missing.add(name)
            return resolved or (default or "")

        return _ENV_REF.sub(repl, value)
    if isinstance(value, dict):
        return {k: expand_env(v, missing) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_env(v, missing) for v in value]
    return value


@dataclass
class ServerSpec:
    name: str
    connection: dict[str, Any]
    agents: dict[str, list[str]]
    approve: list[str]
    timeout_s: float
    enabled: bool
    missing_env: list[str]

    def patterns_for(self, role: str) -> list[str]:
        return self.agents.get(role, [])


def parse_config(raw: dict[str, Any]) -> list[ServerSpec]:
    servers = raw.get("servers")
    if not isinstance(servers, dict):
        raise MCPConfigError('top level must be {"servers": {...}}')
    specs = []
    for name, cfg in servers.items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", name):
            raise MCPConfigError(f"server name {name!r}: use lowercase letters, digits, - and _")
        if not isinstance(cfg, dict):
            raise MCPConfigError(f"{name}: config must be an object")
        transport = cfg.get("transport", "streamable_http")
        if transport not in _TRANSPORTS:
            raise MCPConfigError(f"{name}: transport must be one of {sorted(_TRANSPORTS)}")
        agents = cfg.get("agents", {})
        unknown = set(agents) - set(AGENT_ROLES)
        if unknown:
            raise MCPConfigError(f"{name}: unknown agents {sorted(unknown)}; expected {list(AGENT_ROLES)}")
        missing: set[str] = set()
        expanded = expand_env(cfg, missing)
        required = [v for v in cfg.get("requires_env", []) if not os.environ.get(v, "").strip()]
        connection = {"transport": transport, **{k: expanded[k] for k in _CONNECTION_KEYS[transport] if k in expanded}}
        if transport != "stdio" and not connection.get("url"):
            raise MCPConfigError(f"{name}: url is required for {transport}")
        if transport == "stdio" and not connection.get("command"):
            raise MCPConfigError(f"{name}: command is required for stdio")
        specs.append(
            ServerSpec(
                name=name,
                connection=connection,
                agents={role: list(patterns) for role, patterns in agents.items()},
                approve=list(cfg.get("approve", [])),
                timeout_s=float(cfg.get("timeout_seconds", 30)),
                enabled=bool(cfg.get("enabled", True)),
                missing_env=sorted(required),
            )
        )
    return specs


@dataclass
class ServerStatus:
    status: str  # loaded | error | disabled | waiting_for_env
    tools: list[str] = field(default_factory=list)
    loaded_at: float | None = None
    error: str | None = None
    calls: int = 0
    errors: int = 0
    agents: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class MCPToolset:
    """Loaded MCP tools, split by agent role, plus what to report in /ops/mcp."""

    by_role: dict[str, list[BaseTool]] = field(default_factory=lambda: defaultdict(list))
    approvals: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))  # role -> prefixed tool names
    status: dict[str, ServerStatus] = field(default_factory=dict)
    config_path: str | None = None
    loaded_at: float = field(default_factory=time.time)

    def tools_for(self, role: str) -> list[BaseTool]:
        return list(self.by_role.get(role, []))

    def interrupt_on(self, role: str) -> dict[str, bool]:
        return {name: True for name in sorted(self.approvals.get(role, set()))}

    def as_dict(self) -> dict[str, Any]:
        return {
            "config": self.config_path,
            "loaded_at": self.loaded_at,
            "servers": {name: s.__dict__ for name, s in self.status.items()},
        }


def _matches(tool_name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(tool_name, p) for p in patterns)


def _interceptor(status: ServerStatus) -> Any:
    """Count calls and turn transport failures into tool errors the model can read."""
    from mcp.types import CallToolResult, TextContent

    async def intercept(request: Any, handler: Any) -> Any:
        status.calls += 1
        try:
            return await handler(request)
        except Exception as exc:  # noqa: BLE001
            status.errors += 1
            logger.warning("MCP %s.%s failed: %s", request.server_name, request.name, exc)
            return CallToolResult(
                content=[TextContent(type="text", text=f"MCP server '{request.server_name}' failed: {exc}")],
                isError=True,
            )

    return intercept


async def _load_server(spec: ServerSpec, toolset: MCPToolset) -> None:
    from langchain_mcp_adapters.tools import load_mcp_tools

    status = ServerStatus(status="loaded")
    toolset.status[spec.name] = status
    if not spec.enabled:
        status.status = "disabled"
        return
    if spec.missing_env:
        status.status = "waiting_for_env"
        status.error = "set " + ", ".join(spec.missing_env) + " in .env"
        return
    try:
        tools = await asyncio.wait_for(
            load_mcp_tools(
                None,
                connection=spec.connection,  # type: ignore[arg-type]
                server_name=spec.name,
                tool_name_prefix=True,
                tool_interceptors=[_interceptor(status)],
            ),
            timeout=spec.timeout_s,
        )
    except Exception as exc:  # noqa: BLE001 - one bad server must not stop the agent from starting
        status.status = "error"
        status.error = f"{type(exc).__name__}: {exc}"
        logger.warning("MCP server %s failed to load: %s", spec.name, status.error)
        return

    prefix = f"{spec.name}_"
    status.loaded_at = time.time()
    status.tools = sorted(t.name for t in tools)
    for tool in tools:
        bare = tool.name[len(prefix):] if tool.name.startswith(prefix) else tool.name
        for role in AGENT_ROLES:
            if _matches(bare, spec.patterns_for(role)):
                toolset.by_role[role].append(tool)
                status.agents.setdefault(role, []).append(tool.name)
                if _matches(bare, spec.approve):
                    toolset.approvals[role].add(tool.name)
    logger.info("MCP server %s: %d tools (%s)", spec.name, len(tools), {r: len(v) for r, v in status.agents.items()})


async def load_mcp_tools_from_config(path: Path | None) -> MCPToolset:
    toolset = MCPToolset(config_path=str(path) if path else None)
    if path is None or not path.exists():
        return toolset
    try:
        specs = parse_config(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, MCPConfigError) as exc:
        toolset.status["_config"] = ServerStatus(status="error", error=str(exc))
        logger.error("MCP config %s is invalid: %s", path, exc)
        return toolset
    await asyncio.gather(*(_load_server(spec, toolset) for spec in specs))
    return toolset


# ------------------------------------------------------------ editing (UI)
_EDIT_LOCK = threading.Lock()
_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")


def seed_config(path: Path | None, seed: Path | None) -> None:
    """First start: copy the repo's config/mcp.json to the writable location."""
    if path is None or path.exists() or seed is None or not seed.exists() or seed.resolve() == path.resolve():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(seed, path)
    logger.info("seeded MCP config %s from %s", path, seed)


def read_raw(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"servers": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("servers"), dict):
        data["servers"] = {}
    return data


def _write_raw(path: Path, data: dict[str, Any]) -> None:
    parse_config(data)  # never write a config the loader would reject
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def server_from_form(form: dict[str, Any], *, allow_stdio: bool) -> tuple[str, dict[str, Any]]:
    """Validate a server sent by the UI and turn it into a config entry."""
    name = str(form.get("name") or form.get("id") or "").strip().lower()
    if not _NAME.fullmatch(name):
        raise MCPConfigError("name: use 1-32 lowercase letters, digits, - and _")
    transport = {"http": "streamable_http", "streamable_http": "streamable_http", "sse": "sse", "stdio": "stdio"}.get(str(form.get("transport", "http")))
    if transport is None:
        raise MCPConfigError("transport must be http, sse or stdio")
    cfg: dict[str, Any] = {"transport": transport}
    if transport == "stdio":
        if not allow_stdio:
            raise MCPConfigError(
                "stdio servers run programs inside the agent container, so adding them from the UI is off. "
                "Use an http/sse server, or set HQ_ALLOW_STDIO_MCP=true in .env and restart."
            )
        parts = shlex.split(str(form.get("command") or ""))
        if not parts:
            raise MCPConfigError("command is required for stdio")
        cfg["command"], cfg["args"] = parts[0], parts[1:]
    else:
        url = str(form.get("url") or "").strip()
        if not re.match(r"^https?://", url):
            raise MCPConfigError("url must start with http:// or https://")
        cfg["url"] = url
    for key in ("env", "headers"):
        value = form.get(key)
        if value:
            if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
                raise MCPConfigError(f"{key} must map strings to strings")
            cfg[key] = value
    agents = form.get("agents") or {}
    if not isinstance(agents, dict):
        raise MCPConfigError("agents must map agent names to lists of tool patterns")
    cfg["agents"] = {role: [str(p) for p in pats] for role, pats in agents.items() if pats}
    if not cfg["agents"]:
        cfg["agents"] = {"orchestrator": ["*"]}
    approve = form.get("approve") or []
    if approve:
        cfg["approve"] = [str(p) for p in approve]
    # ${VAR} references without a default must be set in .env; until then the server waits instead of erroring.
    refs = {m.group(1) for m in _ENV_REF.finditer(json.dumps(cfg)) if m.group(2) is None}
    if refs:
        cfg["requires_env"] = sorted(refs)
    cfg["enabled"] = bool(form.get("enabled", True))
    return name, cfg


def upsert_server(path: Path, name: str, cfg: dict[str, Any]) -> None:
    with _EDIT_LOCK:
        data = read_raw(path)
        data["servers"][name] = cfg
        _write_raw(path, data)


def remove_server(path: Path, name: str) -> bool:
    with _EDIT_LOCK:
        data = read_raw(path)
        if name not in data["servers"]:
            return False
        del data["servers"][name]
        _write_raw(path, data)
        return True


def set_server_enabled(path: Path, name: str, enabled: bool) -> bool:
    with _EDIT_LOCK:
        data = read_raw(path)
        if name not in data["servers"]:
            return False
        data["servers"][name]["enabled"] = enabled
        _write_raw(path, data)
        return True


def _mask(values: dict[str, str] | None) -> dict[str, str] | None:
    """Show ${VAR} references as-is, hide literal secrets."""
    if not values:
        return None
    out = {}
    for k, v in values.items():
        out[k] = v if _ENV_REF.search(v) else (("•" * 6 + v[-4:]) if len(v) > 8 else "••••")
    return out


def describe(path: Path | None, toolset: MCPToolset) -> list[dict[str, Any]]:
    """Servers as the UI shows them: config + live status, secrets masked."""
    raw = read_raw(path)["servers"] if path else {}
    out = []
    for name in sorted(set(raw) | {n for n in toolset.status if not n.startswith("_")}):
        cfg = raw.get(name, {})
        st = toolset.status.get(name)
        status = {"loaded": "connected", "error": "error", "disabled": "disconnected", "waiting_for_env": "error", "connecting": "connecting"}.get(
            st.status if st else "", "disconnected" if cfg.get("enabled") is False else "connecting"
        )
        transport = {"streamable_http": "http"}.get(cfg.get("transport", "streamable_http"), cfg.get("transport", "http"))
        command = " ".join([cfg["command"], *cfg.get("args", [])]) if cfg.get("command") else None
        out.append(
            {
                "id": name,
                "name": name,
                "transport": transport,
                "command": command,
                "url": cfg.get("url"),
                "env": _mask(cfg.get("env")),
                "headers": _mask(cfg.get("headers")),
                "agents": cfg.get("agents") or {},
                "status": status,
                "tools": st.tools if st else [],
                "error": st.error if st and st.status in ("error", "waiting_for_env") else None,
                "started_at": int(st.loaded_at * 1000) if st and st.status == "loaded" and st.loaded_at else None,
                "calls": st.calls if st else 0,
            }
        )
    return out


def invalidate_graph() -> None:
    """Make Aegra rebuild the agent graph on its next run (picks up new MCP tools and skill categories)."""
    try:
        from aegra_api.services.langgraph_service import get_langgraph_service

        get_langgraph_service().invalidate_cache()
    except Exception:  # noqa: BLE001 - outside Aegra (tests, scripts) there is no cache to clear
        logger.debug("graph cache invalidation skipped", exc_info=True)


async def reload(path: Path | None) -> MCPToolset:
    toolset = await load_mcp_tools_from_config(path)
    set_current(toolset)
    invalidate_graph()
    return toolset


_CURRENT = MCPToolset()
_LOADED = False


def set_current(toolset: MCPToolset) -> None:
    global _CURRENT, _LOADED
    _CURRENT, _LOADED = toolset, True


def current() -> MCPToolset:
    return _CURRENT


async def ensure_loaded(path: Path | None) -> MCPToolset:
    """Load once per process and reuse (server startup and graph build share it).

    Reloads if the config path changed or a server failed last time, so a server
    that was down at boot gets another chance when the graph is first built.
    """
    toolset = current()
    fresh = _LOADED and toolset.config_path == (str(path) if path else None)
    if fresh and not any(s.status == "error" for s in toolset.status.values()):
        return toolset
    toolset = await load_mcp_tools_from_config(path)
    set_current(toolset)
    return toolset
