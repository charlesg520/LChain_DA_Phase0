"""Model calls that survive a flaky provider, and say so while they wait.

Without this, the provider SDKs retry on their own: silently, up to twice, each
time waiting whatever the provider asks (two minutes for a Cloudflare 524). A
stalled step then looks like HQ ignoring you for ten minutes.

`ResilientModelMiddleware` takes over: SDK retries are off (see models.py), and a
transient failure (timeout, connection error, 408/409/429/5xx incl. Cloudflare's
520-529) is retried here with backoff, honouring Retry-After up to a cap. Every
wait is announced on the run's stream as a custom event, which the console shows
("model provider timed out, retrying in 30s (1/3)"). After the last retry the
next model in line is tried (a local model's fallback, or MODEL_BACKUP), and when
nothing is left the run fails with one plain sentence instead of an SDK dump.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel
from langgraph.errors import GraphBubbleUp

logger = logging.getLogger(__name__)

TRANSIENT_STATUS = {408, 409, 425, 429}
TRANSIENT_NAMES = (
    "Timeout",  # APITimeoutError, ReadTimeout, ConnectTimeout, TimeoutException
    "APIConnectionError",
    "ConnectError",
    "RemoteProtocolError",
    "ReadError",
    "ServiceUnavailable",
    "Overloaded",
)


class ModelUnavailableError(RuntimeError):
    """Raised when every model in line failed with transient errors."""


@dataclass
class Attempt:
    """One model in the failover line."""

    model: BaseChatModel
    label: str
    retries: int  # retries after the first try


def status_of(exc: BaseException) -> int | None:
    for attr in ("status_code", "status"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None


def is_transient(exc: BaseException) -> bool:
    status = status_of(exc)
    if status is not None:
        return status in TRANSIENT_STATUS or status >= 500
    name = type(exc).__name__
    if any(part in name for part in TRANSIENT_NAMES):
        return True
    cause = exc.__cause__ or exc.__context__
    return cause is not None and cause is not exc and is_transient(cause)


def describe(exc: BaseException) -> str:
    """A few plain words about what went wrong, for the console."""
    status = status_of(exc)
    if status == 524:
        return "timed out (HTTP 524: the provider took too long to answer)"
    if status == 529:
        return "is overloaded (HTTP 529)"
    if status == 429:
        return "is rate-limiting us (HTTP 429)"
    if status is not None and status >= 500:
        return f"returned a server error (HTTP {status})"
    if status is not None:
        return f"returned HTTP {status}"
    name = type(exc).__name__
    if "Timeout" in name:
        return "timed out"
    if "Connect" in name or "Connection" in name:
        return "could not be reached"
    return f"failed ({name})"


def retry_after(exc: BaseException) -> float | None:
    """Seconds the provider asked us to wait, if it said."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    raw = headers.get("retry-after") if hasattr(headers, "get") else None
    try:
        return float(raw) if raw is not None else None
    except ValueError:
        return None


def model_name(model: BaseChatModel) -> str:
    for attr in ("model_name", "model"):
        value = getattr(model, attr, None)
        if isinstance(value, str) and value:
            return value
    return type(model).__name__


def emit(event: dict[str, Any]) -> None:
    """Put an event on the run's custom stream (no-op outside a graph run)."""
    try:
        from langgraph.config import get_stream_writer

        get_stream_writer()({"hq": event.pop("kind"), **event})
    except Exception:  # noqa: BLE001 - outside a run, or stream mode not requested
        pass


class ResilientModelMiddleware(AgentMiddleware):
    """Retry transient model failures visibly, then fail over down a line of models."""

    def __init__(
        self,
        line: list[Attempt],
        *,
        base_delay: float = 15.0,
        max_delay: float = 120.0,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__()
        if not line:
            raise ValueError("need at least one model")
        self.line = line
        self.base_delay = base_delay
        self.max_delay = max_delay
        self._sleep = sleep or asyncio.sleep
        self.tools = []

    # Exposed for tests and the console's tool registry.
    @property
    def labels(self) -> list[str]:
        return [a.label for a in self.line]

    def _delay(self, exc: BaseException, retry_index: int) -> float:
        asked = retry_after(exc)
        if asked is not None:
            return min(max(asked, 1.0), self.max_delay)
        base = self.base_delay * (2**retry_index)
        return min(base * random.uniform(0.85, 1.15), self.max_delay)

    def _request_for(self, request: Any, index: int) -> Any:
        if index == 0:
            return request
        attempt = self.line[index]
        request = request.override(model=attempt.model)
        if type(attempt.model).__name__ != "ChatAnthropic":
            # Anthropic cache markers added by an outer caching middleware break other providers.
            try:
                from langchain.agents.middleware.model_fallback import _sanitize_request_for_fallback

                request = _sanitize_request_for_fallback(request)
            except Exception:  # noqa: BLE001 - private helper; best effort
                pass
        return request

    def _plan(self, exc: BaseException, index: int, retry: int) -> tuple[str, float | None]:
        """What to do after a failure: ("retry", delay) | ("next", None) | ("raise", None)."""
        if isinstance(exc, GraphBubbleUp) or not is_transient(exc):
            return "raise", None
        if retry < self.line[index].retries:
            return "retry", self._delay(exc, retry)
        if index + 1 < len(self.line):
            return "next", None
        return "give_up", None

    def _announce(self, kind: str, index: int, retry: int, exc: BaseException, delay: float | None) -> None:
        attempt = self.line[index]
        reason = describe(exc)
        if kind == "retry":
            logger.warning("model %s %s; retry %d/%d in %.0fs", attempt.label, reason, retry + 1, attempt.retries, delay)
            emit({"kind": "model_retry", "model": attempt.label, "reason": reason, "attempt": retry + 1, "of": attempt.retries, "delay_s": round(delay or 0)})
        elif kind == "next":
            nxt = self.line[index + 1]
            logger.warning("model %s %s; switching to %s", attempt.label, reason, nxt.label)
            emit({"kind": "model_switch", "from": attempt.label, "to": nxt.label, "reason": reason})

    def _give_up(self, exc: BaseException) -> ModelUnavailableError:
        last = self.line[-1]
        tried = " then ".join(a.label for a in self.line)
        msg = f"The model provider {describe(exc)} on every try ({tried}); the run stopped. Send a message to pick up where it left off."
        logger.error("%s last error: %r", msg, exc)
        emit({"kind": "model_failed", "model": last.label, "reason": describe(exc)})
        return ModelUnavailableError(msg)

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        index, retry = 0, 0
        while True:
            try:
                return handler(self._request_for(request, index))
            except Exception as exc:  # noqa: BLE001 - classified below
                action, delay = self._plan(exc, index, retry)
                if action == "raise":
                    raise
                if action == "give_up":
                    raise self._give_up(exc) from exc
                self._announce(action, index, retry, exc, delay)
                if action == "retry":
                    time.sleep(delay or 0)
                    retry += 1
                else:
                    index, retry = index + 1, 0

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        index, retry = 0, 0
        while True:
            try:
                return await handler(self._request_for(request, index))
            except Exception as exc:  # noqa: BLE001 - classified below
                action, delay = self._plan(exc, index, retry)
                if action == "raise":
                    raise
                if action == "give_up":
                    raise self._give_up(exc) from exc
                self._announce(action, index, retry, exc, delay)
                if action == "retry":
                    await self._sleep(delay or 0)
                    retry += 1
                else:
                    index, retry = index + 1, 0
