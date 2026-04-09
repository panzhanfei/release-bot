SHELL := /bin/bash

.PHONY: up down logs health

up:
	./scripts/dev-up.sh

down:
	./scripts/dev-down.sh

logs:
	./scripts/dev-logs.sh 200

health:
	curl -fsS http://127.0.0.1:8787/health
