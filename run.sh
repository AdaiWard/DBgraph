#!/usr/bin/env bash
# DB Graph: создаёт .venv (если нет), ставит зависимости и запускает сервер на :8123
set -eu
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "→ создаём .venv…"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv .venv
  else
    python -m venv .venv
  fi
fi
./.venv/bin/python -m pip install -q -r requirements.txt

echo ""
echo "  DB Graph →  http://localhost:8123"
echo ""
exec ./.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8123
