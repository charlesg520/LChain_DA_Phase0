"""Integration tests for the Docker sandbox. They need a Docker daemon and the
sandbox image (`make sandbox-image`); otherwise they are skipped."""

from __future__ import annotations

import uuid
from pathlib import Path

import docker
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from hq_agent.backends import docker_sandbox as ds
from hq_agent.config import SandboxSettings, load_settings
from hq_agent.graph import build_agent
from tests.conftest import scripted, tool_call

pytestmark = pytest.mark.docker

IMAGE = "hq-sandbox:latest"


def _docker_ready() -> bool:
    try:
        client = docker.from_env()
        client.ping()
        client.images.get(IMAGE)
        return True
    except Exception:
        return False


if not _docker_ready():
    pytest.skip("Docker daemon or sandbox image not available", allow_module_level=True)


@pytest.fixture
def project(monkeypatch: pytest.MonkeyPatch):
    """A unique project name, routed to via the same hook the graph uses, cleaned up afterwards."""
    name = f"test-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(ds, "current_project", lambda: name)
    yield name
    client = docker.from_env()
    # By label (containers we created) and by name (the unlabeled "foreign" container test).
    for c in client.containers.list(all=True, filters={"label": f"hq.project={name}"}):
        c.remove(force=True)
    for c in client.containers.list(all=True, filters={"name": f"^hq-sbx-{name}$"}):
        c.remove(force=True)
    try:
        client.volumes.get(f"hq-ws-{name}").remove(force=True)
    except docker.errors.NotFound:
        pass


@pytest.fixture
def sandbox() -> ds.DockerSandbox:
    return ds.DockerSandbox(
        SandboxSettings(
            image=IMAGE,
            docker_hosts=("tcp://127.0.0.1:1", "unix:///var/run/docker.sock"),  # first host is dead: exercises fallback
            network="hq-sandbox-test",
            mem_limit="512m",
            cpus=0.5,
            pids_limit=128,
            default_timeout=30,
            max_output_bytes=2_000,
        )
    )


def test_execute_runs_unprivileged_in_workspace(sandbox, project) -> None:
    res = sandbox.execute("pwd && id -u && echo out && echo err 1>&2")
    assert res.exit_code == 0
    # stdout and stderr are separate streams, so their relative order isn't guaranteed.
    assert sorted(res.output.split()) == sorted(["/workspace", "1000", "out", "err"])
    assert sandbox.execute("exit 3").exit_code == 3
    assert sandbox.status()["active_host"] == "unix:///var/run/docker.sock"


def test_container_is_hardened(sandbox, project) -> None:
    assert sandbox.execute("touch /usr/evil").exit_code != 0  # read-only root
    cap = sandbox.execute("grep CapEff /proc/self/status").output
    assert cap.split()[-1] == "0000000000000000"  # no capabilities
    container = docker.from_env().containers.get(f"hq-sbx-{project}")
    host_cfg = container.attrs["HostConfig"]
    assert host_cfg["Memory"] == 512 * 1024 * 1024
    assert host_cfg["PidsLimit"] == 128
    assert "no-new-privileges" in host_cfg["SecurityOpt"]
    assert list(container.attrs["NetworkSettings"]["Networks"]) == ["hq-sandbox-test"]


def test_timeout_kills_long_commands(sandbox, project) -> None:
    res = sandbox.execute("sleep 20", timeout=2)
    assert res.exit_code == 124
    assert "timed out after 2s" in res.output


def test_long_output_is_clipped_keeping_head_and_tail(sandbox, project) -> None:
    res = sandbox.execute("echo START; for i in {1..3000}; do echo line$i; done; echo END")
    assert res.truncated
    assert res.output.startswith("START") and res.output.rstrip().endswith("END")
    assert "characters clipped" in res.output


def test_upload_download_roundtrip(sandbox, project) -> None:
    up = sandbox.upload_files([("/workspace/a/b/c.txt", b"hello\n"), ("rel.bin", bytes(range(256)))])
    assert [r.error for r in up] == [None, None]
    down = sandbox.download_files(["/workspace/a/b/c.txt", "/workspace/rel.bin", "/workspace/missing", "/workspace/a"])
    assert down[0].content == b"hello\n"
    assert down[1].content == bytes(range(256))
    assert down[2].error == "file_not_found"
    assert down[3].error == "is_directory"
    assert sandbox.execute("stat -c %u /workspace/a/b/c.txt").output.strip() == "1000"


def test_file_tools_work_through_base_sandbox(sandbox, project) -> None:
    assert sandbox.write("/workspace/app.py", "def add(a, b):\n    return a + b\n").error is None
    assert sandbox.edit("/workspace/app.py", "a + b", "a + b  # sum").error is None
    assert "# sum" in sandbox.download_files(["/workspace/app.py"])[0].content.decode()
    assert sandbox.execute("python3 -c 'import app; print(app.add(2, 3))'").output.strip() == "5"


def test_projects_are_isolated(sandbox, project, monkeypatch) -> None:
    sandbox.upload_files([("/workspace/secret.txt", b"project A only")])
    other = f"{project}-b"
    monkeypatch.setattr(ds, "current_project", lambda: other)
    try:
        assert sandbox.execute("test -e /workspace/secret.txt").exit_code == 1
    finally:
        client = docker.from_env()
        client.containers.get(f"hq-sbx-{other}").remove(force=True)
        client.volumes.get(f"hq-ws-{other}").remove(force=True)


def test_workspace_survives_container_restart(sandbox, project) -> None:
    sandbox.upload_files([("/workspace/keep.txt", b"persisted")])
    docker.from_env().containers.get(f"hq-sbx-{project}").remove(force=True)
    assert sandbox.execute("cat /workspace/keep.txt").output == "persisted"


def test_refuses_foreign_container_with_same_name(sandbox, project) -> None:
    docker.from_env().containers.run(IMAGE, name=f"hq-sbx-{project}", detach=True)  # no hq.sandbox label
    res = sandbox.execute("echo hi")
    assert "Refusing" in res.output


def test_agent_runs_shell_commands_end_to_end(hq_env: Path, monkeypatch, project) -> None:
    monkeypatch.setenv("SANDBOX_ENABLED", "true")
    monkeypatch.setenv("SANDBOX_IMAGE", IMAGE)
    monkeypatch.setenv("SANDBOX_DOCKER_HOSTS", "unix:///var/run/docker.sock")
    monkeypatch.setenv("SANDBOX_NETWORK", "hq-sandbox-test")
    model = scripted(
        tool_call("execute", {"command": "python3 -c 'print(6*7)'"}),
        AIMessage(content="The answer is 42."),
    )
    agent = build_agent(load_settings(), model_override=model)
    result = agent.invoke({"messages": [HumanMessage("compute 6*7")]}, {"configurable": {"thread_id": "e2e", "project": project}})
    tool_msgs = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert tool_msgs and "42" in tool_msgs[0].content
    assert result["messages"][-1].content == "The answer is 42."
