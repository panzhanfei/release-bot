#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGROK_PID_FILE="$ROOT_DIR/.ngrok.pid"
APP_NAME="release-bot"

cd "$ROOT_DIR"

echo "[1/2] Stopping ngrok..."
if [[ -f "$NGROK_PID_FILE" ]]; then
  PID="$(cat "$NGROK_PID_FILE" || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "Stopped ngrok pid=$PID"
  else
    echo "ngrok already stopped"
  fi
  rm -f "$NGROK_PID_FILE"
else
  echo "ngrok pid file not found"
fi

echo "[2/2] Stopping pm2 app $APP_NAME..."
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 stop "$APP_NAME" >/dev/null || true
  echo "Stopped $APP_NAME"
else
  echo "$APP_NAME not found in pm2"
fi

echo "All stopped."
