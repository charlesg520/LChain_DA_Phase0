"""Model resolution: provider:model strings to chat models, with failover.

Every role's model runs behind `ResilientModelMiddleware` (resilience.py): provider
SDK retries are switched off here so that retries happen visibly, and the line of
models to fail over to is built in `resolve_role`.
"""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from hq_agent.config import ModelRouting
from hq_agent.resilience import Attempt, ResilientModelMiddleware


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
        model = init_chat_model(model_name, model_provider="ollama", base_url=routing.ollama_base_url, **extra)
    else:
        # Retries happen in ResilientModelMiddleware, where they can be shown.
        extra.update(max_retries=0, timeout=routing.timeout)
        if spec.startswith("openai:"):
            # Any OpenAI-compatible endpoint (OPENAI_BASE_URL + OPENAI_API_KEY), e.g. a
            # provider that serves Claude in OpenAI format. stream_usage asks for the
            # usage chunk at the end of a stream so token counts work while streaming;
            # Chat Completions rather than the Responses API, which is what compatible
            # providers implement.
            extra.update(base_url=routing.openai_base_url or None, stream_usage=True, use_responses_api=False)
        model = init_chat_model(spec, **extra)
    if routing.context_tokens > 0:
        profile = dict(model.profile or {})
        profile["max_input_tokens"] = routing.context_tokens
        model = model.model_copy(update={"profile": profile})
    return model


def _label(spec: str) -> str:
    return spec.split(":", 1)[1] if ":" in spec else spec


def resolve_role(spec: str, routing: ModelRouting) -> tuple[str | BaseChatModel, list[AgentMiddleware]]:
    """Return the model to use for a role plus the middleware that keeps it going.

    The failover line:
    - local model with no OLLAMA_BASE_URL: MODEL_FALLBACK outright;
    - local model with a URL: the local model (no retries: if the home machine is
      asleep, fail over at once), then MODEL_FALLBACK;
    - then MODEL_BACKUP, when set and different.
    API models in the line are retried MODEL_RETRIES times before moving on.
    """
    line: list[Attempt] = []
    if is_local(spec):
        if routing.ollama_base_url:
            line.append(Attempt(build_model(spec, routing), _label(spec), retries=0))
        line.append(Attempt(build_model(routing.fallback, routing), _label(routing.fallback), retries=routing.retries))
        used = {routing.fallback}
    else:
        line.append(Attempt(build_model(spec, routing), _label(spec), retries=routing.retries))
        used = {spec}
    if routing.backup and routing.backup not in used:
        line.append(Attempt(build_model(routing.backup, routing), _label(routing.backup), retries=routing.retries))
    middleware = ResilientModelMiddleware(line, base_delay=routing.retry_base, max_delay=routing.retry_max)
    return line[0].model, [middleware]
