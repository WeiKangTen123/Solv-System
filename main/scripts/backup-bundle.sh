#!/usr/bin/env bash
#
# Runs ON the box, for backup-pull.sh: takes a fresh verified database backup
# and packs it with the per-user files and .env into one archive only its
# owner can read, then prints the archive's path. backup-pull.sh copies it off
# and deletes it.
#
# A script of its own because the steps used to be one line passed through
# ssh, where every $ had to survive two shells: it took whichever .db was
# newest rather than the one just made, ignored a failed backup (no pipefail
# on the box), and left the archive — .env and its ENCRYPTION_KEY included —
# world-readable in /tmp for the copy to pick up.
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# node answers in the platform's own paths; tar below wants POSIX ones.
posix() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi; }

OUT=$(node main/db/backup.js --kind pull)
DB=$(posix "$(printf '%s\n' "$OUT" | sed -n 's/^Backed up DB to //p' | tail -1)")
[ -n "$DB" ] && [ -f "$DB" ] || { echo "the backup did not report a file: $OUT" >&2; exit 1; }

# DATA_DIR may be set in main/.env to put the data on another disk.
DATA=$(posix "$(node -e 'require("dotenv").config({ path: "main/.env" }); process.stdout.write(require("path").resolve(require("./main/utils/paths").DATA_DIR))')")
ARCHIVE=$(posix "$(mktemp "${TMPDIR:-/tmp}/solv-backup.XXXXXX")")
trap 'rm -f "$ARCHIVE"' ERR   # a half-written archive is not a backup
# Paths inside the app folder go in relative to it (main/data/..., main/.env),
# the layout docs/RUNBOOK.md restores from; a DATA_DIR elsewhere goes in whole.
here=$(posix "$PWD")
rel() { case "$1" in "$here"/*) printf '%s' "${1#"$here"/}" ;; *) printf '%s' "$1" ;; esac; }
tar czf "$ARCHIVE" "$(rel "$DB")" "$(rel "$DATA")/users" main/.env
echo "$ARCHIVE"
