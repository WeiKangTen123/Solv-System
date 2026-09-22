#!/usr/bin/env bash
#
# Copies the full backup set off the box: the newest verified database backup,
# the per-user files (receipts, thumbnails, job queues) and .env — which holds
# the ENCRYPTION_KEY, without which every stored Xero credential and reader key
# in that database is unreadable. Lands in ~/solv-backups/<timestamp>/.
#
# Run it after anything important and at least weekly: one VM's disk is one
# failure domain. Restore steps are in docs/RUNBOOK.md.
#
#   npm run backup:pull
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f main/.deploy.env ] && . main/.deploy.env

APP="${DEPLOY_PATH:-/home/weika/solv-system}"
RUNAS="${DEPLOY_USER:-weika}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"
DEST="${BACKUP_DEST:-$HOME/solv-backups}/$(date -u +%Y-%m-%dT%H-%M-%SZ)"

BUNDLE='node main/db/backup.js | tail -1 && LATEST=$(ls -t main/data/backups/*.db | head -1) && tar czf /tmp/solv-backup.tgz "$LATEST" main/data/users main/.env && chmod 644 /tmp/solv-backup.tgz'

if [ -n "${DEPLOY_SSH:-}" ]; then
  ssh -o BatchMode=yes "$DEPLOY_SSH" "cd $APP && $BUNDLE"
  mkdir -p "$DEST"
  scp -q "$DEPLOY_SSH:/tmp/solv-backup.tgz" "$DEST/"
  ssh -o BatchMode=yes "$DEPLOY_SSH" 'rm -f /tmp/solv-backup.tgz'
elif [ -n "${DEPLOY_INSTANCE:-}" ]; then
  gcloud compute ssh "$DEPLOY_INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -lc 'cd $APP && $BUNDLE'" 2>/dev/null
  mkdir -p "$DEST"
  gcloud compute scp "$DEPLOY_INSTANCE:/tmp/solv-backup.tgz" "$DEST/" --zone="$ZONE" 2>/dev/null
  gcloud compute ssh "$DEPLOY_INSTANCE" --zone="$ZONE" --command='rm -f /tmp/solv-backup.tgz' 2>/dev/null
else
  echo "✗ No deploy target configured — see main/.deploy.env.example" >&2
  exit 1
fi

# sed, not head: head closing the pipe trips pipefail.
echo "Contents:"; tar tzf "$DEST/solv-backup.tgz" | sed -n '1,6s/^/    /p'
echo "✓ backup set in $DEST"
