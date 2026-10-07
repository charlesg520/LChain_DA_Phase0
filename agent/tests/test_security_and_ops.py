from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from langgraph_sdk import Auth

from hq_agent.skills_store import SkillStore
from hq_agent.tools import fetch_url

AGENT_DIR = Path(__file__).resolve().parents[1]
GOOD_TOKEN = "x" * 48


def _load_auth():
    spec = importlib.util.spec_from_file_location("hq_auth", AGENT_DIR / "auth.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_auth_accepts_the_owner_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HQ_API_TOKEN", GOOD_TOKEN)
    auth = _load_auth()
    user = await auth.authenticate({"Authorization": f"Bearer {GOOD_TOKEN}"})
    assert user["identity"] == "owner"


@pytest.mark.parametrize("header", [None, "Bearer wrong", f"Basic {GOOD_TOKEN}", f"Bearer {GOOD_TOKEN}x"])
async def test_auth_rejects_bad_credentials(monkeypatch: pytest.MonkeyPatch, header: str | None) -> None:
    monkeypatch.setenv("HQ_API_TOKEN", GOOD_TOKEN)
    auth = _load_auth()
    headers = {"authorization": header} if header else {}
    with pytest.raises(Auth.exceptions.HTTPException) as exc:
        await auth.authenticate(headers)
    assert exc.value.status_code == 401


async def test_auth_fails_closed_without_a_strong_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HQ_API_TOKEN", "short")
    auth = _load_auth()
    with pytest.raises(Auth.exceptions.HTTPException) as exc:
        await auth.authenticate({"authorization": "Bearer short"})
    assert exc.value.status_code == 503


@pytest.mark.parametrize(
    "url",
    ["http://127.0.0.1:8000/ops/info", "http://localhost:5432", "http://169.254.169.254/latest/meta-data", "http://postgres:5432"],
)
async def test_fetch_url_refuses_internal_addresses(url: str) -> None:
    result = await fetch_url.ainvoke({"url": url})
    assert result.startswith("Refusing")


async def test_fetch_url_rejects_non_http() -> None:
    assert (await fetch_url.ainvoke({"url": "file:///etc/passwd"})).startswith("Only http")


def test_ops_lists_repo_skills(tmp_path: Path) -> None:
    skills = SkillStore(AGENT_DIR.parent / "skills", tmp_path / "store").list_skills()
    names = {s["name"] for s in skills}
    assert {"test-first-change", "git-workflow", "backtest-hygiene"} <= names
    assert all(s["description"] for s in skills)


def test_every_ops_route_requires_the_owner_token(hq_env, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.routing import APIRoute
    from fastapi.testclient import TestClient

    from hq_agent.ops import app

    monkeypatch.setenv("HQ_API_TOKEN", GOOD_TOKEN)
    client = TestClient(app)

    def walk(routes):  # FastAPI >=0.14x keeps included routers nested
        for r in routes:
            if isinstance(r, APIRoute):
                yield r
            elif hasattr(r, "original_router"):
                yield from walk(r.original_router.routes)
            elif hasattr(r, "routes"):
                yield from walk(r.routes)

    routes = list(walk(app.routes))
    assert routes
    for route in routes:
        for method in route.methods - {"HEAD", "OPTIONS"}:
            assert client.request(method, route.path).status_code == 401, route.path
    ok = client.get("/ops/info", headers={"Authorization": f"Bearer {GOOD_TOKEN}"})
    assert ok.status_code == 200 and ok.json()["subagents"] == ["coder", "reviewer", "researcher"]


def test_skill_review_flow_over_http(hq_env, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from hq_agent.config import load_settings
    from hq_agent.graph import skill_store
    from hq_agent.ops import app

    monkeypatch.setenv("HQ_API_TOKEN", GOOD_TOKEN)
    client = TestClient(app)
    h = {"Authorization": f"Bearer {GOOD_TOKEN}"}
    store = skill_store(load_settings())
    new_md = "---\nname: git-workflow\ndescription: Updated. Use always.\n---\nnew rules\n"
    proposal, _ = store.propose("coding", "git-workflow", {"SKILL.md": new_md}, "learned something")

    queue = client.get("/ops/skill-proposals", headers=h).json()
    assert [p["id"] for p in queue] == [proposal.id]
    detail = client.get(f"/ops/skill-proposals/{proposal.id}", headers=h).json()
    assert "+new rules" in detail["diff"] and detail["reason"] == "learned something"

    approved = client.post(f"/ops/skill-proposals/{proposal.id}/approve", headers=h, json={"note": "ok"}).json()
    assert approved["status"] == "approved"
    assert client.get("/ops/skills/coding/git-workflow", headers=h).json()["files"]["SKILL.md"] == new_md
    assert client.post(f"/ops/skill-proposals/{proposal.id}/approve", headers=h).status_code == 400  # already decided

    versions = client.get("/ops/skills/coding/git-workflow", headers=h).json()["history"]
    first = versions[0]["version"]
    rolled = client.post("/ops/skills/coding/git-workflow/rollback", headers=h, json={"version": first}).json()
    assert rolled["restored_from"] == first
    assert "new rules" not in client.get("/ops/skills/coding/git-workflow", headers=h).json()["files"]["SKILL.md"]

    bad = client.put("/ops/skills/coding/git-workflow", headers=h, json={"files": {"SKILL.md": "nope"}})
    assert bad.status_code == 400 and "frontmatter" in bad.json()["detail"]
    assert client.get("/ops/skills/coding/missing", headers=h).status_code == 404
    assert client.get("/ops/skill-proposals/../../etc", headers=h).status_code == 404

    info = client.get("/ops/info", headers=h).json()
    assert info["pending_skill_proposals"] == 0


def test_sandbox_ops_validate_project_names(hq_env, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from hq_agent.ops import app

    monkeypatch.setenv("HQ_API_TOKEN", GOOD_TOKEN)
    monkeypatch.setenv("SANDBOX_ENABLED", "true")
    monkeypatch.setenv("SANDBOX_DOCKER_HOSTS", "tcp://127.0.0.1:1")
    client = TestClient(app)
    h = {"Authorization": f"Bearer {GOOD_TOKEN}"}
    assert client.post("/ops/sandboxes/Bad%20Name/pin", headers=h, json={"hours": 1}).status_code == 400
    assert client.post("/ops/sandboxes/demo/pin", headers=h, json={"hours": 2}).json()["pinned_until"] > 0
    inv = client.get("/ops/sandboxes", headers=h).json()
    assert inv["hosts"]["tcp://127.0.0.1:1"]["reachable"] is False
    assert client.post("/ops/sandboxes/demo/stop?host=tcp://evil:1", headers=h).status_code == 400


def test_git_audit_endpoint(hq_env, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from hq_agent.config import load_settings
    from hq_agent.git_gateway import AuditLog
    from hq_agent.ops import app

    monkeypatch.setenv("HQ_API_TOKEN", GOOD_TOKEN)
    AuditLog(load_settings().audit_dir / "git-gateway.jsonl").write(decision="denied", repo="me/app")
    client = TestClient(app)
    events = client.get("/ops/git/audit", headers={"Authorization": f"Bearer {GOOD_TOKEN}"}).json()
    assert events[0]["repo"] == "me/app"
    assert client.get("/ops/git", headers={"Authorization": f"Bearer {GOOD_TOKEN}"}).json() == {"configured": False}
