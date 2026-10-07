"""Idle sandbox reaper.

Every few minutes, on every configured Docker host (not just the active one,
since VPS containers keep running after the agent fails over to your home
machine):

- **Stop** a running sandbox that has been idle longer than the stop threshold.
  Idle means no command, upload or download from the agent. A command that is
  still running always counts as activity, so long backtests are never cut off.
- **Remove** a stopped sandbox after the remove threshold. The next call
  recreates it from the current image.
- **Never** touch `/workspace` volumes. Work survives every stop and removal.

Background processes the agent started with `nohup` die when a sandbox is
stopped. Pin a project (ops API) to keep it running longer.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import docker

from hq_agent.backends.docker_sandbox import ACTIVITY, LABEL, PROCESS_STARTED, ActivityTracker
from hq_agent.config import SandboxSettings

logger = logging.getLogger(__name__)


def parse_docker_time(raw: str | None) -> float | None:
    """Docker timestamps have nanoseconds and 'Z'; the zero value means 'never'."""
    if not raw or raw.startswith("0001-01-01"):
        return None
    raw = raw.rstrip("Z")
    main, _, frac = raw.partition(".")
    try:
        return datetime.fromisoformat(f"{main}.{(frac + '000000')[:6]}+00:00").timestamp()
    except ValueError:
        return None


class Pins:
    """Projects the reaper must leave running until a given time. Stored as JSON in the data dir."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict[str, float]:
        try:
            return {k: float(v) for k, v in json.loads(self.path.read_text()).items()}
        except (OSError, ValueError, AttributeError):
            return {}

    def active(self, now: float | None = None) -> dict[str, float]:
        now = now or time.time()
        return {project: until for project, until in self._load().items() if until > now}

    def pin(self, project: str, hours: float) -> float:
        with self._lock:
            pins = self.active()
            pins[project] = time.time() + hours * 3600
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(pins, indent=2))
            return pins[project]

    def unpin(self, project: str) -> None:
        with self._lock:
            pins = self.active()
            pins.pop(project, None)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(pins, indent=2))


@dataclass
class ReapResult:
    started_at: float
    dry_run: bool
    hosts: dict[str, dict[str, Any]] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"started_at": self.started_at, "dry_run": self.dry_run, "hosts": self.hosts}


class SandboxReaper:
    def __init__(
        self,
        settings: SandboxSettings,
        pins: Pins,
        *,
        tracker: ActivityTracker = ACTIVITY,
        clock: Any = time.time,
        client_factory: Any = None,
    ) -> None:
        self.settings = settings
        self.pins = pins
        self.tracker = tracker
        self.clock = clock
        self._client_factory = client_factory or (lambda host: docker.DockerClient(base_url=host, timeout=15))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_result: ReapResult | None = None

    # ----------------------------------------------------------------- policy
    def idle_seconds(self, host: str, container: Any, now: float) -> float:
        """Seconds since the agent last used this container (or since it/this process started)."""
        state = container.attrs.get("State", {})
        started = parse_docker_time(state.get("StartedAt")) or 0.0
        last = max(self.tracker.last_used(host, container.name) or 0.0, started, PROCESS_STARTED)
        return max(0.0, now - last)

    def reap_host(self, host: str, *, dry_run: bool = False) -> dict[str, Any]:
        now = self.clock()
        report: dict[str, Any] = {"reachable": True, "stopped": [], "removed": [], "kept": [], "errors": []}
        try:
            client = self._client_factory(host)
        except Exception as exc:  # noqa: BLE001 - an asleep home machine is normal
            return {"reachable": False, "error": str(exc)}
        try:
            return self._sweep(client, host, now, report, dry_run=dry_run)
        except Exception as exc:  # noqa: BLE001
            return {"reachable": False, "error": str(exc)}
        finally:
            client.close()

    def _sweep(self, client: Any, host: str, now: float, report: dict[str, Any], *, dry_run: bool) -> dict[str, Any]:
        containers = client.containers.list(all=True, filters={"label": f"{LABEL}=1"})

        pinned = self.pins.active(now)
        stop_after = self.settings.idle_stop_seconds(host)
        remove_after = self.settings.idle_remove_hours * 3600
        for container in containers:
            project = container.labels.get("hq.project", "")
            name = container.name
            try:
                if container.status == "running":
                    idle = self.idle_seconds(host, container, now)
                    if self.tracker.is_busy(host, name):
                        report["kept"].append({"name": name, "why": "command running"})
                    elif project in pinned:
                        report["kept"].append({"name": name, "why": "pinned"})
                    elif stop_after > 0 and idle >= stop_after:
                        if not dry_run:
                            container.stop(timeout=10)
                        report["stopped"].append({"name": name, "idle_s": round(idle)})
                    else:
                        report["kept"].append({"name": name, "why": f"idle {round(idle)}s"})
                else:
                    finished = parse_docker_time(container.attrs.get("State", {}).get("FinishedAt"))
                    stopped_for = now - finished if finished else now - PROCESS_STARTED
                    if remove_after > 0 and stopped_for >= remove_after and not self.tracker.is_busy(host, name):
                        if not dry_run:
                            container.remove()  # the /workspace volume is NOT removed
                            self.tracker.forget(host, name)
                        report["removed"].append({"name": name, "stopped_s": round(stopped_for)})
                    else:
                        report["kept"].append({"name": name, "why": f"stopped {round(stopped_for)}s"})
            except Exception as exc:  # noqa: BLE001 - one bad container mustn't stop the sweep
                report["errors"].append({"name": name, "error": str(exc)})
        return report

    def inventory(self) -> dict[str, Any]:
        """Every sandbox on every host with its idle time, for the ops API and dashboard."""
        now = self.clock()
        pinned = self.pins.active(now)
        hosts: dict[str, Any] = {}
        for host in self.settings.docker_hosts:
            try:
                client = self._client_factory(host)
            except Exception as exc:  # noqa: BLE001
                hosts[host] = {"reachable": False, "error": str(exc)}
                continue
            try:
                rows = []
                for c in client.containers.list(all=True, filters={"label": f"{LABEL}=1"}):
                    project = c.labels.get("hq.project", "")
                    running = c.status == "running"
                    rows.append(
                        {
                            "name": c.name,
                            "project": project,
                            "status": c.status,
                            "idle_s": round(self.idle_seconds(host, c, now)) if running else None,
                            "busy": self.tracker.is_busy(host, c.name),
                            "pinned_until": pinned.get(project),
                        }
                    )
                hosts[host] = {
                    "reachable": True,
                    "stop_after_s": self.settings.idle_stop_seconds(host),
                    "sandboxes": rows,
                }
            except Exception as exc:  # noqa: BLE001
                hosts[host] = {"reachable": False, "error": str(exc)}
            finally:
                client.close()
        return {
            "reaper": {
                "enabled": self.settings.reaper_enabled,
                "running": bool(self._thread and self._thread.is_alive()),
                "interval_s": self.settings.reaper_interval_s,
                "idle_stop_minutes": self.settings.idle_stop_minutes,
                "idle_remove_hours": self.settings.idle_remove_hours,
                "last_sweep": self.last_result.as_dict() if self.last_result else None,
            },
            "hosts": hosts,
        }

    def act(self, project: str, action: str, host: str | None = None, *, remove_workspace: bool = False) -> list[str]:
        """Stop or remove one project's sandbox (on one host, or wherever it exists)."""
        done = []
        for h in [host] if host else list(self.settings.docker_hosts):
            if h not in self.settings.docker_hosts:
                raise ValueError(f"unknown docker host {h!r}")
            try:
                client = self._client_factory(h)
            except Exception:  # noqa: BLE001
                continue
            try:
                for c in client.containers.list(all=True, filters={"label": f"hq.project={project}"}):
                    if c.labels.get(LABEL) != "1":
                        continue
                    if action == "stop":
                        c.stop(timeout=10)
                    elif action == "remove":
                        c.remove(force=True)
                        self.tracker.forget(h, c.name)
                    done.append(f"{action} {c.name} on {h}")
                if action == "remove" and remove_workspace:
                    try:
                        client.volumes.get(f"hq-ws-{project}").remove()
                        done.append(f"deleted workspace hq-ws-{project} on {h}")
                    except docker.errors.NotFound:
                        pass
            finally:
                client.close()
        return done

    def reap_once(self, *, dry_run: bool = False) -> ReapResult:
        result = ReapResult(started_at=self.clock(), dry_run=dry_run)
        for host in self.settings.docker_hosts:
            result.hosts[host] = self.reap_host(host, dry_run=dry_run)
        acted = sum(len(h.get("stopped", [])) + len(h.get("removed", [])) for h in result.hosts.values())
        if acted:
            logger.info("reaper %s: %s", "dry run" if dry_run else "sweep", json.dumps(result.hosts))
        if not dry_run:
            self.last_result = result
        return result

    # --------------------------------------------------------------- lifecycle
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="hq-sandbox-reaper", daemon=True)
        self._thread.start()
        logger.info(
            "sandbox reaper started: stop after %.0f min idle, remove after %.0f h stopped, every %ds",
            self.settings.idle_stop_minutes, self.settings.idle_remove_hours, self.settings.reaper_interval_s,
        )

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.wait(self.settings.reaper_interval_s):
            try:
                self.reap_once()
            except Exception:  # noqa: BLE001
                logger.exception("reaper sweep failed")


_REAPER: SandboxReaper | None = None


def get_reaper(settings: SandboxSettings, data_dir: Path) -> SandboxReaper:
    """Process-wide reaper (the ops API and the server lifespan share it)."""
    global _REAPER
    pins = data_dir / "sandbox-pins.json"
    if _REAPER is None or _REAPER.settings != settings or _REAPER.pins.path != pins:
        if _REAPER is not None:
            _REAPER.stop()
        _REAPER = SandboxReaper(settings, Pins(pins))
    return _REAPER
