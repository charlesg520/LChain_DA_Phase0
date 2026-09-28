"""Subagent roster. Phase 3 adds the markets team (analyst, quant, risk)."""

from __future__ import annotations

from deepagents import FilesystemMiddleware, SubAgent
from deepagents.backends.protocol import BackendProtocol
from langchain_core.language_models import BaseChatModel

from hq_agent import prompts
from hq_agent.config import Settings
from hq_agent.models import resolve_role
from hq_agent.tools import RESEARCH_TOOLS

READ_ONLY_FS_TOOLS = ["ls", "read_file", "glob", "grep", "execute"]


def build_subagents(
    settings: Settings,
    backend: BackendProtocol,
    model_override: BaseChatModel | None = None,
) -> list[SubAgent]:
    routing = settings.models

    def role(spec: str):
        if model_override is not None:
            return model_override, []
        return resolve_role(spec, routing)

    coder_model, coder_mw = role(routing.coder)
    reviewer_model, reviewer_mw = role(routing.reviewer)
    researcher_model, researcher_mw = role(routing.researcher)

    return [
        {
            "name": "coder",
            "description": (
                "Senior engineer. Implements features, fixes bugs, writes tests and refactors code in "
                "/workspace, using git branches and commits. Give it a complete, self-contained task "
                "including the repo path, the goal and acceptance criteria."
            ),
            "system_prompt": prompts.CODER,
            "model": coder_model,
            "middleware": coder_mw,
            "tools": RESEARCH_TOOLS,  # for reading docs while coding
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
            "tools": [],
            # Replaces the default filesystem middleware, so write/edit/delete tools don't exist for it.
            "middleware": [FilesystemMiddleware(backend=backend, tools=READ_ONLY_FS_TOOLS), *reviewer_mw],
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
            "tools": RESEARCH_TOOLS,
        },
    ]
