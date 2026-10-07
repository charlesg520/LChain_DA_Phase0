"""Subagent roster. Phase 3 adds the markets team (analyst, quant, risk)."""

from __future__ import annotations

from typing import Any

from deepagents import FilesystemMiddleware, SubAgent
from deepagents.backends.protocol import BackendProtocol
from langchain_core.language_models import BaseChatModel

from hq_agent import prompts
from hq_agent.config import Settings
from hq_agent.mcp import MCPToolset
from hq_agent.middleware import PushBeforeDoneMiddleware
from hq_agent.models import resolve_role
from hq_agent.skills_store import SkillStore
from hq_agent.tools import RESEARCH_TOOLS, make_skill_tools

READ_ONLY_FS_TOOLS = ["ls", "read_file", "glob", "grep", "execute"]


def build_subagents(
    settings: Settings,
    backend: BackendProtocol,
    model_override: BaseChatModel | None = None,
    *,
    sandbox: Any = None,
    store: SkillStore | None = None,
    mcp_tools: MCPToolset | None = None,
) -> list[SubAgent]:
    from hq_agent.graph import skill_sources  # local import: graph imports this module

    routing = settings.models
    toolset = mcp_tools or MCPToolset()
    skills = skill_sources(settings) or None

    def role(spec: str):
        if model_override is not None:
            return model_override, []
        return resolve_role(spec, routing)

    coder_model, coder_mw = role(routing.coder)
    reviewer_model, reviewer_mw = role(routing.reviewer)
    researcher_model, researcher_mw = role(routing.researcher)

    coder_extra = [PushBeforeDoneMiddleware(sandbox)] if sandbox is not None and settings.push_reminder else []
    coder_tools = [*RESEARCH_TOOLS, *toolset.tools_for("coder")]  # research tools: reading docs while coding
    if store is not None:
        coder_tools += make_skill_tools(store, require_approval=settings.require_skill_approval, proposed_by="coder")

    return [
        {
            "name": "coder",
            "description": (
                "Senior engineer. Implements features, fixes bugs, writes tests and refactors code in "
                "/workspace, using git branches and commits, and pushes its branch when done. Give it a "
                "complete, self-contained task including the repo (GitHub URL or /workspace path), the goal "
                "and acceptance criteria."
            ),
            "system_prompt": prompts.CODER,
            "model": coder_model,
            "middleware": [*coder_mw, *coder_extra],
            "tools": coder_tools,
            "skills": skills,
            "interrupt_on": toolset.interrupt_on("coder"),
        },
        {
            "name": "reviewer",
            "description": (
                "Independent code reviewer with fresh context. Reviews a change (branch, diff or files) for "
                "bugs, security issues and quality, runs the tests, and reports findings by severity. "
                "Read-only: it never edits code."
            ),
            "system_prompt": prompts.REVIEWER,
            "model": reviewer_model,
            "tools": toolset.tools_for("reviewer"),
            # Replaces the default filesystem middleware, so write/edit/delete tools don't exist for it.
            "middleware": [FilesystemMiddleware(backend=backend, tools=READ_ONLY_FS_TOOLS), *reviewer_mw],
            "skills": skills,
            "interrupt_on": toolset.interrupt_on("reviewer"),
        },
        {
            "name": "researcher",
            "description": (
                "Web research specialist. Finds and reads sources, then returns a sourced synthesis. "
                "Use for docs lookups, library comparisons, market and company background, news."
            ),
            "system_prompt": prompts.RESEARCHER,
            "model": researcher_model,
            "middleware": researcher_mw,
            "tools": [*RESEARCH_TOOLS, *toolset.tools_for("researcher")],
            "interrupt_on": toolset.interrupt_on("researcher"),
        },
    ]
