from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage

REPO_SKILLS = Path(__file__).resolve().parents[2] / "skills"


class ScriptedModel(GenericFakeChatModel):
    """Fake chat model that replays scripted AIMessages and records what it was sent."""

    seen_tools: list[str] = []
    seen_prompts: list[list[BaseMessage]] = []

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        names = []
        for t in tools:
            names.append(t.get("name") if isinstance(t, dict) else getattr(t, "name", str(t)))
        self.seen_tools.extend(n for n in names if n)
        return self

    def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any):
        self.seen_prompts.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


def scripted(*messages: AIMessage) -> ScriptedModel:
    model = ScriptedModel(messages=iter(messages))
    model.seen_tools = []
    model.seen_prompts = []
    return model


def tool_call(name: str, args: dict, call_id: str = "call_1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}])


@pytest.fixture
def hq_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated data dir, a copy of the repo skills, sandbox disabled, no network services."""
    skills = tmp_path / "skills"
    shutil.copytree(REPO_SKILLS, skills)
    monkeypatch.setenv("HQ_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HQ_SKILLS_DIR", str(skills))
    monkeypatch.setenv("SANDBOX_ENABLED", "false")
    monkeypatch.setenv("SEARXNG_URL", "")
    monkeypatch.setenv("OLLAMA_BASE_URL", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-used")
    return tmp_path
