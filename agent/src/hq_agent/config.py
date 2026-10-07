"""Runtime configuration, read once from environment variables.

Everything the stack can be tuned with lives here so the UI (Phase 2) can show
it and a single `.env` file drives both local dev and the VPS.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    return float(raw) if raw else default


@dataclass(frozen=True)
class ModelRouting:
    """Which model each role uses. Values are `provider:model` strings.

    `ollama:` models are served from your home machine over Tailscale. Any role
    whose primary model is local gets `fallback` so it keeps working when the
    home machine is asleep.
    """

    orchestrator: str = field(default_factory=lambda: _env("MODEL_ORCHESTRATOR", "anthropic:claude-sonnet-5"))
    coder: str = field(default_factory=lambda: _env("MODEL_CODER", "anthropic:claude-sonnet-5"))
    reviewer: str = field(default_factory=lambda: _env("MODEL_REVIEWER", "anthropic:claude-opus-5-5"))
    researcher: str = field(default_factory=lambda: _env("MODEL_RESEARCHER", "ollama:qwen3:14b"))
    fallback: str = field(default_factory=lambda: _env("MODEL_FALLBACK", "anthropic:claude-haiku-4-5-20251001"))
    ollama_base_url: str = field(default_factory=lambda: _env("OLLAMA_BASE_URL", ""))


@dataclass(frozen=True)
class SandboxSettings:
    """Docker sandbox limits. Defaults are sized for a 2 vCPU / 8 GB VPS."""

    enabled: bool = field(default_factory=lambda: _env_bool("SANDBOX_ENABLED", True))
    image: str = field(default_factory=lambda: _env("SANDBOX_IMAGE", "hq-sandbox:latest"))
    # Tried in order. Put your home machine's Tailscale docker proxy first, the
    # VPS-local proxy last, e.g. "tcp://100.64.0.2:2375,tcp://docker-proxy:2375".
    docker_hosts: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            h.strip() for h in _env("SANDBOX_DOCKER_HOSTS", "unix:///var/run/docker.sock").split(",") if h.strip()
        )
    )
    network: str = field(default_factory=lambda: _env("SANDBOX_NETWORK", "hq-sandbox"))
    mem_limit: str = field(default_factory=lambda: _env("SANDBOX_MEM", "1536m"))
    cpus: float = field(default_factory=lambda: _env_float("SANDBOX_CPUS", 1.0))
    pids_limit: int = field(default_factory=lambda: _env_int("SANDBOX_PIDS", 512))
    default_timeout: int = field(default_factory=lambda: _env_int("SANDBOX_TIMEOUT", 300))
    max_output_bytes: int = field(default_factory=lambda: _env_int("SANDBOX_MAX_OUTPUT", 100_000))


@dataclass(frozen=True)
class Settings:
    models: ModelRouting = field(default_factory=ModelRouting)
    sandbox: SandboxSettings = field(default_factory=SandboxSettings)
    data_dir: Path = field(default_factory=lambda: Path(_env("HQ_DATA_DIR", "/data")))
    skills_dir: Path = field(default_factory=lambda: Path(_env("HQ_SKILLS_DIR", "/data/skills")))
    searxng_url: str = field(default_factory=lambda: _env("SEARXNG_URL", ""))
    enable_todos: bool = field(default_factory=lambda: _env_bool("ENABLE_TODOS", False))
    require_skill_approval: bool = field(default_factory=lambda: _env_bool("REQUIRE_SKILL_APPROVAL", True))

    @property
    def memories_dir(self) -> Path:
        return self.data_dir / "memories"


def load_settings() -> Settings:
    return Settings()
