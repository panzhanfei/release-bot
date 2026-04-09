#!/usr/bin/env bash
set -euo pipefail

APP_NAME="release-bot"
LINES="${1:-200}"

pm2 logs "$APP_NAME" --lines "$LINES"
