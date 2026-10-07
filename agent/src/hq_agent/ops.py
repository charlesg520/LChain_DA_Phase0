"""HQ ops API, mounted into the Aegra server (see `http.app` in aegra.json).

The Agent Protocol covers threads and runs; these routes cover everything else
the web UI needs: skills and their review queue, sandboxes and the idle reaper,
MCP server status, and the git gateway's audit log.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from hq_agent import __version__, mcp
from hq_agent.backends.docker_sandbox import DockerSandbox, project_slug
from hq_agent.config import load_settings
from hq_agent.git_gateway import read_audit
from hq_agent.reaper import get_reaper
from hq_agent.security import AuthError, check_bearer
from hq_agent.skills_store import SkillError, SkillStore

logger = logging.getLogger(__name__)


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


def _store() -> SkillStore:
    s = load_settings()
    return SkillStore(s.skills_dir, s.skill_store_dir, s.builtin_skills_dir)


def _reaper():
    s = load_settings()
    return get_reaper(s.sandbox, s.data_dir)


@contextlib.contextmanager
def _skill_errors():
    try:
        yield
    except SkillError as exc:
        status = 404 if str(exc).startswith(("no skill", "no proposal")) or "has no version" in str(exc) else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc


# ------------------------------------------------------------------- overview
@router.get("/info")
async def info() -> dict:
    settings = load_settings()
    sandbox = (
        await run_in_threadpool(DockerSandbox(settings.sandbox).status)
        if settings.sandbox.enabled
        else {"available": False, "error": "disabled"}
    )
    memory_file = settings.memories_dir / "AGENTS.md"
    store = _store()
    toolset = mcp.current()
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
        "skills": store.list_skills() if settings.skills_dir.exists() else [],
        "pending_skill_proposals": len(store.list_proposals(status="pending")),
        "memory": {"path": "/memories/AGENTS.md", "bytes": memory_file.stat().st_size if memory_file.exists() else 0},
        "sandbox": sandbox,
        "mcp": {name: s.status for name, s in toolset.status.items()},
        "git_gateway": settings.sandbox.git_gateway_url or None,
        "web_search": bool(settings.searxng_url),
    }


# --------------------------------------------------------------------- skills
class SkillFiles(BaseModel):
    files: dict[str, str] = Field(description="Relative path -> full content. Must include SKILL.md.")
    note: str = ""


class Decision(BaseModel):
    note: str = ""
    files: dict[str, str] | None = Field(default=None, description="Approve with these edits instead")


class Rollback(BaseModel):
    version: int


@router.get("/skills")
async def skills() -> list[dict[str, Any]]:
    return _store().list_skills()


@router.get("/skills/{category}/{name}")
async def skill(category: str, name: str) -> dict[str, Any]:
    with _skill_errors():
        return _store().get(category, name)


@router.put("/skills/{category}/{name}")
async def save_skill(category: str, name: str, body: SkillFiles) -> dict[str, Any]:
    with _skill_errors():
        return {"version": _store().save(category, name, body.files, note=body.note)}


@router.delete("/skills/{category}/{name}")
async def delete_skill(category: str, name: str) -> dict[str, Any]:
    with _skill_errors():
        _store().delete(category, name)
    return {"deleted": f"{category}/{name}", "restore": "POST .../rollback with an earlier version"}


@router.get("/skills/{category}/{name}/versions/{version}")
async def skill_version(category: str, name: str, version: int) -> dict[str, Any]:
    with _skill_errors():
        return {"version": version, "files": _store().version_files(category, name, version)}


@router.post("/skills/{category}/{name}/rollback")
async def rollback_skill(category: str, name: str, body: Rollback) -> dict[str, Any]:
    with _skill_errors():
        return {"version": _store().rollback(category, name, body.version), "restored_from": body.version}


@router.post("/skills/{category}/{name}/adopt-builtin")
async def adopt_builtin(category: str, name: str) -> dict[str, Any]:
    with _skill_errors():
        return {"version": _store().adopt_builtin(category, name)}


@router.get("/skill-proposals")
async def skill_proposals(status: str | None = Query(default="pending")) -> list[dict[str, Any]]:
    return [p.__dict__ for p in _store().list_proposals(status=None if status == "all" else status)]


@router.get("/skill-proposals/{proposal_id}")
async def skill_proposal(proposal_id: str) -> dict[str, Any]:
    with _skill_errors():
        return _store().proposal_detail(proposal_id)


@router.post("/skill-proposals/{proposal_id}/approve")
async def approve_proposal(proposal_id: str, body: Decision | None = None) -> dict[str, Any]:
    body = body or Decision()
    with _skill_errors():
        proposal = _store().approve(proposal_id, edited_files=body.files, note=body.note)
    return {
        **proposal.__dict__,
        "note_for_ui": "New threads see the change. To refresh an open thread's skill list, "
        "send its next run with input {'skills_metadata': null}.",
    }


@router.post("/skill-proposals/{proposal_id}/reject")
async def reject_proposal(proposal_id: str, body: Decision | None = None) -> dict[str, Any]:
    with _skill_errors():
        return _store().reject(proposal_id, note=(body or Decision()).note).__dict__


# ------------------------------------------------------------------ sandboxes
class Pin(BaseModel):
    hours: float = Field(gt=0, le=24 * 7)


def _project(raw: str) -> str:
    slug = project_slug(raw)
    if slug != raw:
        raise HTTPException(status_code=400, detail=f"invalid project name {raw!r} (did you mean {slug!r}?)")
    return slug


@router.get("/sandboxes")
async def sandboxes() -> dict[str, Any]:
    if not load_settings().sandbox.enabled:
        return {"enabled": False}
    return await run_in_threadpool(_reaper().inventory)


@router.post("/sandboxes/reap")
async def reap(dry_run: bool = Query(default=True)) -> dict[str, Any]:
    """Run one reaper sweep now. Dry run by default: shows what would happen."""
    result = await run_in_threadpool(lambda: _reaper().reap_once(dry_run=dry_run))
    return result.as_dict()


@router.post("/sandboxes/{project}/stop")
async def stop_sandbox(project: str, host: str | None = None) -> dict[str, Any]:
    try:
        done = await run_in_threadpool(lambda: _reaper().act(_project(project), "stop", host))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"done": done}


@router.delete("/sandboxes/{project}")
async def remove_sandbox(project: str, host: str | None = None, workspace: bool = False) -> dict[str, Any]:
    """Remove the container. The /workspace volume is kept unless workspace=true."""
    try:
        done = await run_in_threadpool(
            lambda: _reaper().act(_project(project), "remove", host, remove_workspace=workspace)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"done": done}


@router.post("/sandboxes/{project}/pin")
async def pin_sandbox(project: str, body: Pin) -> dict[str, Any]:
    return {"project": project, "pinned_until": _reaper().pins.pin(_project(project), body.hours)}


@router.delete("/sandboxes/{project}/pin")
async def unpin_sandbox(project: str) -> dict[str, Any]:
    _reaper().pins.unpin(_project(project))
    return {"project": project, "pinned_until": None}


# ------------------------------------------------------------------ mcp + git
@router.get("/mcp")
async def mcp_status() -> dict[str, Any]:
    return mcp.current().as_dict()


@router.get("/git")
async def git_gateway() -> dict[str, Any]:
    """Gateway health and policy (allowlist, push prefix). Never includes secrets."""
    settings = load_settings()
    url = settings.sandbox.git_gateway_url
    if not url:
        return {"configured": False}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            health = (await client.get(f"{url.rstrip('/')}/healthz")).json()
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "url": url, "reachable": False, "error": str(exc)}
    return {"configured": True, "url": url, "reachable": True, **health}


@router.get("/git/audit")
async def git_audit(limit: int = Query(default=100, ge=1, le=1000)) -> list[dict[str, Any]]:
    return read_audit(load_settings().audit_dir / "git-gateway.jsonl", limit=limit)


# ------------------------------------------------------------------------ app
@contextlib.asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Aegra merges this with its own lifespan. Aegra builds the graph lazily (on the
    first run), so anything the UI should see before then starts here."""
    settings = load_settings()
    try:
        synced = _store().sync_builtin()
        if any(synced.values()):
            logger.info("skills synced from repo: %s", synced)
    except Exception:  # noqa: BLE001 - a skills problem must not stop the server
        logger.exception("skill sync failed")
    # Connect MCP servers in the background so a slow one can't delay startup.
    mcp_task = asyncio.create_task(mcp.ensure_loaded(settings.mcp_config))
    reaper = None
    if settings.sandbox.enabled and settings.sandbox.reaper_enabled:
        reaper = get_reaper(settings.sandbox, settings.data_dir)
        reaper.start()
    try:
        yield
    finally:
        mcp_task.cancel()
        if reaper is not None:
            reaper.stop()


app = FastAPI(title="HQ", version=__version__, lifespan=lifespan)
app.include_router(router)
