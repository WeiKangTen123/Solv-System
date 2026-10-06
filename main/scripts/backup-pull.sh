#!/usr/bin/env bash
#
# Copies the full backup set off the box: a fresh verified database backup,
# the per-user files (receipts, thumbnails, job queues) and .env — which holds
# the ENCRYPTION_KEY, without which every stored Xero credential and reader key
# in that database is unreadable. Lands in ~/solv-backups/<timestamp>/.
#
# Run it after anything important and at least weekly: one VM's disk is one
# failure domain. Restore steps are in docs/RUNBOOK.md.
#
#   npm run backup:pull
#
# The archive is made on the box by main/scripts/backup-bundle.sh, readable by
# its owner only, and streamed back through the same ssh session as that
# owner — never left world-readable for a second login to copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f main/.deploy.env ] && . main/.deploy.env

APP="${DEPLOY_PATH:-/home/weika/solv-system}"
RUNAS="${DEPLOY_USER:-weika}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"
DEST="${BACKUP_DEST:-$HOME/solv-backups}/$(date -u +%Y-%m-%dT%H-%M-%SZ)"

# The bundle runs in a login shell, where node is on the PATH; the archive is
# streamed back through plain bash, because a profile that prints anything
# would land in the middle of it.
if [ -n "${DEPLOY_SSH:-}" ]; then
  on_box()   { ssh -o BatchMode=yes "$DEPLOY_SSH" "bash -lc 'cd $APP && $1'"; }
  from_box() { ssh -o BatchMode=yes "$DEPLOY_SSH" "cd $APP && $1"; }
elif [ -n "${DEPLOY_INSTANCE:-}" ]; then
  on_box()   { gcloud compute ssh "$DEPLOY_INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -lc 'cd $APP && $1'" 2>/dev/null; }
  from_box() { gcloud compute ssh "$DEPLOY_INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -c 'cd $APP && $1'" 2>/dev/null; }
else
  echo "✗ No deploy target configured — see main/.deploy.env.example" >&2
  exit 1
fi

ARCHIVE=$(on_box 'bash main/scripts/backup-bundle.sh' | tail -1 | tr -d '[:space:]')
case "$ARCHIVE" in
  /*solv-backup.*) ;;
  *) echo "✗ the box did not make a backup set: ${ARCHIVE:-no output}" >&2; exit 1 ;;
esac
mkdir -p "$DEST"
from_box "cat $ARCHIVE" > "$DEST/solv-backup.tgz"
from_box "rm -f $ARCHIVE" || true

# sed, not head: head closing the pipe trips pipefail.
echo "Contents:"; tar tzf "$DEST/solv-backup.tgz" | sed -n '1,6s/^/    /p'
echo "✓ backup set in $DEST"
