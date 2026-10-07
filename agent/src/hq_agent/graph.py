"""Graph entry point. Aegra loads `make_graph` (see aegra.json) and injects the
Postgres checkpointer and store itself, so none are configured here."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

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
        interrupt_on=toolset.interrupt_on("orchestrator") or None,
        backend=backend,
        name="hq",
    )


async def make_graph() -> CompiledStateGraph:
    """Async factory Aegra awaits once at startup. MCP servers are connected here."""
    settings = load_settings()
    toolset = await mcp.ensure_loaded(settings.mcp_config)
    return build_agent(settings, mcp_tools=toolset)
