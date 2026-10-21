"""Model resolution with automatic fallback for local models."""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware, ModelFallbackMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from hq_agent.config import ModelRouting


def is_local(spec: str) -> bool:
    return spec.startswith("ollama:")


def build_model(spec: str, routing: ModelRouting) -> BaseChatModel:
    """Turn a `provider:model` string into a chat model instance.

    With MODEL_STREAMING=false every call is a plain request/response, even while
    the run itself is streamed to the console: replies then arrive whole instead
    of word by word. Use it for providers whose streaming is broken.
    MODEL_THINKING=false turns the model's reasoning pass off (faster steps,
    weaker on hard problems).
    """
    extra: dict = {} if routing.streaming else {"disable_streaming": True}
    if not routing.thinking and spec.startswith("anthropic:"):
        # MODEL_THINKING=false: ask the model to answer without a reasoning pass.
        extra["thinking"] = {"type": "disabled"}
    if is_local(spec):
        _, model_name = spec.split(":", 1)
        return init_chat_model(model_name, model_provider="ollama", base_url=routing.ollama_base_url, **extra)
    if spec.startswith("openai:"):
        # Any OpenAI-compatible endpoint (OPENAI_BASE_URL + OPENAI_API_KEY), e.g. a
        # provider that serves Claude in OpenAI format. stream_usage asks for the
        # usage chunk at the end of a stream so token counts work while streaming;
        # Chat Completions rather than the Responses API, which is what compatible
        # providers implement.
        return init_chat_model(
            spec,
            base_url=routing.openai_base_url or None,
            stream_usage=True,
            use_responses_api=False,
            **extra,
        )
    return init_chat_model(spec, **extra)


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
