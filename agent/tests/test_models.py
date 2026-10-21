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


def test_model_thinking_false_sends_thinking_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from langchain_core.messages import HumanMessage

    monkeypatch.setenv("MODEL_THINKING", "false")
    model = build_model("anthropic:glm-5.3", ModelRouting())
    payload = model._get_request_payload([HumanMessage("hi")])
    assert payload["thinking"] == {"type": "disabled"}


def test_thinking_left_to_the_provider_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    from langchain_core.messages import HumanMessage

    monkeypatch.delenv("MODEL_THINKING", raising=False)
    payload = build_model("anthropic:glm-5.3", ModelRouting())._get_request_payload([HumanMessage("hi")])
    assert "thinking" not in payload or payload["thinking"] is None


def test_openai_compatible_role(monkeypatch: pytest.MonkeyPatch) -> None:
    from langchain_core.messages import HumanMessage

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("MODEL_STREAMING", "true")
    model = build_model("openai:claude-opus-5-5", ModelRouting())
    assert type(model).__name__ == "ChatOpenAI"
    assert model.model_name == "claude-opus-5-5"
    assert model.openai_api_base == "https://provider.example/v1"
    assert model.stream_usage is True and model.use_responses_api is False
    assert model._should_stream_usage() is True  # streams end with a usage chunk
    assert model._get_request_payload([HumanMessage("hi")])["model"] == "claude-opus-5-5"
