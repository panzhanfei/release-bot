#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGROK_LOG="$ROOT_DIR/.ngrok.log"
NGROK_PID_FILE="$ROOT_DIR/.ngrok.pid"
APP_NAME="release-bot"
PORT="${PORT:-8787}"

cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  echo "[error] .env not found in $ROOT_DIR"
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[error] pm2 not found. Install first: npm i -g pm2"
  exit 1
fi

if ! command -v ngrok >/dev/null 2>&1; then
  echo "[error] ngrok not found. Install first and login."
  exit 1
fi

echo "[1/4] Starting or reloading $APP_NAME with pm2..."
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env >/dev/null
else
  pm2 start "npx tsx agent.ts" --name "$APP_NAME" >/dev/null
fi

echo "[2/4] Ensuring ngrok tunnel on port $PORT..."
if [[ -f "$NGROK_PID_FILE" ]]; then
  OLD_PID="$(cat "$NGROK_PID_FILE" || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

nohup ngrok http "$PORT" --pooling-enabled >"$NGROK_LOG" 2>&1 &
echo $! >"$NGROK_PID_FILE"
sleep 2

if ! kill -0 "$(cat "$NGROK_PID_FILE")" 2>/dev/null; then
  if [[ -f "$NGROK_LOG" ]] && [[ "$(<"$NGROK_LOG")" == *"ERR_NGROK_334"* ]]; then
    echo "[warn] ngrok endpoint already online. Reusing existing tunnel."
    rm -f "$NGROK_PID_FILE"
  else
    echo "[error] ngrok failed to start. Check $NGROK_LOG"
    exit 1
  fi
fi

echo "[3/4] Checking local health..."
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "Local health: OK (http://127.0.0.1:$PORT/health)"
else
  echo "[warn] health check failed. Check: pm2 logs $APP_NAME"
fi

echo "[4/4] Reading ngrok public URL..."
PUBLIC_URL="$(curl -fsS http://127.0.0.1:4040/api/tunnels | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((t.get("public_url","") for t in d.get("tunnels",[]) if t.get("proto")=="https"), ""))' 2>/dev/null || true)"

echo "------------------------------"
echo "release-bot is up."
echo "PM2 app   : $APP_NAME"
echo "Local URL : http://127.0.0.1:$PORT"
if [[ -n "$PUBLIC_URL" ]]; then
  echo "Webhook   : $PUBLIC_URL/feishu/webhook"
else
  echo "Webhook   : (not resolved yet, see $NGROK_LOG)"
fi
echo "Logs      : pm2 logs $APP_NAME --lines 200"
echo "Stop all  : ./scripts/dev-down.sh"
