"""Agent middleware.

PushBeforeDoneMiddleware enforces the push-before-done rule: when an agent that
used the shell this turn tries to finish, it checks `/workspace` repos for
commits that exist on no remote. If there are any, the agent gets one reminder
and goes back to the model, where it either pushes or explains why not. One
reminder per turn, so it can't loop.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

logger = logging.getLogger(__name__)

REMINDER_KEY = "hq_push_reminder"

# Repos at /workspace, /workspace/<x>, /workspace/<x>/<y> that have a remote and
# commits not reachable from any remote-tracking branch. Prints path|branch|count.
UNPUSHED_SCRIPT = r"""
for d in /workspace/ /workspace/*/ /workspace/*/*/; do
  [ -e "$d.git" ] || continue
  [ -n "$(git -C "$d" remote 2>/dev/null)" ] || continue
  n=$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] || continue
  echo "${d%/}|$(git -C "$d" branch --show-current 2>/dev/null)|$n"
done
"""


def _current_turn(messages: list[BaseMessage]) -> list[BaseMessage]:
    """Messages since the last human message that isn't one of our reminders."""
    turn: list[BaseMessage] = []
    for message in reversed(messages):
        if isinstance(message, HumanMessage) and not message.additional_kwargs.get(REMINDER_KEY):
            break
        turn.append(message)
    return turn


def parse_unpushed(output: str) -> list[tuple[str, str, int]]:
    found = []
    for line in output.splitlines():
        parts = line.strip().split("|")
        if len(parts) == 3 and parts[2].isdigit():
            found.append((parts[0], parts[1] or "(detached)", int(parts[2])))
    return found


class PushBeforeDoneMiddleware(AgentMiddleware):
    def __init__(self, sandbox: Any, *, max_reminders: int = 1) -> None:
        super().__init__()
        self.sandbox = sandbox
        self.max_reminders = max_reminders

    def _check(self, state: dict[str, Any]) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage) or last.tool_calls:
            return None  # not finishing yet
        turn = _current_turn(messages)
        reminders = sum(1 for m in turn if isinstance(m, HumanMessage) and m.additional_kwargs.get(REMINDER_KEY))
        if reminders >= self.max_reminders:
            return None
        used_shell = any(isinstance(m, AIMessage) and any(tc["name"] == "execute" for tc in m.tool_calls) for m in turn)
        if not used_shell:
            return None  # no commands ran, so no commits were made; don't wake a sandbox for nothing

        try:
            result = self.sandbox.execute(UNPUSHED_SCRIPT, timeout=30)
        except Exception:  # noqa: BLE001 - the check is a courtesy; never break a run over it
            logger.exception("unpushed-commit check failed")
            return None
        if result.exit_code not in (0, None) or not result.output:
            return None
        unpushed = parse_unpushed(result.output)
        if not unpushed:
            return None

        listing = "\n".join(f"- {path} on branch `{branch}`: {n} commit(s) not on any remote" for path, branch, n in unpushed)
        text = (
            "[HQ push check] Before you finish: these repos have commits that aren't pushed anywhere.\n"
            f"{listing}\n\n"
            "Push them (`git push -u origin <branch>`; only `hq/*` branches are accepted), then finish. "
            "If they shouldn't be pushed, say why in your final report instead."
        )
        return {"messages": [HumanMessage(content=text, additional_kwargs={REMINDER_KEY: True})], "jump_to": "model"}

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: dict[str, Any], runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
        return self._check(state)

    @hook_config(can_jump_to=["model"])
    async def aafter_model(self, state: dict[str, Any], runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
        return await asyncio.to_thread(self._check, state)
