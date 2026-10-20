"""Graph entry point. Aegra loads `make_graph` (see aegra.json) and injects the
Postgres checkpointer and store itself, so none are configured here."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

from deepagents import FilesystemPermission, create_deep_agent
from langchain.agents.middleware import AgentMiddleware, TodoListMiddleware
from langchain_core.language_models import BaseChatModel
from langgraph.graph.state import CompiledStateGraph

from hq_agent import mcp, prompts
from hq_agent.backends import MEMORIES_ROUTE, SKILLS_ROUTE, build_backend, build_sandbox
from hq_agent.config import Settings, load_settings
from hq_agent.middleware import PushBeforeDoneMiddleware
from hq_agent.models import resolve_role
from hq_agent.skills_store import SkillStore
from hq_agent.subagents import build_subagents
from hq_agent.tools import RESEARCH_TOOLS, make_skill_tools

logger = logging.getLogger(__name__)

MEMORY_FILE = f"{MEMORIES_ROUTE}AGENTS.md"
_SEED_MEMORY = Path(__file__).resolve().parent / "seed" / "AGENTS.md"


def _seed_memory(settings: Settings) -> None:
    """Create /memories/AGENTS.md on first boot; never overwrite what the agent learned."""
    target = settings.memories_dir / "AGENTS.md"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_SEED_MEMORY, target)
        logger.info("seeded %s", target)


def skill_sources(settings: Settings) -> list[str]:
    """Each top-level folder in /skills/ is a category (coding/, markets/, ...)."""
    if not settings.skills_dir.exists():
        return []
    return [f"{SKILLS_ROUTE}{d.name}/" for d in sorted(settings.skills_dir.iterdir()) if d.is_dir() and not d.name.startswith(".")]


def skill_store(settings: Settings) -> SkillStore:
    return SkillStore(settings.skills_dir, settings.skill_store_dir, settings.builtin_skills_dir)


def build_agent(
    settings: Settings | None = None,
    *,
    model_override: BaseChatModel | None = None,
    mcp_tools: mcp.MCPToolset | None = None,
) -> CompiledStateGraph:
    settings = settings or load_settings()
    sandbox = build_sandbox(settings)
    backend = build_backend(settings, sandbox)
    _seed_memory(settings)
    store = skill_store(settings)
    synced = store.sync_builtin()
    if any(synced.values()):
        logger.info("skills synced from repo: %s", synced)
    toolset = mcp_tools or mcp.MCPToolset()

    if model_override is not None:
        model, middleware = model_override, []
    else:
        model, middleware = resolve_role(settings.models.orchestrator, settings.models)

    extra: list[AgentMiddleware] = list(middleware)
    if settings.enable_todos:
        extra.append(TodoListMiddleware())
    if sandbox is not None and settings.push_reminder:
        extra.append(PushBeforeDoneMiddleware(sandbox))

    # /skills/ is read-only to every agent: changes go through propose_skill and
    # C's approval (or straight in, versioned, when REQUIRE_SKILL_APPROVAL=false).
    # Memory writes stay free: /memories/ is plain files you can review.
    permissions = [FilesystemPermission(operations=["write"], paths=[f"{SKILLS_ROUTE}**"], mode="deny")]

    return create_deep_agent(
        model=model,
        tools=[
            *RESEARCH_TOOLS,
            *make_skill_tools(store, require_approval=settings.require_skill_approval, proposed_by="orchestrator"),
            *toolset.tools_for("orchestrator"),
        ],
        system_prompt=prompts.ORCHESTRATOR,
        middleware=extra,
        subagents=build_subagents(settings, backend, model_override, sandbox=sandbox, store=store, mcp_tools=toolset),
        skills=skill_sources(settings) or None,
        memory=[MEMORY_FILE],
        permissions=permissions,
        interrupt_on=approvals(settings, toolset, "orchestrator") or None,
        backend=backend,
        name="hq",
    )


def approvals(settings: Settings, toolset: mcp.MCPToolset, role: str) -> dict[str, bool]:
    """Tools that pause for C's approval for one agent: HQ_REQUIRE_APPROVAL plus MCP `approve` lists."""
    return {**{name: True for name in settings.require_approval}, **toolset.interrupt_on(role)}


_FS_TOOLS = {"ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute", "delete"}
_READ_ONLY = {"ls", "read_file", "glob", "grep", "execute"}
_SUBAGENTS = ("coder", "reviewer", "researcher", "general-purpose")


def tool_registry(settings: Settings, toolset: mcp.MCPToolset) -> list[dict[str, Any]]:
    """Every tool any agent can call, with its JSON schema and which agents get it (for the UI)."""
    from langchain_core.utils.function_calling import convert_to_openai_tool

    graph = build_agent(settings, mcp_tools=toolset)
    by_name: dict[str, Any] = dict(getattr(graph.nodes["tools"].bound, "tools_by_name", {}))
    for role in _SUBAGENTS:
        for tool in toolset.tools_for(role if role != "general-purpose" else "orchestrator"):
            by_name.setdefault(tool.name, tool)
    mcp_roles: dict[str, set[str]] = {}
    for role in ("orchestrator", "coder", "reviewer", "researcher"):
        for tool in toolset.tools_for(role):
            mcp_roles.setdefault(tool.name, set()).add(role)
            if role == "orchestrator":
                mcp_roles[tool.name].add("general-purpose")  # inherits the orchestrator's tools

    def agents_for(name: str) -> list[str]:
        if name in mcp_roles:
            roles = mcp_roles[name]
        elif name in _FS_TOOLS:
            roles = {"orchestrator", "coder", "researcher", "general-purpose"} | ({"reviewer"} if name in _READ_ONLY else set())
        elif name in ("web_search", "fetch_url"):
            roles = {"orchestrator", "coder", "researcher", "general-purpose"}
        elif name == "propose_skill":
            roles = {"orchestrator", "coder", "general-purpose"}
        else:
            roles = {"orchestrator"}
        order = ["orchestrator", *_SUBAGENTS]
        return [r for r in order if r in roles]

    def source_for(name: str) -> str:
        if name in mcp_roles or any(name in s.tools for s in toolset.status.values()):
            server = next((n for n, st in toolset.status.items() if name in st.tools), "mcp")
            return f"mcp:{server}"
        if name in _FS_TOOLS or name in ("task", "write_todos"):
            return "harness"
        return "hq"

    approval_any = set(settings.require_approval) | {n for r in ("orchestrator", "coder", "reviewer", "researcher") for n in toolset.interrupt_on(r)}
    out = []
    for name, tool in sorted(by_name.items(), key=lambda kv: (source_for(kv[0]) != "harness", source_for(kv[0]), kv[0])):
        try:
            params = convert_to_openai_tool(tool)["function"].get("parameters", {})
        except Exception:  # noqa: BLE001 - a schema we can't render shouldn't hide the tool
            params = {}
        description = (tool.description or "").strip()
        out.append(
            {
                "name": name,
                "description": description.split("\n\n")[0][:600],
                "schema": json.dumps(params, indent=2),
                "agents": agents_for(name),
                "source": source_for(name),
                "approval": name in approval_any,
            }
        )
    return out


async def make_graph() -> CompiledStateGraph:
    """Async factory Aegra awaits once at startup. MCP servers are connected here."""
    settings = load_settings()
    mcp.seed_config(settings.mcp_config, settings.mcp_seed)
    toolset = await mcp.ensure_loaded(settings.mcp_config)
    return build_agent(settings, mcp_tools=toolset)
