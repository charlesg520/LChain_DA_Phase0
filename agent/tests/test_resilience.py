"""ResilientModelMiddleware: visible retries, failover, and plain failure messages."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from hq_agent import resilience
from hq_agent.config import ModelRouting
from hq_agent.models import resolve_role
from hq_agent.resilience import Attempt, ModelUnavailableError, ResilientModelMiddleware, describe, is_transient


class StatusError(Exception):
    def __init__(self, status: int, retry_after: str | None = None) -> None:
        super().__init__(f"HTTP {status}")
        self.status_code = status
        headers = {"retry-after": retry_after} if retry_after else {}
        self.response = SimpleNamespace(status_code=status, headers=headers)


class APITimeoutError(Exception):
    pass


class FakeRequest:
    def __init__(self, model: Any = "primary") -> None:
        self.model = model

    def override(self, **kw: Any) -> FakeRequest:
        return FakeRequest(kw.get("model", self.model))


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    seen: list[dict] = []
    monkeypatch.setattr(resilience, "emit", lambda e: seen.append(dict(e)))
    return seen


def line(*names: str, retries: int = 2) -> list[Attempt]:
    return [Attempt(model=SimpleNamespace(name=n), label=n, retries=retries) for n in names]


def mw(attempts: list[Attempt], sleeps: list[float]) -> ResilientModelMiddleware:
    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    return ResilientModelMiddleware(attempts, base_delay=10, max_delay=100, sleep=fake_sleep)


def run(m: ResilientModelMiddleware, handler) -> Any:
    return asyncio.run(m.awrap_model_call(FakeRequest(), handler))


def test_classification() -> None:
    assert is_transient(StatusError(524)) and is_transient(StatusError(529)) and is_transient(StatusError(429))
    assert is_transient(APITimeoutError()) and is_transient(httpx.ReadTimeout("slow"))
    assert not is_transient(StatusError(400)) and not is_transient(StatusError(401)) and not is_transient(ValueError("x"))
    wrapped = RuntimeError("wrapper")
    wrapped.__cause__ = httpx.ConnectError("refused")
    assert is_transient(wrapped)
    assert "524" in describe(StatusError(524)) and describe(APITimeoutError()) == "timed out"


def test_retries_visibly_then_succeeds(events: list[dict]) -> None:
    calls: list[str] = []
    sleeps: list[float] = []

    async def handler(req: FakeRequest) -> str:
        calls.append(req.model)
        if len(calls) < 3:
            raise StatusError(524, retry_after="120")
        return "ok"

    assert run(mw(line("opus"), sleeps), handler) == "ok"
    assert calls == ["primary"] * 3
    assert sleeps == [100, 100]  # Retry-After 120 honoured, capped at max_delay
    assert [e["kind"] for e in events] == ["model_retry", "model_retry"]
    assert events[0]["attempt"] == 1 and events[0]["of"] == 2 and "524" in events[0]["reason"]


def test_backoff_without_retry_after(events: list[dict]) -> None:
    sleeps: list[float] = []
    n = {"i": 0}

    async def handler(req: FakeRequest) -> str:
        n["i"] += 1
        if n["i"] <= 2:
            raise APITimeoutError()
        return "ok"

    run(mw(line("opus"), sleeps), handler)
    assert 8 <= sleeps[0] <= 12 and 17 <= sleeps[1] <= 23  # 10s, 20s with jitter


def test_fails_over_down_the_line(events: list[dict]) -> None:
    seen: list[str] = []

    async def handler(req: FakeRequest) -> str:
        name = req.model if isinstance(req.model, str) else req.model.name
        seen.append(name)
        if name in ("primary",):
            raise StatusError(503)
        return f"answered by {name}"

    out = run(mw(line("opus", "glm"), []), handler)
    assert out == "answered by glm"
    assert seen == ["primary", "primary", "primary", "glm"]
    assert [e["kind"] for e in events] == ["model_retry", "model_retry", "model_switch"]


def test_gives_up_with_a_plain_message(events: list[dict]) -> None:
    async def handler(req: FakeRequest) -> str:
        raise StatusError(524)

    with pytest.raises(ModelUnavailableError) as err:
        run(mw(line("opus", retries=1), []), handler)
    assert "timed out" in str(err.value) and "Send a message" in str(err.value)
    assert isinstance(err.value.__cause__, StatusError)


def test_real_errors_are_not_retried(events: list[dict]) -> None:
    calls = {"n": 0}

    async def handler(req: FakeRequest) -> str:
        calls["n"] += 1
        raise StatusError(400)

    with pytest.raises(StatusError):
        run(mw(line("opus"), []), handler)
    assert calls["n"] == 1 and events == []


def test_local_model_fails_over_without_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://home:11434")
    monkeypatch.setenv("MODEL_FALLBACK", "anthropic:glm-5.3")
    monkeypatch.setenv("MODEL_BACKUP", "anthropic:claude-opus-5-5")
    _, (m,) = resolve_role("ollama:qwen3:14b", ModelRouting())
    assert m.labels == ["qwen3:14b", "glm-5.3", "claude-opus-5-5"]
    assert [a.retries for a in m.line] == [0, 3, 3]


def test_context_tokens_makes_summaries_come_sooner(monkeypatch: pytest.MonkeyPatch) -> None:
    from deepagents.middleware.summarization import compute_summarization_defaults

    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("MODEL_CONTEXT_TOKENS", "80000")
    model, _ = resolve_role("openai:claude-opus-5-5", ModelRouting())
    assert model.profile["max_input_tokens"] == 80000
    assert compute_summarization_defaults(model)["trigger"] == ("fraction", 0.85)
    assert model.max_retries == 0  # retries are ours, so they can be shown
