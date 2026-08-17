#!/usr/bin/env bash
# Deploy the wishlist app: push main, pull + rebuild on the VPS, health-check.
# DEPLOY_HOST (ssh destination) and ORIGIN (public URL) come from .env.
set -euo pipefail

SSH=/usr/bin/ssh   # the real binary — the shell alias disables host-key checks

env_get() { sed -n "s/^$1=//p" .env; }
HOST=$(env_get DEPLOY_HOST)
URL=$(env_get ORIGIN)
if [ -z "$HOST" ] || [ -z "$URL" ]; then
  echo "✗ DEPLOY_HOST and ORIGIN must be set in .env" >&2; exit 1
fi

if ! git diff-index --quiet HEAD --; then
  echo "✗ uncommitted changes — commit (or stash) first" >&2; exit 1
fi
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "✗ on branch '$branch' — deploys ship main only" >&2; exit 1
fi

echo "→ pushing main to GitHub"
git push origin main

echo "→ pulling + rebuilding on the VPS"
$SSH $HOST 'cd ~/services/wishlist && git pull --ff-only && docker compose up -d --build'

echo "→ health check"
code=$(curl -s --retry 6 --retry-delay 2 --retry-all-errors -o /dev/null -w '%{http_code}' "$URL")
sha_local=$(git rev-parse --short HEAD)
sha_remote=$($SSH $HOST 'cd ~/services/wishlist && git rev-parse --short HEAD')

echo "  $URL → HTTP $code | deployed: $sha_remote | local: $sha_local"
if [ "$code" = "200" ] && [ "$sha_remote" = "$sha_local" ]; then
  echo "✓ deployed"
else
  echo "✗ something's off — check docker compose logs on the VPS" >&2; exit 1
fi
