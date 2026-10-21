"""Model construction: the MODEL_STREAMING switch for providers with broken streaming."""

from __future__ import annotations

import pytest

from hq_agent.config import ModelRouting
from hq_agent.models import build_model, resolve_role


@pytest.fixture(autouse=True)
def _key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


def test_streaming_is_on_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MODEL_STREAMING", raising=False)
    routing = ModelRouting()
    assert routing.streaming is True
    assert build_model("anthropic:glm-5.3", routing).disable_streaming is False


def test_model_streaming_false_turns_streaming_off_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL_STREAMING", "false")
    monkeypatch.setenv("MODEL_FALLBACK", "anthropic:glm-5.3")
    routing = ModelRouting()
    assert routing.streaming is False
    assert build_model("anthropic:glm-5.3", routing).disable_streaming is True
    # a local role with no home machine resolves to the fallback, which must honour it too
    model, middleware = resolve_role("ollama:qwen3:14b", routing)
    assert middleware == [] and model.disable_streaming is True
