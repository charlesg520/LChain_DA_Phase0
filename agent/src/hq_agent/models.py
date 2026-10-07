"""Model resolution with automatic fallback for local models."""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware, ModelFallbackMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from hq_agent.config import ModelRouting


def is_local(spec: str) -> bool:
    return spec.startswith("ollama:")


def build_model(spec: str, routing: ModelRouting) -> BaseChatModel:
    """Turn a `provider:model` string into a chat model instance."""
    if is_local(spec):
        _, model_name = spec.split(":", 1)
        return init_chat_model(model_name, model_provider="ollama", base_url=routing.ollama_base_url)
    return init_chat_model(spec)


def resolve_role(spec: str, routing: ModelRouting) -> tuple[str | BaseChatModel, list[AgentMiddleware]]:
    """Return the model to use for a role plus any middleware it needs.

    - Local model with no OLLAMA_BASE_URL configured: use the fallback model outright.
    - Local model with a URL: use it, and fail over to the fallback model on errors
      (home machine asleep, model not pulled, timeout).
    - API model: use as-is.
    """
    if is_local(spec):
        if not routing.ollama_base_url:
            return build_model(routing.fallback, routing), []
        return build_model(spec, routing), [ModelFallbackMiddleware(build_model(routing.fallback, routing))]
    return build_model(spec, routing), []
