#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/docker-compose.yml"

docker compose -f "$COMPOSE_FILE" --profile data up -d --wait postgres
cd "$ROOT_DIR"
pnpm db:migrate
DATA_STORE=postgres pnpm smoke
