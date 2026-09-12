#!/usr/bin/env bash
# akilas archive — deploy / update (safe to re-run any time)
# usage: ./deploy.sh          from the repo root on the VPS
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ checking prerequisites…"
command -v docker >/dev/null || { echo "✗ docker is not installed — see https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ docker compose v2 plugin missing"; exit 1; }

if [ ! -f .env ]; then
  echo "✗ .env not found. Run:  cp .env.example .env  and fill it in first."
  exit 1
fi

# data dir for the sqlite index (container runs as user "node", uid 1000)
mkdir -p data
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 data
else
  if [ ! -w data ] || [ -n "$(find data -maxdepth 1 ! -w 2>/dev/null | head -1)" ]; then
    sudo chown -R 1000:1000 data 2>/dev/null || echo "⚠ could not chown ./data — if the app fails, run: sudo chown -R 1000:1000 data"
  fi
fi

echo "▸ building & starting containers (this also handles updates)…"
docker compose up -d --build --remove-orphans

echo "▸ waiting for health…"
for i in $(seq 1 30); do
  if docker compose ps --status running --format json 2>/dev/null | grep -q '"Name":"akilas-archive-app-1"'; then :; fi
  health=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || echo starting)
  [ "$health" = "healthy" ] && break
  sleep 2
done
echo "  app health: ${health:-unknown}"

docker image prune -f >/dev/null 2>&1 || true

echo
echo "✓ deployed."
echo "   site   : https://akilasarchive.site      (terminal)"
echo "   admin  : https://akilasarchive.site/admin"
echo "   status : docker compose ps"
echo "   logs   : docker compose logs -f app"
