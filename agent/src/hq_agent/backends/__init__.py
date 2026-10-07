"""Storage layout the agent sees.

    /workspace/...   -> per-project Docker sandbox (code, builds, backtests)
    /memories/...    -> plain Markdown on the server's data volume (long-term memory)
    /skills/...      -> SKILL.md folders, bind-mounted from the repo so upgrades show up in git

Memory and skills are plain files on purpose: you can read, edit, diff and back
them up without any special tooling, and the UI can serve them directly.
"""

from __future__ import annotations

from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from deepagents.backends.protocol import BackendProtocol

from hq_agent.backends.docker_sandbox import DockerSandbox
from hq_agent.config import Settings

MEMORIES_ROUTE = "/memories/"
SKILLS_ROUTE = "/skills/"


def build_backend(settings: Settings) -> CompositeBackend:
    settings.memories_dir.mkdir(parents=True, exist_ok=True)
    settings.skills_dir.mkdir(parents=True, exist_ok=True)

    default: BackendProtocol = DockerSandbox(settings.sandbox) if settings.sandbox.enabled else StateBackend()
    return CompositeBackend(
        default=default,
        routes={
            MEMORIES_ROUTE: FilesystemBackend(root_dir=settings.memories_dir, virtual_mode=True),
            SKILLS_ROUTE: FilesystemBackend(root_dir=settings.skills_dir, virtual_mode=True),
        },
    )


__all__ = ["DockerSandbox", "build_backend", "MEMORIES_ROUTE", "SKILLS_ROUTE"]
