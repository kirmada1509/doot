#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/apps/voice-runtime/.venv"

if [[ ! -x "$VENV_DIR/bin/uvicorn" ]]; then
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/python" -m pip --disable-pip-version-check install -q -r "$ROOT_DIR/apps/voice-runtime/requirements.txt"
fi

export CONTROL_API_URL="${CONTROL_API_URL:-http://localhost:4000}"
export INTERNAL_SERVICE_TOKEN="${INTERNAL_SERVICE_TOKEN:-doot-local-service-token}"
cd "$ROOT_DIR/apps/voice-runtime"
exec "$VENV_DIR/bin/uvicorn" app.main:app --host 0.0.0.0 --port 4100 --reload
