"""Docker integration: git from inside a real sandbox through the gateway, and the idle reaper."""

from __future__ import annotations

import time
import uuid
from pathlib import Path

import docker
import pytest

from hq_agent.backends import docker_sandbox as ds
from hq_agent.config import SandboxSettings
from hq_agent.git_gateway import GatewayConfig, read_audit
from hq_agent.reaper import Pins, SandboxReaper, parse_docker_time
from tests.gitserver import FakeGitHub, run_gateway
from tests.test_docker_sandbox import IMAGE, _docker_ready

pytestmark = pytest.mark.docker

if not _docker_ready():
    pytest.skip("Docker daemon or sandbox image not available", allow_module_level=True)

NETWORK = "hq-sandbox-test"
SOCK = "unix:///var/run/docker.sock"
TOKEN = "ghp_only_the_gateway_knows_this"
SECRET = "g" * 40


def _network_gateway_ip() -> str:
    client = docker.from_env()
    if not client.networks.list(names=[NETWORK]):
        client.networks.create(NETWORK, driver="bridge", labels={ds.LABEL: "1"})
    net = client.networks.get(NETWORK)
    return net.attrs["IPAM"]["Config"][0]["Gateway"]


@pytest.fixture
def project(monkeypatch: pytest.MonkeyPatch):
    name = f"test-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(ds, "current_project", lambda: name)
    yield name
    client = docker.from_env()
    for c in client.containers.list(all=True, filters={"label": f"hq.project={name}"}):
        c.remove(force=True)
    try:
        client.volumes.get(f"hq-ws-{name}").remove(force=True)
    except docker.errors.NotFound:
        pass


def _settings(**overrides) -> SandboxSettings:
    base = dict(
        image=IMAGE, docker_hosts=(SOCK,), network=NETWORK, mem_limit="512m", cpus=0.5,
        pids_limit=128, default_timeout=60, max_output_bytes=20_000,
    )
    return SandboxSettings(**{**base, **overrides})


# ------------------------------------------------------------------- git e2e
@pytest.fixture
def github(tmp_path: Path):
    with FakeGitHub(tmp_path / "upstream", TOKEN) as fake:
        fake.create_repo("me", "app")
        yield fake


def test_sandbox_clones_and_pushes_through_gateway_without_a_token(github, project, tmp_path: Path) -> None:
    gw_ip = _network_gateway_ip()
    config = GatewayConfig(
        secret=SECRET, tokens={"github.com": TOKEN}, allowed_repos=("me/*",),
        upstreams={"github.com": github.url}, audit_path=tmp_path / "audit.jsonl",
    )
    with run_gateway(config, host="0.0.0.0") as port:
        sandbox = ds.DockerSandbox(_settings(git_gateway_url=f"http://{gw_ip}:{port}", git_gateway_secret=SECRET))

        work = sandbox.execute(
            "git clone -q https://github.com/me/app.git && cd app && git switch -q -c hq/add-notes "
            "&& echo notes > NOTES.md && git add . && git commit -q -m 'Add notes' "
            "&& git push -q -u origin hq/add-notes && git log -1 --format=%an"
        )
        assert work.exit_code == 0, work.output
        assert work.output.strip().endswith("HQ Agent")
        assert github.branches("me", "app") == ["hq/add-notes", "main"]

        main = sandbox.execute("cd app && git push origin HEAD:main")
        assert main.exit_code != 0
        assert "HQ only pushes branches under hq/" in main.output
        assert github.branches("me", "app") == ["hq/add-notes", "main"]

        # Nothing inside the sandbox knows the token: not the env, not git config, not the repo.
        leak = sandbox.execute(f"env; git config --list; cat app/.git/config; grep -rs '{TOKEN}' /workspace /home/agent /tmp /etc | head -1")
        assert TOKEN not in leak.output

        # SSH-style URLs are routed too, so copy-pasted clone commands just work.
        ssh = sandbox.execute("git ls-remote git@github.com:me/app.git | grep -c refs/heads")
        assert ssh.output.strip() == "2"

    pushed = [e for e in read_audit(config.audit_path) if e.get("service") == "git-receive-pack"]
    assert {e["decision"] for e in pushed} == {"forwarded", "denied"}


def test_config_change_recreates_container_but_keeps_workspace(project) -> None:
    first = ds.DockerSandbox(_settings(git_gateway_url="http://gw-one:8080"))
    first.upload_files([("/workspace/keep.txt", b"still here")])
    before = docker.from_env().containers.get(f"hq-sbx-{project}").id

    second = ds.DockerSandbox(_settings(git_gateway_url="http://gw-two:8080"))
    res = second.execute("cat keep.txt; echo; printenv HQ_GIT_GATEWAY")
    assert res.output.split() == ["still", "here", "http://gw-two:8080"]
    rebuilt = docker.from_env().containers.get(f"hq-sbx-{project}").id
    assert rebuilt != before

    # Same settings again: the container is reused, not rebuilt.
    second.execute("true")
    assert docker.from_env().containers.get(f"hq-sbx-{project}").id == rebuilt


# -------------------------------------------------------------------- reaper
def _reaper(tmp_path: Path, offset: float, **settings) -> SandboxReaper:
    return SandboxReaper(
        _settings(**settings),
        Pins(tmp_path / "pins.json"),
        clock=lambda: time.time() + offset,
        client_factory=lambda host: docker.from_env(),
    )


def _status(project: str) -> str:
    container = docker.from_env().containers.get(f"hq-sbx-{project}")
    return container.status


def test_reaper_stops_idle_then_removes_and_workspace_survives(project, tmp_path: Path) -> None:
    sandbox = ds.DockerSandbox(_settings())
    sandbox.upload_files([("/workspace/work.txt", b"precious")])
    name = f"hq-sbx-{project}"

    fresh = _reaper(tmp_path, offset=60, idle_stop_minutes=5).reap_once()
    assert any(k["name"] == name for k in fresh.hosts[SOCK]["kept"])
    assert _status(project) == "running"

    dry = _reaper(tmp_path, offset=600, idle_stop_minutes=5).reap_once(dry_run=True)
    assert [s["name"] for s in dry.hosts[SOCK]["stopped"] if s["name"] == name] == [name]
    assert _status(project) == "running"  # dry run changed nothing

    _reaper(tmp_path, offset=600, idle_stop_minutes=5).reap_once()
    assert _status(project) == "exited"

    removal = _reaper(tmp_path, offset=3 * 3600, idle_stop_minutes=5, idle_remove_hours=2).reap_once()
    assert name in [r["name"] for r in removal.hosts[SOCK]["removed"]]
    assert not docker.from_env().containers.list(all=True, filters={"name": f"^{name}$"})
    assert docker.from_env().volumes.get(f"hq-ws-{project}")  # volume kept

    # Next use recreates the container with the old workspace.
    assert sandbox.execute("cat work.txt").output == "precious"


def test_reaper_never_stops_a_busy_or_pinned_sandbox(project, tmp_path: Path) -> None:
    sandbox = ds.DockerSandbox(_settings())
    sandbox.execute("true")
    name = f"hq-sbx-{project}"

    with ds.ACTIVITY.busy(SOCK, name):
        report = _reaper(tmp_path, offset=99_999, idle_stop_minutes=1).reap_once()
    assert {"name": name, "why": "command running"} in report.hosts[SOCK]["kept"]
    assert _status(project) == "running"

    reaper = _reaper(tmp_path, offset=600, idle_stop_minutes=1)
    reaper.pins.pin(project, hours=1)
    report = reaper.reap_once()
    assert {"name": name, "why": "pinned"} in report.hosts[SOCK]["kept"]
    reaper.pins.unpin(project)
    reaper.reap_once()
    assert _status(project) == "exited"


def test_execute_recovers_when_reaper_stopped_the_container_mid_lookup(project, tmp_path: Path) -> None:
    sandbox = ds.DockerSandbox(_settings())
    sandbox.execute("true")
    container = docker.from_env().containers.get(f"hq-sbx-{project}")
    real_container = sandbox._container

    def stale_lookup(*args, **kwargs):  # hand back the container, then the reaper stops it
        found, host = real_container(*args, **kwargs)
        container.stop(timeout=1)
        return found, host

    sandbox._container = stale_lookup
    res = sandbox.execute("echo alive")
    assert res.exit_code == 0 and res.output.strip() == "alive"


def test_unreachable_host_is_reported_not_fatal(tmp_path: Path) -> None:
    reaper = SandboxReaper(_settings(docker_hosts=("tcp://127.0.0.1:1", SOCK)), Pins(tmp_path / "p.json"))
    result = reaper.reap_once(dry_run=True)
    assert result.hosts["tcp://127.0.0.1:1"]["reachable"] is False
    assert result.hosts[SOCK]["reachable"] is True


def test_parse_docker_time() -> None:
    assert parse_docker_time("0001-01-01T00:00:00Z") is None
    assert parse_docker_time(None) is None
    from datetime import datetime, timezone

    expected = datetime(2026, 10, 7, 22, 31, 21, 123456, tzinfo=timezone.utc).timestamp()
    assert parse_docker_time("2026-10-07T22:31:21.123456789Z") == pytest.approx(expected)
