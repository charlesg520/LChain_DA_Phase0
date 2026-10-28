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

from hq_agent import __version__, browse, mcp
from hq_agent.backends.docker_sandbox import DockerSandbox, project_slug
from hq_agent.config import Settings, load_settings
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


_SANDBOX: tuple[Any, DockerSandbox] | None = None


def _sandbox(settings: Settings) -> DockerSandbox | None:
    """One sandbox client for browsing, reused while the settings stay the same."""
    global _SANDBOX
    if not settings.sandbox.enabled:
        return None
    if _SANDBOX is None or _SANDBOX[0] != settings.sandbox:
        _SANDBOX = (settings.sandbox, DockerSandbox(settings.sandbox))
    return _SANDBOX[1]


@contextlib.contextmanager
def _browse_errors():
    try:
        yield
    except browse.BrowseError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


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
        "require_approval": list(settings.require_approval),
        "allow_stdio_mcp": settings.allow_stdio_mcp,
        "skill_approval": settings.require_skill_approval,
    }


# ------------------------------------------------------------------ browsing
@router.get("/fs")
async def fs_list(path: str = "/", project: str = "default") -> dict[str, Any]:
    settings = load_settings()
    with _browse_errors():
        return await run_in_threadpool(browse.list_dir, settings, _sandbox(settings), project_slug(project), path)


@router.get("/fs/file")
async def fs_file(path: str, project: str = "default") -> dict[str, Any]:
    settings = load_settings()
    with _browse_errors():
        return await run_in_threadpool(browse.read_file, settings, _sandbox(settings), project_slug(project), path)


class MemoryWrite(BaseModel):
    path: str
    content: str


@router.get("/memory")
async def memory_get() -> dict[str, Any]:
    return {"files": browse.memory_files(load_settings())}


@router.put("/memory")
async def memory_put(body: MemoryWrite) -> dict[str, Any]:
    settings = load_settings()
    with _browse_errors():
        path = browse.save_memory(settings, body.path, body.content)
    return {"saved": path, "files": browse.memory_files(settings)}


# --------------------------------------------------------------------- tools
_TOOLS_CACHE: dict[str, Any] = {}


@router.get("/tools")
async def tools() -> list[dict[str, Any]]:
    """Every tool, with schema and which agents get it. Rebuilt when MCP servers or skills change."""
    settings = load_settings()
    toolset = mcp.current()
    key = f"{id(toolset)}:{toolset.loaded_at}:{settings.require_approval}"
    if _TOOLS_CACHE.get("key") != key:
        _TOOLS_CACHE["value"] = await run_in_threadpool(_build_registry, settings, toolset)
        _TOOLS_CACHE["key"] = key
    return _TOOLS_CACHE["value"]


def _build_registry(settings: Settings, toolset: mcp.MCPToolset) -> list[dict[str, Any]]:
    from hq_agent.graph import tool_registry

    return tool_registry(settings, toolset)


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
    settings = load_settings()
    new_category = not (settings.skills_dir / category).is_dir()
    with _skill_errors():
        version = _store().save(category, name, body.files, note=body.note)
    if new_category:
        mcp.invalidate_graph()  # skill categories are fixed when the graph is built
    return {"version": version}


class Enabled(BaseModel):
    enabled: bool


@router.post("/skills/{category}/{name}/enabled")
async def skill_enabled(category: str, name: str, body: Enabled) -> dict[str, Any]:
    with _skill_errors():
        enabled = _store().set_enabled(category, name, body.enabled)
    mcp.invalidate_graph()
    return {"category": category, "name": name, "enabled": enabled}


@router.delete("/skills/{category}/{name}")
async def delete_skill(category: str, name: str) -> dict[str, Any]:
    with _skill_errors():
        _store().delete(category, name)
    mcp.invalidate_graph()
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


# ------------------------------------------------------------------ threads
@router.post("/threads/{thread_id}/reopen-interrupt")
async def reopen_interrupt(thread_id: str) -> dict[str, Any]:
    """Let a thread with pending approvals be resumed again.

    Aegra only accepts a resume while the thread's status is "interrupted"; one
    failed resume flips it to "error" and strands the approval. The console calls
    this only after checking the thread state still holds pending interrupts.
    """
    try:
        from sqlalchemy import select

        from aegra_api.api.runs import set_thread_status
        from aegra_api.core.orm import Thread as ThreadORM
        from aegra_api.core.orm import _get_session_maker
    except ImportError as exc:  # pragma: no cover - only outside Aegra
        raise HTTPException(status_code=501, detail="not running inside Aegra") from exc
    async with _get_session_maker()() as session:
        thread = await session.scalar(select(ThreadORM).where(ThreadORM.thread_id == thread_id))
        if thread is None:
            raise HTTPException(status_code=404, detail="no such thread")
        if thread.status == "busy":
            raise HTTPException(status_code=409, detail="thread is running")
        await set_thread_status(session, thread_id, "interrupted")
    return {"thread_id": thread_id, "status": "interrupted"}


@router.post("/threads/{thread_id}/dismiss-interrupt")
async def dismiss_interrupt(thread_id: str) -> dict[str, Any]:
    """Mark a thread waiting for approval as idle, when C stops it instead of deciding.

    The console stops the run on its side; without this the thread would stay
    "interrupted" and come back as a pending approval after every console restart.
    The next message in that chat starts a fresh run as usual.
    """
    try:
        from sqlalchemy import select

        from aegra_api.api.runs import set_thread_status
        from aegra_api.core.orm import Thread as ThreadORM
        from aegra_api.core.orm import _get_session_maker
    except ImportError as exc:  # pragma: no cover - only outside Aegra
        raise HTTPException(status_code=501, detail="not running inside Aegra") from exc
    async with _get_session_maker()() as session:
        thread = await session.scalar(select(ThreadORM).where(ThreadORM.thread_id == thread_id))
        if thread is None:
            raise HTTPException(status_code=404, detail="no such thread")
        if thread.status != "interrupted":
            return {"thread_id": thread_id, "status": thread.status}
        await set_thread_status(session, thread_id, "idle")
    return {"thread_id": thread_id, "status": "idle"}


# ------------------------------------------------------------------ mcp + git
@router.get("/mcp")
async def mcp_status() -> dict[str, Any]:
    return mcp.current().as_dict()


_RELOAD: dict[str, Any] = {"task": None}


def _schedule_reload(settings: Settings, connecting: str | None = None) -> None:
    """Reconnect MCP servers in the background; the UI polls /ops/mcp/servers meanwhile."""
    if connecting:
        mcp.current().status[connecting] = mcp.ServerStatus(status="connecting")
    task = _RELOAD.get("task")
    if task is not None and not task.done():
        task.cancel()
    _RELOAD["task"] = asyncio.create_task(mcp.reload(settings.mcp_config))


def _mcp_path(settings: Settings):
    if settings.mcp_config is None:
        raise HTTPException(status_code=409, detail="HQ_MCP_CONFIG is not set, so MCP servers can't be edited")
    return settings.mcp_config


@router.get("/mcp/servers")
async def mcp_servers() -> list[dict[str, Any]]:
    settings = load_settings()
    return mcp.describe(settings.mcp_config, mcp.current())


@router.post("/mcp/servers")
async def mcp_add(body: dict[str, Any]) -> list[dict[str, Any]]:
    settings = load_settings()
    path = _mcp_path(settings)
    try:
        name, cfg = mcp.server_from_form(body, allow_stdio=settings.allow_stdio_mcp)
        await run_in_threadpool(mcp.upsert_server, path, name, cfg)
    except mcp.MCPConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _schedule_reload(settings, connecting=name)
    return mcp.describe(path, mcp.current())


@router.delete("/mcp/servers/{name}")
async def mcp_remove(name: str) -> list[dict[str, Any]]:
    settings = load_settings()
    path = _mcp_path(settings)
    if not await run_in_threadpool(mcp.remove_server, path, name):
        raise HTTPException(status_code=404, detail=f"no MCP server named {name}")
    mcp.current().status.pop(name, None)
    _schedule_reload(settings)
    return mcp.describe(path, mcp.current())


@router.post("/mcp/servers/{name}/enabled")
async def mcp_enable(name: str, body: Enabled) -> list[dict[str, Any]]:
    settings = load_settings()
    path = _mcp_path(settings)
    if not await run_in_threadpool(mcp.set_server_enabled, path, name, body.enabled):
        raise HTTPException(status_code=404, detail=f"no MCP server named {name}")
    if body.enabled:
        _schedule_reload(settings, connecting=name)
    else:
        mcp.current().status[name] = mcp.ServerStatus(status="disabled")
        _schedule_reload(settings)
    return mcp.describe(path, mcp.current())


@router.post("/mcp/reload")
async def mcp_reload() -> list[dict[str, Any]]:
    settings = load_settings()
    toolset = await mcp.reload(settings.mcp_config)
    return mcp.describe(settings.mcp_config, toolset)


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
    mcp.seed_config(settings.mcp_config, settings.mcp_seed)
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
