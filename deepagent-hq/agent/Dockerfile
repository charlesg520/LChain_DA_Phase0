# HQ agent server: Aegra (Agent Protocol) + the DeepAgent graph + ops API.
FROM python:3.12-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
RUN addgroup --system --gid 10001 app && adduser --system --uid 10001 --ingroup app app

FROM base AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0 /uv /bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --compile-bytecode
COPY src/ ./src/
RUN uv sync --frozen --no-dev --compile-bytecode

FROM base AS final
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libpq5 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src
COPY aegra.json auth.py ./
ENV PATH="/app/.venv/bin:$PATH" AEGRA_CONFIG=aegra.json
# /data/memories and /data/skills are bind-mounted; the app user must own them on the host (see Makefile).
RUN mkdir -p /data && chown app:app /data
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["aegra", "serve", "--host", "0.0.0.0", "--port", "8000"]
