"""HQ ops API, mounted into the Aegra server (see `http.app` in aegra.json).

The Agent Protocol covers threads and runs; these routes cover everything else
the web UI needs. Phase 0 ships read-only introspection; later phases add
skills management, memory editing and the scheduler here.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool

from hq_agent import __version__
from hq_agent.backends.docker_sandbox import DockerSandbox
from hq_agent.config import load_settings
from hq_agent.security import AuthError, check_bearer


async def require_owner(authorization: str | None = Header(default=None)) -> None:
    try:
        check_bearer(authorization)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


# Aegra adopts this FastAPI instance as the main app and merges its own routes into
# it, so auth goes on the /ops router (app-level dependencies would also land on
# Aegra's /health and break the Docker healthcheck). See security.py for why we
# enforce this ourselves instead of relying on `enable_custom_route_auth`.
router = APIRouter(prefix="/ops", tags=["HQ Ops"], dependencies=[Depends(require_owner)])

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


def _frontmatter(text: str) -> dict[str, str]:
    match = _FRONTMATTER.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip().strip("\"'")
    return fields


def list_skills(skills_dir: Path) -> list[dict[str, str]]:
    skills = []
    for skill_md in sorted(skills_dir.glob("*/*/SKILL.md")):
        meta = _frontmatter(skill_md.read_text(encoding="utf-8"))
        skills.append(
            {
                "category": skill_md.parent.parent.name,
                "name": meta.get("name", skill_md.parent.name),
                "description": meta.get("description", ""),
                "path": f"/skills/{skill_md.parent.parent.name}/{skill_md.parent.name}/SKILL.md",
            }
        )
    return skills


@router.get("/info")
async def info() -> dict:
    settings = load_settings()
    sandbox = (
        await run_in_threadpool(DockerSandbox(settings.sandbox).status)
        if settings.sandbox.enabled
        else {"available": False, "error": "disabled"}
    )
    memory_file = settings.memories_dir / "AGENTS.md"
    return {
        "version": __version__,
        "models": {
            "orchestrator": settings.models.orchestrator,
            "coder": settings.models.coder,
            "reviewer": settings.models.reviewer,
            "researcher": settings.models.researcher,
            "fallback": settings.models.fallback,
            "local_models_configured": bool(settings.models.ollama_base_url),
        },
        "subagents": ["coder", "reviewer", "researcher"],
        "skills": list_skills(settings.skills_dir) if settings.skills_dir.exists() else [],
        "memory": {"path": "/memories/AGENTS.md", "bytes": memory_file.stat().st_size if memory_file.exists() else 0},
        "sandbox": sandbox,
        "web_search": bool(settings.searxng_url),
    }


app = FastAPI(title="HQ", version=__version__)
app.include_router(router)
