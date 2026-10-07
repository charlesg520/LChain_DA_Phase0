from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from langgraph_sdk import Auth

from hq_agent.ops import list_skills
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


def test_ops_lists_repo_skills() -> None:
    skills = list_skills(AGENT_DIR.parent / "skills")
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
