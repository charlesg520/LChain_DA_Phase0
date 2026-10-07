"""Self-hosted Docker sandbox backend for deepagents.

Replaces paid sandbox providers. Each *project* gets its own long-lived
container with a persistent `/workspace` volume, hard resource caps, no Linux
capabilities, a read-only root filesystem, and a network that cannot reach the
agent's database or internal services.

Which project a call belongs to is read from the run config
(`config["configurable"]["project"]`), so one backend instance can serve every
thread. deepagents 0.7 removed backend factories, which is why the routing
happens here at call time instead.

Docker hosts are tried in order (e.g. your home machine over Tailscale first,
then the VPS). Workspaces are per host, so git is the way to move work between
them.

Git inside a sandbox goes through the git gateway (see git_gateway.py): GitHub
URLs are rewritten to the gateway with GIT_CONFIG_* env vars, so plain
`git clone/push` works and no credential ever enters the container.

Containers carry a fingerprint of the settings they were created with. When the
settings or the sandbox image change, the next call recreates the container;
the `/workspace` volume is kept, so no work is lost.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import logging
import re
import tarfile
import threading
import time
from collections import Counter
from collections.abc import Iterator
from pathlib import PurePosixPath
from typing import Any

import docker
from docker.errors import APIError, DockerException, ImageNotFound, NotFound
from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox
from langgraph.config import get_config

from hq_agent.config import SandboxSettings

logger = logging.getLogger(__name__)

WORKSPACE = "/workspace"
SANDBOX_UID = 1000
LABEL = "hq.sandbox"
CONFIG_LABEL = "hq.config"
_TIMEOUT_EXIT = 124  # exit code from coreutils `timeout`
_HOST_RECHECK_SECONDS = 60
PROCESS_STARTED = time.time()


class ActivityTracker:
    """Last-use time and in-flight commands per sandbox container, shared in-process.

    The idle reaper reads it so it never stops a container that is running a
    command, and measures idleness from the last real use instead of from when
    the container started.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: dict[tuple[str, str], float] = {}
        self._busy: Counter[tuple[str, str]] = Counter()

    def touch(self, host: str, name: str) -> None:
        with self._lock:
            self._last[(host, name)] = time.time()

    @contextlib.contextmanager
    def busy(self, host: str, name: str) -> Iterator[None]:
        key = (host, name)
        with self._lock:
            self._busy[key] += 1
            self._last[key] = time.time()
        try:
            yield
        finally:
            with self._lock:
                self._busy[key] -= 1
                if self._busy[key] <= 0:
                    del self._busy[key]
                self._last[key] = time.time()

    def last_used(self, host: str, name: str) -> float | None:
        with self._lock:
            return self._last.get((host, name))

    def is_busy(self, host: str, name: str) -> bool:
        with self._lock:
            return self._busy.get((host, name), 0) > 0

    def forget(self, host: str, name: str) -> None:
        with self._lock:
            self._last.pop((host, name), None)


ACTIVITY = ActivityTracker()


def project_slug(raw: str | None) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", (raw or "default").lower()).strip("-")
    return (slug or "default")[:40]


def current_project() -> str:
    """Project for the current run, from `configurable.project` (default: 'default')."""
    try:
        cfg = get_config()
    except RuntimeError:  # called outside a graph run (tests, ops endpoints)
        return "default"
    return project_slug((cfg.get("configurable") or {}).get("project"))


def _clip(text: str, limit: int) -> tuple[str, bool]:
    """Keep the head and tail of long output; the tail usually holds the error."""
    if len(text) <= limit:
        return text, False
    head = limit // 3
    tail = limit - head
    skipped = len(text) - limit
    return f"{text[:head]}\n\n... [{skipped} characters clipped] ...\n\n{text[-tail:]}", True


class DockerSandbox(BaseSandbox):
    """`SandboxBackendProtocol` implementation backed by the Docker Engine API."""

    def __init__(self, settings: SandboxSettings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._client: docker.DockerClient | None = None
        self._host: str | None = None
        self._host_checked_at = 0.0
        self._image_ids: dict[str, tuple[str, float]] = {}

    # ------------------------------------------------------------------ hosts
    def _connect(self) -> tuple[docker.DockerClient, str]:
        """Return a client for the first reachable Docker host, re-checking periodically.

        Re-checking lets the agent move back to the home machine once it wakes up.
        """
        with self._lock:
            now = time.monotonic()
            preferred = self.settings.docker_hosts[0] if self.settings.docker_hosts else None
            fresh = now - self._host_checked_at < _HOST_RECHECK_SECONDS
            if self._client is not None and (fresh or self._host == preferred):
                return self._client, self._host  # type: ignore[return-value]

            errors: list[str] = []
            for host in self.settings.docker_hosts:
                try:
                    # Probe with a short timeout so an asleep home machine costs seconds, not minutes.
                    probe = docker.DockerClient(base_url=host, timeout=5)
                    probe.ping()
                    probe.close()
                    # Real client gets a generous timeout: exec streams stay open for the whole command.
                    client = docker.DockerClient(base_url=host, timeout=self.settings.default_timeout * 4 + 60)
                except Exception as exc:  # noqa: BLE001 - requests errors aren't always DockerException
                    errors.append(f"{host}: {exc}")
                    continue
                if self._host != host:
                    logger.info("sandbox using docker host %s", host)
                self._client, self._host, self._host_checked_at = client, host, now
                return client, host
            self._client, self._host = None, None
            raise RuntimeError("No Docker host reachable for sandboxes: " + "; ".join(errors))

    def _reset(self) -> None:
        with self._lock:
            self._client, self._host, self._host_checked_at = None, None, 0.0

    # -------------------------------------------------------------- container
    def git_env(self, host: str) -> dict[str, str]:
        """Environment that routes GitHub traffic through the git gateway for this host."""
        env = {
            "GIT_TERMINAL_PROMPT": "0",  # fail fast instead of hanging on a credential prompt
            "GIT_AUTHOR_NAME": self.settings.git_author_name,
            "GIT_AUTHOR_EMAIL": self.settings.git_author_email,
            "GIT_COMMITTER_NAME": self.settings.git_author_name,
            "GIT_COMMITTER_EMAIL": self.settings.git_author_email,
        }
        gateway = self.settings.gateway_for(host)
        if not gateway:
            return env
        pairs = [
            (f"url.{gateway}/github.com/.insteadOf", "https://github.com/"),
            (f"url.{gateway}/github.com/.insteadOf", "git@github.com:"),
            (f"url.{gateway}/github.com/.insteadOf", "ssh://git@github.com/"),
        ]
        if self.settings.git_gateway_secret:
            pairs.append((f"http.{gateway}/.extraHeader", f"X-HQ-Gateway: {self.settings.git_gateway_secret}"))
        env["GIT_CONFIG_COUNT"] = str(len(pairs))
        for i, (key, value) in enumerate(pairs):
            env[f"GIT_CONFIG_KEY_{i}"] = key
            env[f"GIT_CONFIG_VALUE_{i}"] = value
        env["HQ_GIT_GATEWAY"] = gateway
        return env

    def _run_spec(self, client: docker.DockerClient, host: str, slug: str) -> dict[str, Any]:
        return {
            "image": self.settings.image,
            "image_id": self._image_id(client, host),
            "network": self.settings.network,
            "mem_limit": self.settings.mem_limit,
            "nano_cpus": int(self.settings.cpus * 1_000_000_000),
            "pids_limit": self.settings.pids_limit,
            "environment": {"HOME": "/home/agent", "HQ_PROJECT": slug, **self.git_env(host)},
        }

    def _image_id(self, client: docker.DockerClient, host: str) -> str:
        """Image ID, cached briefly: it's part of the fingerprint, so a rebuilt image recreates sandboxes."""
        cached = self._image_ids.get(host)
        if cached and time.monotonic() - cached[1] < _HOST_RECHECK_SECONDS:
            return cached[0]
        image_id = client.images.get(self.settings.image).id
        self._image_ids[host] = (image_id, time.monotonic())
        return image_id

    @staticmethod
    def _fingerprint(spec: dict[str, Any]) -> str:
        return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]

    def _container(self, project: str | None = None) -> tuple[Any, str]:
        """The running container for this project on the active host, created if needed."""
        client, host = self._connect()
        slug = project or current_project()
        name = f"hq-sbx-{slug}"
        try:
            spec = self._run_spec(client, host, slug)
        except ImageNotFound as exc:
            raise RuntimeError(
                f"Sandbox image {self.settings.image!r} is missing on this Docker host. Run `make sandbox-image`."
            ) from exc
        fingerprint = self._fingerprint(spec)

        try:
            container = client.containers.get(name)
        except NotFound:
            container = None
        if container is not None:
            if container.labels.get(LABEL) != "1":
                raise RuntimeError(f"Refusing to use container {name!r}: it was not created by this sandbox backend")
            stale = container.labels.get(CONFIG_LABEL) != fingerprint
            if stale and not ACTIVITY.is_busy(host, name):
                # Settings or image changed: rebuild the container, keep the /workspace volume.
                logger.info("recreating sandbox %s (config changed)", name)
                container.remove(force=True)
            else:
                if container.status != "running":
                    container.start()
                    container.reload()
                return container, host

        self._ensure_network(client)
        container = client.containers.run(
            spec["image"],
            command=["sleep", "infinity"],
            name=name,
            detach=True,
            init=True,
            labels={LABEL: "1", "hq.project": slug, CONFIG_LABEL: fingerprint},
            user=f"{SANDBOX_UID}:{SANDBOX_UID}",
            working_dir=WORKSPACE,
            volumes={f"hq-ws-{slug}": {"bind": WORKSPACE, "mode": "rw"}},
            network=spec["network"],
            mem_limit=spec["mem_limit"],
            memswap_limit=spec["mem_limit"],  # no swap on top of the cap
            nano_cpus=spec["nano_cpus"],
            pids_limit=spec["pids_limit"],
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            read_only=True,
            tmpfs={
                "/tmp": "rw,size=512m",
                "/home/agent": f"rw,size=1g,uid={SANDBOX_UID},gid={SANDBOX_UID}",
            },
            environment=spec["environment"],
        )
        return container, host

    def _ensure_network(self, client: docker.DockerClient) -> None:
        """Sandboxes get internet (pip/npm/git) but share no network with Postgres or the agent."""
        if not client.networks.list(names=[self.settings.network]):
            client.networks.create(self.settings.network, driver="bridge", labels={LABEL: "1"})

    # ------------------------------------------------------- protocol methods
    @property
    def id(self) -> str:
        return f"docker:{current_project()}"

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        limit = int(timeout or self.settings.default_timeout)
        argv = ["timeout", "--kill-after=5", str(limit), "bash", "-lc", command]
        try:
            container, host = self._container()
            with ACTIVITY.busy(host, container.name):
                try:
                    result = container.exec_run(argv, workdir=WORKSPACE, user=f"{SANDBOX_UID}:{SANDBOX_UID}", demux=False)
                except APIError as exc:
                    # The idle reaper may have stopped the container between lookup and exec.
                    if "is not running" not in str(exc):
                        raise
                    container.start()
                    result = container.exec_run(argv, workdir=WORKSPACE, user=f"{SANDBOX_UID}:{SANDBOX_UID}", demux=False)
        except Exception as exc:  # noqa: BLE001 - surface every failure to the model as output
            if not isinstance(exc, (APIError, RuntimeError)):
                self._reset()  # connection-level failure: re-pick a host next time
            return ExecuteResponse(output=f"Sandbox error: {exc}", exit_code=None)

        output = (result.output or b"").decode("utf-8", errors="replace")
        exit_code = result.exit_code
        if exit_code == _TIMEOUT_EXIT:
            output += f"\n[command timed out after {limit}s]"
        output, truncated = _clip(output, self.settings.max_output_bytes)
        return ExecuteResponse(output=output, exit_code=exit_code, truncated=truncated)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        try:
            container, host = self._container()
        except Exception as exc:  # partial-success contract: report per file, never raise
            return [FileUploadResponse(path=p, error=f"sandbox unavailable: {exc}") for p, _ in files]
        ACTIVITY.touch(host, container.name)

        for raw_path, content in files:
            path = self._absolute(raw_path)
            parent, name = str(path.parent), path.name
            try:
                mk = container.exec_run(["mkdir", "-p", parent], user=f"{SANDBOX_UID}:{SANDBOX_UID}")
                if mk.exit_code != 0:
                    responses.append(FileUploadResponse(path=raw_path, error="permission_denied"))
                    continue
                if not container.put_archive(parent, self._tar_one(name, content)):
                    responses.append(FileUploadResponse(path=raw_path, error="permission_denied"))
                    continue
                responses.append(FileUploadResponse(path=raw_path))
            except (APIError, DockerException) as exc:
                responses.append(FileUploadResponse(path=raw_path, error=str(exc)))
        return responses

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        try:
            container, host = self._container()
        except Exception as exc:
            return [FileDownloadResponse(path=p, error=f"sandbox unavailable: {exc}") for p in paths]
        ACTIVITY.touch(host, container.name)

        for raw_path in paths:
            path = self._absolute(raw_path)
            try:
                stream, stat = container.get_archive(str(path))
            except NotFound:
                responses.append(FileDownloadResponse(path=raw_path, error="file_not_found"))
                continue
            except (APIError, DockerException) as exc:
                responses.append(FileDownloadResponse(path=raw_path, error=str(exc)))
                continue
            # Docker reports the mode with Go's FileMode bits; bit 31 marks a directory.
            if stat.get("mode", 0) & (1 << 31):
                responses.append(FileDownloadResponse(path=raw_path, error="is_directory"))
                continue
            with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
                member = next((m for m in tar.getmembers() if m.isfile()), None)
                extracted = tar.extractfile(member) if member else None
                if extracted is None:
                    responses.append(FileDownloadResponse(path=raw_path, error="file_not_found"))
                else:
                    responses.append(FileDownloadResponse(path=raw_path, content=extracted.read()))
        return responses

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _absolute(raw: str) -> PurePosixPath:
        path = PurePosixPath(raw)
        return path if path.is_absolute() else PurePosixPath(WORKSPACE) / path

    @staticmethod
    def _tar_one(name: str, content: bytes) -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            info = tarfile.TarInfo(name=name)
            info.size = len(content)
            info.mode = 0o644
            info.uid = info.gid = SANDBOX_UID
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(content))
        return buf.getvalue()

    # ------------------------------------------------------------- ops / UI
    def status(self) -> dict[str, Any]:
        """Snapshot for the ops API and dashboard."""
        try:
            client, host = self._connect()
        except RuntimeError as exc:
            return {"available": False, "error": str(exc), "hosts": list(self.settings.docker_hosts)}
        containers = client.containers.list(all=True, filters={"label": f"{LABEL}=1"})
        return {
            "available": True,
            "active_host": host,
            "hosts": list(self.settings.docker_hosts),
            "image": self.settings.image,
            "limits": {
                "mem": self.settings.mem_limit,
                "cpus": self.settings.cpus,
                "pids": self.settings.pids_limit,
                "timeout_s": self.settings.default_timeout,
            },
            "sandboxes": [
                {"name": c.name, "project": c.labels.get("hq.project"), "status": c.status} for c in containers
            ],
        }
