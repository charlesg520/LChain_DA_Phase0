"""Push-before-done: unit tests with a fake sandbox, plus the real check script in Docker."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from deepagents.backends.protocol import ExecuteResponse
from langchain_core.messages import AIMessage, HumanMessage

from hq_agent.middleware import REMINDER_KEY, UNPUSHED_SCRIPT, PushBeforeDoneMiddleware, parse_unpushed
from tests.conftest import scripted, tool_call


@dataclass
class FakeSandbox:
    """Answers the unpushed-commit check; any other command 'succeeds'."""

    unpushed: str = ""
    commands: list[str] = field(default_factory=list)

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        self.commands.append(command)
        if command == UNPUSHED_SCRIPT:
            return ExecuteResponse(output=self.unpushed, exit_code=0)
        return ExecuteResponse(output="ok", exit_code=0)


def _agent(sandbox: FakeSandbox, model):
    from langchain.agents import create_agent
    from langchain_core.tools import tool

    @tool
    def execute(command: str) -> str:
        """Run a shell command."""
        return sandbox.execute(command).output

    return create_agent(model, tools=[execute], middleware=[PushBeforeDoneMiddleware(sandbox)])


def test_parse_unpushed() -> None:
    assert parse_unpushed("/workspace/app|hq/x|2\n/workspace/lib||1\ngarbage\n") == [
        ("/workspace/app", "hq/x", 2),
        ("/workspace/lib", "(detached)", 1),
    ]


def test_unpushed_work_gets_one_reminder_then_the_answer_stands() -> None:
    sandbox = FakeSandbox(unpushed="/workspace/app|hq/feature|3\n")
    model = scripted(
        tool_call("execute", {"command": "git commit -am wip"}),
        AIMessage(content="Done!"),
        AIMessage(content="Still not pushing: C asked to keep it local."),
    )
    result = _agent(sandbox, model).invoke({"messages": [HumanMessage("fix the bug")]})

    reminders = [m for m in result["messages"] if isinstance(m, HumanMessage) and m.additional_kwargs.get(REMINDER_KEY)]
    assert len(reminders) == 1
    assert "/workspace/app" in reminders[0].content and "hq/feature" in reminders[0].content
    assert result["messages"][-1].content == "Still not pushing: C asked to keep it local."


def test_pushed_work_finishes_without_a_reminder() -> None:
    sandbox = FakeSandbox(unpushed="")
    model = scripted(tool_call("execute", {"command": "git push"}), AIMessage(content="Pushed hq/x."))
    result = _agent(sandbox, model).invoke({"messages": [HumanMessage("ship it")]})
    assert result["messages"][-1].content == "Pushed hq/x."
    assert UNPUSHED_SCRIPT in sandbox.commands


def test_no_shell_use_means_no_check() -> None:
    sandbox = FakeSandbox(unpushed="/workspace/app|hq/x|1\n")
    result = _agent(sandbox, scripted(AIMessage(content="Just answering a question."))).invoke({"messages": [HumanMessage("q")]})
    assert result["messages"][-1].content == "Just answering a question."
    assert sandbox.commands == []  # never woke the sandbox


def test_each_new_human_turn_gets_its_own_reminder() -> None:
    mw = PushBeforeDoneMiddleware(FakeSandbox(unpushed="/workspace/app|hq/x|1\n"))
    reminder = HumanMessage("[HQ push check]", additional_kwargs={REMINDER_KEY: True})
    shell = AIMessage(content="", tool_calls=[{"name": "execute", "args": {}, "id": "1", "type": "tool_call"}])
    old_turn = [HumanMessage("task 1"), shell, AIMessage("done"), reminder, AIMessage("ok")]
    new_turn = [HumanMessage("task 2"), shell, AIMessage("done")]
    assert mw._check({"messages": old_turn}) is None  # already reminded this turn
    assert mw._check({"messages": old_turn + new_turn})["jump_to"] == "model"


def test_check_failures_never_break_the_run() -> None:
    class Exploding(FakeSandbox):
        def execute(self, command, *, timeout=None):
            raise RuntimeError("docker went away")

    shell = AIMessage(content="", tool_calls=[{"name": "execute", "args": {}, "id": "1", "type": "tool_call"}])
    assert PushBeforeDoneMiddleware(Exploding())._check({"messages": [HumanMessage("x"), shell, AIMessage("done")]}) is None


async def test_async_path_works_too() -> None:
    sandbox = FakeSandbox(unpushed="/workspace/app|hq/x|1\n")
    model = scripted(tool_call("execute", {"command": "x"}), AIMessage(content="done"), AIMessage(content="pushed now"))
    result = await _agent(sandbox, model).ainvoke({"messages": [HumanMessage("go")]})
    assert result["messages"][-1].content == "pushed now"


# ------------------------------------------------- the real script, in Docker
@pytest.mark.docker
def test_unpushed_script_in_a_real_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    from tests.test_docker_sandbox import _docker_ready

    if not _docker_ready():
        pytest.skip("Docker daemon or sandbox image not available")
    import docker

    from hq_agent.backends import docker_sandbox as ds
    from hq_agent.config import SandboxSettings
    from tests.test_docker_sandbox import IMAGE

    project = f"test-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(ds, "current_project", lambda: project)
    sandbox = ds.DockerSandbox(SandboxSettings(image=IMAGE, docker_hosts=("unix:///var/run/docker.sock",), network="hq-sandbox-test"))
    try:
        setup = sandbox.execute(
            "set -e; git init -q --bare /workspace/remote.git; "
            "git clone -q /workspace/remote.git /workspace/app 2>/dev/null; cd /workspace/app; "
            "git commit -q --allow-empty -m one && git push -q origin HEAD:main; "
            "git switch -q -c hq/feature; git commit -q --allow-empty -m two; git commit -q --allow-empty -m three; "
            "mkdir -p /workspace/scratch && cd /workspace/scratch && git init -q && git commit -q --allow-empty -m local-only"
        )
        assert setup.exit_code == 0, setup.output
        found = parse_unpushed(sandbox.execute(UNPUSHED_SCRIPT).output)
        assert found == [("/workspace/app", "hq/feature", 2)]  # scratch repo has no remote: ignored

        sandbox.execute("cd /workspace/app && git push -q -u origin hq/feature")
        assert parse_unpushed(sandbox.execute(UNPUSHED_SCRIPT).output) == []
    finally:
        client = docker.from_env()
        for c in client.containers.list(all=True, filters={"label": f"hq.project={project}"}):
            c.remove(force=True)
        client.volumes.get(f"hq-ws-{project}").remove(force=True)
