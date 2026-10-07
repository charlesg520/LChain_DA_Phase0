# HQ sandbox image: where the agent's code actually runs.
# Build: `make sandbox-image` (on every Docker host listed in SANDBOX_DOCKER_HOSTS).
#
# Runtime hardening is applied by the backend, not here: read-only root FS,
# no capabilities, no-new-privileges, pid/mem/cpu caps, uid 1000, isolated network.

FROM node:22-bookworm-slim AS node

FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential git git-lfs curl ca-certificates jq ripgrep unzip zip \
        procps less openssh-client sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Node 22 + npm/npx/corepack from the official image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# uv for fast per-project virtualenvs inside /workspace.
COPY --from=ghcr.io/astral-sh/uv:0.10.0 /uv /uvx /usr/local/bin/

# Preinstalled research/test stack in a read-only system venv. Projects that need
# other packages create their own venv in /workspace (e.g. `uv venv && uv pip install ...`).
RUN python -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir \
        numpy pandas scipy matplotlib pyarrow polars \
        httpx requests pytest ruff ipython
ENV PATH="/opt/py/bin:${PATH}" \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_cache=/tmp/npm-cache \
    UV_CACHE_DIR=/tmp/uv-cache \
    MPLBACKEND=Agg

RUN groupadd --gid 1000 agent \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash agent \
 && mkdir /workspace && chown agent:agent /workspace \
 && git config --system init.defaultBranch main \
 && git config --system --add safe.directory '/workspace/*'

USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
