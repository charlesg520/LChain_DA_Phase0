"""Git gateway tests: a real git client -> the gateway -> a real git smart-HTTP server."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from hq_agent.git_gateway import (
    GatewayConfig,
    ProtocolError,
    create_app,
    parse_push_commands,
    pkt,
    read_audit,
    rejection_report,
)
from tests.gitserver import FakeGitHub, run_gateway

TOKEN = "ghp_test_token_never_in_a_sandbox"
SECRET = "s" * 40
OID_A, OID_B, ZERO = "a" * 40, "b" * 40, "0" * 40


# ------------------------------------------------------------------ unit level
def test_parse_push_commands_reads_refs_and_capabilities() -> None:
    body = pkt(f"{OID_A} {OID_B} refs/heads/hq/x\0report-status side-band-64k\n".encode())
    body += pkt(f"{ZERO} {OID_B} refs/heads/hq/y\n".encode()) + b"0000PACKDATA"
    parsed = parse_push_commands(body)
    assert parsed is not None
    assert parsed.commands == [(OID_A, OID_B, "refs/heads/hq/x"), (ZERO, OID_B, "refs/heads/hq/y")]
    assert {"report-status", "side-band-64k"} <= parsed.capabilities


def test_parse_push_commands_waits_for_flush_and_rejects_garbage() -> None:
    partial = pkt(f"{OID_A} {OID_B} refs/heads/hq/x\n".encode())
    assert parse_push_commands(partial) is None
    assert parse_push_commands(partial[:10]) is None
    assert parse_push_commands(b"0000").commands == []  # git's empty probe request
    with pytest.raises(ProtocolError):
        parse_push_commands(b"zzzz")
    with pytest.raises(ProtocolError):
        parse_push_commands(pkt(b"push-cert\0caps\n") + b"0000")


def test_rejection_report_uses_sideband_when_asked() -> None:
    push = parse_push_commands(pkt(f"{OID_A} {OID_B} refs/heads/main\0report-status side-band-64k\n".encode()) + b"0000")
    out = rejection_report(push, {"refs/heads/main": "nope"}, "banner")
    assert b"\x02banner" in out and b"ng refs/heads/main nope" in out
    plain = parse_push_commands(pkt(f"{OID_A} {OID_B} refs/heads/main\0report-status\n".encode()) + b"0000")
    assert rejection_report(plain, {"refs/heads/main": "nope"}, "banner").startswith(pkt(b"unpack ok\n"))


def test_repo_allowlist_is_case_insensitive_globs() -> None:
    cfg = GatewayConfig(secret=SECRET, allowed_repos=("charlesg520/*", "acme/site"))
    assert cfg.repo_allowed("CharlesG520", "anything")
    assert cfg.repo_allowed("acme", "Site")
    assert not cfg.repo_allowed("acme", "other")
    assert not GatewayConfig(secret=SECRET).repo_allowed("a", "b")  # empty allowlist allows nothing


def test_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_GATEWAY_SECRET", SECRET)
    monkeypatch.setenv("GIT_GATEWAY_GITHUB_TOKEN", TOKEN)
    monkeypatch.setenv("GIT_GATEWAY_ALLOWED_REPOS", "Me/*, acme/site")
    monkeypatch.setenv("GIT_GATEWAY_UPSTREAMS", "github.com=http://127.0.0.1:1")
    cfg = GatewayConfig.from_env()
    assert cfg.tokens == {"github.com": TOKEN}
    assert cfg.allowed_repos == ("me/*", "acme/site")
    assert cfg.upstream_base("github.com") == "http://127.0.0.1:1"
    assert cfg.push_prefix == "hq/"


# ------------------------------------------------------------- end to end
@pytest.fixture
def github(tmp_path: Path):
    with FakeGitHub(tmp_path / "upstream", TOKEN) as fake:
        fake.create_repo("me", "app")
        fake.create_repo("private", "secret-sauce")
        fake.create_repo("someone", "public-lib")
        yield fake


@pytest.fixture
def gateway(github: FakeGitHub, tmp_path: Path):
    config = GatewayConfig(
        secret=SECRET,
        tokens={"github.com": TOKEN},
        allowed_repos=("me/*", "private/*"),
        upstreams={"github.com": github.url},
        audit_path=tmp_path / "audit" / "git.jsonl",
    )
    with run_gateway(config) as port:
        yield f"http://127.0.0.1:{port}", config


def _git(cwd: Path | None, gateway_url: str, *args: str, secret: str = SECRET) -> subprocess.CompletedProcess:
    """Run git exactly the way a sandbox does: GitHub URLs rewritten to the gateway, secret header added."""
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "HOME": str(cwd or Path.cwd()),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": f"url.{gateway_url}/github.com/.insteadOf",
        "GIT_CONFIG_VALUE_0": "https://github.com/",
        "GIT_CONFIG_KEY_1": f"http.{gateway_url}/.extraHeader",
        "GIT_CONFIG_VALUE_1": f"X-HQ-Gateway: {secret}",
        "GIT_CONFIG_KEY_2": "user.email",
        "GIT_CONFIG_VALUE_2": "hq@test",
        "GIT_AUTHOR_NAME": "HQ Agent",
        "GIT_COMMITTER_NAME": "HQ Agent",
    }
    return subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=60)


def _clone_and_commit(tmp_path: Path, gw: str, repo: str) -> Path:
    dest = tmp_path / "work" / repo.replace("/", "_")
    res = _git(None, gw, "clone", "-q", f"https://github.com/{repo}.git", str(dest))
    assert res.returncode == 0, res.stderr
    (dest / "change.txt").write_text("agent work\n")
    assert _git(dest, gw, "add", ".").returncode == 0
    assert _git(dest, gw, "commit", "-q", "-m", "agent change").returncode == 0
    return dest


def test_clone_private_repo_uses_token_server_side(github, gateway, tmp_path: Path) -> None:
    gw, _ = gateway
    dest = tmp_path / "clone"
    res = _git(None, gw, "clone", "-q", "https://github.com/private/secret-sauce.git", str(dest))
    assert res.returncode == 0, res.stderr
    assert (dest / "README.md").exists()
    # The remote stays a normal GitHub URL; only the transport goes through the gateway.
    stored = _git(dest, gw, "config", "--get", "remote.origin.url").stdout.strip()
    assert stored == "https://github.com/private/secret-sauce.git"
    # And the token never touched the client side.
    assert TOKEN not in (dest / ".git" / "config").read_text()


def test_public_repo_outside_allowlist_clones_anonymously(github, gateway, tmp_path: Path) -> None:
    gw, config = gateway
    res = _git(None, gw, "clone", "-q", "https://github.com/someone/public-lib.git", str(tmp_path / "lib"))
    assert res.returncode == 0, res.stderr
    assert all(not authed for path, authed in github.seen_auth if path.startswith("/someone/"))
    events = read_audit(config.audit_path)
    assert any(e["repo"] == "someone/public-lib" and e["authenticated"] is False for e in events)


def test_push_to_hq_branch_goes_through(github, gateway, tmp_path: Path) -> None:
    gw, config = gateway
    work = _clone_and_commit(tmp_path, gw, "me/app")
    res = _git(work, gw, "push", "-u", "origin", "HEAD:refs/heads/hq/add-change")
    assert res.returncode == 0, res.stderr
    assert github.branches("me", "app") == ["hq/add-change", "main"]
    push = next(e for e in read_audit(config.audit_path) if e.get("service") == "git-receive-pack" and e["decision"] == "forwarded")
    assert push["refs"] == ["refs/heads/hq/add-change"] and push["authenticated"] is True


def test_push_to_main_is_refused_with_a_readable_reason(github, gateway, tmp_path: Path) -> None:
    gw, config = gateway
    work = _clone_and_commit(tmp_path, gw, "me/app")
    res = _git(work, gw, "push", "origin", "HEAD:main")
    assert res.returncode != 0
    assert "remote rejected" in res.stderr and "HQ only pushes branches under hq/" in res.stderr
    assert github.branches("me", "app") == ["main"]
    # Upstream never saw a receive-pack POST.
    assert not any(path.endswith("git-receive-pack") for path, _ in github.seen_auth)
    assert any(e["decision"] == "denied" and e["refs"] == ["refs/heads/main"] for e in read_audit(config.audit_path))


def test_mixed_push_is_refused_entirely(github, gateway, tmp_path: Path) -> None:
    gw, _ = gateway
    work = _clone_and_commit(tmp_path, gw, "me/app")
    res = _git(work, gw, "push", "origin", "HEAD:refs/heads/hq/ok", "HEAD:refs/heads/release")
    assert res.returncode != 0
    assert github.branches("me", "app") == ["main"]


def test_push_to_repo_outside_allowlist_is_refused(github, gateway, tmp_path: Path) -> None:
    gw, _ = gateway
    work = _clone_and_commit(tmp_path, gw, "someone/public-lib")
    res = _git(work, gw, "push", "origin", "HEAD:refs/heads/hq/sneaky")
    assert res.returncode != 0 and "403" in res.stderr
    assert github.branches("someone", "public-lib") == ["main"]


def test_requests_without_the_gateway_secret_are_refused(github, gateway, tmp_path: Path) -> None:
    gw, _ = gateway
    res = _git(None, gw, "clone", "-q", "https://github.com/me/app.git", str(tmp_path / "x"), secret="wrong-secret-" + "x" * 30)
    assert res.returncode != 0 and "403" in res.stderr


def test_private_repo_outside_allowlist_explains_itself(github, gateway, tmp_path: Path) -> None:
    gw, config = gateway
    narrow = GatewayConfig(**{**config.__dict__, "allowed_repos": ("me/*",)})
    with run_gateway(narrow) as port:
        res = _git(None, f"http://127.0.0.1:{port}", "clone", "-q", "https://github.com/private/secret-sauce.git", str(tmp_path / "p"))
    assert res.returncode != 0 and "403" in res.stderr and "Username" not in res.stderr
    denied = read_audit(config.audit_path)[0]
    assert "not in GIT_GATEWAY_ALLOWED_REPOS" in denied["reason"]


def test_gateway_fails_closed_without_a_secret(tmp_path: Path) -> None:
    from starlette.testclient import TestClient

    client = TestClient(create_app(GatewayConfig(secret="")))
    assert client.get("/github.com/me/app.git/info/refs?service=git-upload-pack").status_code == 503
    assert client.get("/healthz").json()["secret_configured"] is False


def test_dumb_protocol_and_unknown_hosts_are_refused(tmp_path: Path) -> None:
    from starlette.testclient import TestClient

    client = TestClient(create_app(GatewayConfig(secret=SECRET)))
    h = {"X-HQ-Gateway": SECRET}
    assert client.get("/github.com/me/app.git/info/refs", headers=h).status_code == 403
    assert client.get("/evil.example/me/app.git/info/refs?service=git-upload-pack", headers=h).status_code == 404
    assert client.get("/github.com/../../etc/passwd", headers=h).status_code == 404


def test_audit_log_rotates_and_reads_newest_first(tmp_path: Path) -> None:
    from hq_agent import git_gateway as gg

    path = tmp_path / "a.jsonl"
    log = gg.AuditLog(path)
    for i in range(3):
        log.write(i=i)
    assert [e["i"] for e in read_audit(path)] == [2, 1, 0]
    path.write_text("x" * (gg._AUDIT_ROTATE_BYTES + 1))
    log.write(i=99)
    assert path.with_suffix(".jsonl.1").exists()
    assert [e["i"] for e in read_audit(path)] == [99]
    assert json.loads(path.read_text())["i"] == 99


async def test_gzipped_command_list_is_bounded() -> None:
    import gzip

    from hq_agent import git_gateway as gg

    async def chunks(data: bytes):
        for i in range(0, len(data), 4096):
            yield data[i : i + 4096]

    line = pkt(f"{OID_A} {OID_B} refs/heads/hq/x\n".encode())
    bomb = gzip.compress(line * ((50 << 20) // len(line)))  # 50 MB of command lines, never a flush: ~100 KB gzipped
    assert len(bomb) < 1 << 20
    with pytest.raises(ProtocolError):
        await gg._read_push_commands(chunks(bomb).__aiter__(), gzipped=True)

    good = gzip.compress(pkt(f"{OID_A} {OID_B} refs/heads/hq/x\0report-status\n".encode()) + b"0000PACK")
    _, parsed = await gg._read_push_commands(chunks(good).__aiter__(), gzipped=True)
    assert parsed.commands == [(OID_A, OID_B, "refs/heads/hq/x")]


def test_dot_only_repo_names_are_refused() -> None:
    from starlette.testclient import TestClient

    client = TestClient(create_app(GatewayConfig(secret=SECRET, allowed_repos=("me/*",))))
    for repo in ["..", ".", "..."]:
        r = client.get(f"/github.com/me/{repo}.git/info/refs?service=git-upload-pack", headers={"X-HQ-Gateway": SECRET})
        assert r.status_code == 404, repo
