.PHONY: help test test-coverage fmt lint check coverage deploy deploy-functions deploy-webapp logs secrets-push webhook-set bootstrap install-hooks db-push validate-env

help:
	@echo "FinBot Makefile targets:"
	@echo "  bootstrap      - install required tools (deno, supabase, gh, age, jq)"
	@echo "  install-hooks  - install git pre-commit hook"
	@echo "  validate-env   - validate .env keys are present and valid"
	@echo "  test           - run all unit tests"
	@echo "  test-coverage  - run tests with coverage report"
	@echo "  fmt            - format code"
	@echo "  lint           - lint code"
	@echo "  check          - type check"
	@echo "  coverage       - coverage thresholds check"
	@echo "  db-push        - apply migrations to Supabase"
	@echo "  deploy         - apply migrations + deploy functions"
	@echo "  secrets-push   - push .env to Supabase secrets"
	@echo "  webhook-set    - register Telegram webhook"
	@echo "  logs           - tail tg-webhook logs"

bootstrap:
	bash scripts/bootstrap_tools.sh

install-hooks:
	bash scripts/install_git_hooks.sh

validate-env:
	bash scripts/validate_env.sh

test:
	deno task test

test-coverage:
	deno task test:coverage

fmt:
	deno task fmt

lint:
	deno task lint

check:
	deno task check

coverage:
	bash scripts/check_coverage.sh

db-push:
	@echo "Shared-org mode (CLAUDE.local.md): apply migrations via Management API"
	@for f in supabase/migrations/*.sql; do bash scripts/apply_migration.sh "$$f"; done

deploy-functions:
	supabase functions deploy --no-verify-jwt --import-map deno.json

deploy: db-push deploy-functions

secrets-push:
	supabase secrets set --env-file .env

webhook-set:
	deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts

logs:
	supabase functions logs tg-webhook --tail
