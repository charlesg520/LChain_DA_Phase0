SHELL := /bin/bash
COMPOSE := docker compose
PROFILES ?=
PROFILE_FLAGS := $(foreach p,$(PROFILES),--profile $(p))

.PHONY: help init network sandbox-image up down restart logs logs-gateway ps test test-docker test-all smoke skills-pending backup

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

init: ## Create .env + secrets/git-gateway.env with generated secrets, prepare data dirs (safe to re-run)
	@test -f .env || cp .env.example .env
	@python3 scripts/init_env.py .env
	@test -f secrets/git-gateway.env || (cp secrets/git-gateway.env.example secrets/git-gateway.env && chmod 600 secrets/git-gateway.env)
	@mkdir -p data/memories data/skills data/skill-store data/audit backups
	@echo "Next: add your model key to .env, a GitHub token to secrets/git-gateway.env, then: make sandbox-image && make up"

network: ## Create the sandbox network (make up does this)
	@docker network inspect hq-sandbox >/dev/null 2>&1 || docker network create --label hq.sandbox=1 hq-sandbox >/dev/null

sandbox-image: ## Build the sandbox image on this Docker host
	docker build -t hq-sandbox:latest sandbox/

up: network ## Start the stack (PROFILES=obs adds Phoenix tracing)
	@mkdir -p data/memories data/skills data/skill-store data/audit
	$(COMPOSE) $(PROFILE_FLAGS) up -d --build

down: ## Stop the stack (data is kept)
	$(COMPOSE) --profile obs down

restart: ## Rebuild and restart the agent only
	$(COMPOSE) up -d --build agent

logs: ## Follow agent logs
	$(COMPOSE) logs -f --tail=200 agent

logs-gateway: ## Follow git gateway logs (every clone/push, allowed or refused)
	$(COMPOSE) logs -f --tail=200 git-gateway

ps: ## Show service status
	$(COMPOSE) ps

test: ## Unit tests (no Docker needed)
	cd agent && uv run --group dev pytest -m "not docker"

test-docker: ## Sandbox integration tests (needs Docker + sandbox image)
	cd agent && uv run --group dev pytest -m docker

test-all: ## Everything
	cd agent && uv run --group dev pytest

smoke: ## Hit the running API through Caddy with your token
	@source .env && curl -fsS -k -H "Authorization: Bearer $$HQ_API_TOKEN" https://$${HQ_DOMAIN}/api/ops/info | python3 -m json.tool

skills-pending: ## List skill proposals waiting for your review
	@source .env && curl -fsS -k -H "Authorization: Bearer $$HQ_API_TOKEN" https://$${HQ_DOMAIN}/api/ops/skill-proposals | python3 -m json.tool

backup: ## Dump Postgres + data/ (memories, skills, versions, audit) into backups/
	@ts=$$(date +%Y%m%d-%H%M%S); \
	source .env; \
	$(COMPOSE) exec -T postgres pg_dump -U $${POSTGRES_USER:-hq} $${POSTGRES_DB:-hq} | gzip > backups/pg-$$ts.sql.gz && \
	tar czf backups/files-$$ts.tar.gz data && \
	echo "backups/pg-$$ts.sql.gz backups/files-$$ts.tar.gz"
