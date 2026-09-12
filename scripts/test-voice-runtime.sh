#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/apps/voice-runtime/.venv"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip --disable-pip-version-check install -q -r "$ROOT_DIR/apps/voice-runtime/requirements.txt"
"$VENV_DIR/bin/python" -m pytest "$ROOT_DIR/apps/voice-runtime"
