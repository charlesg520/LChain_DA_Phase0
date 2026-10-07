SHELL := /bin/bash
COMPOSE := docker compose
PROFILES ?=
PROFILE_FLAGS := $(foreach p,$(PROFILES),--profile $(p))

.PHONY: help init sandbox-image up down restart logs ps test test-docker smoke backup

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

init: ## Create .env with generated secrets and prepare data dirs (safe to re-run)
	@test -f .env || cp .env.example .env
	@python3 scripts/init_env.py .env
	@mkdir -p data/memories backups
	@echo "Next: add ANTHROPIC_API_KEY to .env, set HQ_DOMAIN, then: make sandbox-image && make up"

sandbox-image: ## Build the sandbox image on this Docker host
	docker build -t hq-sandbox:latest sandbox/

up: ## Start the stack (PROFILES=obs adds Phoenix tracing)
	$(COMPOSE) $(PROFILE_FLAGS) up -d --build

down: ## Stop the stack (data is kept)
	$(COMPOSE) --profile obs down

restart: ## Rebuild and restart the agent only
	$(COMPOSE) up -d --build agent

logs: ## Follow agent logs
	$(COMPOSE) logs -f --tail=200 agent

ps: ## Show service status
	$(COMPOSE) ps

test: ## Unit tests (no Docker needed)
	cd agent && uv run --group dev pytest -m "not docker"

test-docker: ## Sandbox integration tests (needs Docker + sandbox image)
	cd agent && uv run --group dev pytest -m docker

smoke: ## Hit the running API through Caddy with your token
	@source .env && curl -fsS -k -H "Authorization: Bearer $$HQ_API_TOKEN" https://$${HQ_DOMAIN}/api/ops/info | python3 -m json.tool

backup: ## Dump Postgres + memories + skills into backups/
	@ts=$$(date +%Y%m%d-%H%M%S); \
	source .env; \
	$(COMPOSE) exec -T postgres pg_dump -U $${POSTGRES_USER:-hq} $${POSTGRES_DB:-hq} | gzip > backups/pg-$$ts.sql.gz && \
	tar czf backups/files-$$ts.tar.gz data/memories skills && \
	echo "backups/pg-$$ts.sql.gz backups/files-$$ts.tar.gz"
