#!/usr/bin/env bash
#
# Deploy to the server, and refuse to claim success without proving it.
#
# The rule this enforces, learned the expensive way on the Xero app next door:
# a deploy has not happened until the server reports the SAME COMMIT the local
# repository is on. Health checks and test counts describe whatever is running;
# only the SHA says whether it is what you meant to ship. Three deploys there
# silently did not apply — files copied by hand left untracked paths that
# blocked every git pull — while each one reported "healthy" and a passing test
# count, both true of the OLD code.
#
#   npm run deploy                 # deploy HEAD
#   npm run deploy -- --check      # report drift without changing anything
#   npm run deploy -- --to <ref>   # deploy an earlier commit or deploy/<tag>: the rollback
#   SKIP_CI=1 npm run deploy       # do not wait for the GitHub Actions run
#   ALLOW_REWRITE=1 npm run deploy # the history on GitHub was rewritten on purpose
#   FIRST_DEPLOY=1 npm run deploy  # a new box, with no data yet
#
# Where it deploys to is yours to set, once, in main/.deploy.env (gitignored;
# main/.deploy.env.example is the template). Two ways to reach the box:
#
#   DEPLOY_SSH=weika@203.0.113.9        any server you can ssh to
#   DEPLOY_INSTANCE=xero-automation     a Google Cloud VM, reached with gcloud
#   DEPLOY_ZONE=us-central1-a
#
# Beyond the SHA rule, a deploy: waits for CI to be green, takes a lock so two
# deploys cannot interleave, moves the server to exactly the commit being
# shipped (not whatever GitHub has by then), installs from the lockfiles (npm
# ci — npm install rewrote package-lock.json on the box and blocked the next
# pull), runs the tests there, builds the UI, runs preflight, takes a verified
# backup before restarting, reloads through ecosystem.config.js so the restart
# policy is the committed one, checks the RUNNING process reports the shipped
# commit, installs the daily backup and health-watch cron, and tags the commit deploy/<timestamp>
# so a rollback has a name. If anything fails after the server's files have
# moved and before the restart, the checkout is put back where it was, so the
# next crash-restart does not pick up code that failed its own tests.
#
# Every remote step is judged by its exit status, echoed back as a word
# (TESTS-PASSED, BUILD-OK…), never by grepping what it printed: "Tests:" with no
# "failed" in it also described a test file that could not load, and the last
# line of the backup became a prune message once there were fourteen.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f main/.deploy.env ] && . main/.deploy.env

APP="${DEPLOY_PATH:-/home/weika/solv-system}"
RUNAS="${DEPLOY_USER:-weika}"
PM2_APP="${DEPLOY_PM2_APP:-solv-expense}"
BRANCH="${DEPLOY_BRANCH:-main}"
HEALTH="${DEPLOY_HEALTH:-}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { red "✗ $*"; exit 1; }

# ── 0. Where does this go? ──────────────────────────────────────────────────
# Named rather than defaulted. A deploy script with a plausible-looking default
# target is one run away from restarting somebody else's application.
#
# A remote command must not contain a dollar sign: in gcloud mode it passes
# through the ssh login shell inside double quotes, which expands $anything
# (empty) before the inner bash ever sees it. Anything variable is pasted in
# from this side; exit statuses come back as words via `&& echo X || echo Y`.
if [ -n "${DEPLOY_SSH:-}" ]; then
  MODE=ssh
  remote() { ssh -o BatchMode=yes "$DEPLOY_SSH" "cd $APP && $1" 2>/dev/null; }
  TARGET="$DEPLOY_SSH:$APP"
elif [ -n "${DEPLOY_INSTANCE:-}" ]; then
  MODE=gcloud
  command -v gcloud >/dev/null 2>&1 || die "DEPLOY_INSTANCE is set but gcloud is not installed."
  remote() { gcloud compute ssh "$DEPLOY_INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -lc \"cd $APP && $1\"" 2>/dev/null; }
  TARGET="$DEPLOY_INSTANCE ($ZONE):$APP"
else
  red "✗ No deploy target configured."
  cat <<'MSG'

  Copy main/.deploy.env.example to main/.deploy.env and set where this deploys
  to. It is gitignored, so the address of your server does not go to GitHub.

    DEPLOY_SSH=user@host           any box you can ssh to, or
    DEPLOY_INSTANCE=my-vm          a Google Cloud VM (DEPLOY_ZONE too)

    DEPLOY_PATH=/home/weika/solv-system     where the checkout lives there
    DEPLOY_HEALTH=https://your-host/dashboard/health

  docs/RUNBOOK.md has what the box needs installed before the first deploy.
MSG
  exit 1
fi

CHECK_ONLY=0
TO_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --to) shift; TO_REF="${1:-}"; [ -n "$TO_REF" ] || die "--to needs a commit or a deploy/<timestamp> tag" ;;
    *) die "unknown option $1 (--check, --to <ref>)" ;;
  esac
  shift
done

# ── 1. What is being shipped ────────────────────────────────────────────────
git fetch -q origin
git fetch -q --tags origin 2>/dev/null || true   # only --to <tag> needs them; a clashing local tag must not stop a deploy
echo "Local"
if [ -n "$TO_REF" ]; then
  # A rollback ships a commit that was pushed before. The working copy does
  # not matter; that the commit is on GitHub's branch does, because the
  # server can only fetch what GitHub has.
  SHA=$(git rev-parse --verify -q "$TO_REF^{commit}") || die "no commit called $TO_REF here"
  git merge-base --is-ancestor "$SHA" "origin/$BRANCH" || die "$TO_REF is not on origin/$BRANCH, so the server cannot fetch it"
  info "commit  $(git log --oneline -1 "$SHA")   (rolling to an earlier commit)"
  info "target  $TARGET"
else
  # Deploying with uncommitted changes ships something nobody can reproduce
  # from the repository; unpushed commits never reach the server at all.
  SHA=$(git rev-parse HEAD)
  info "commit  $(git log --oneline -1)"
  info "target  $TARGET"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no | sed 's/^/    /'
    die "Uncommitted changes. Commit or stash before deploying."
  fi
  if [ -n "$(git log "origin/$BRANCH..HEAD" --oneline)" ]; then
    git log "origin/$BRANCH..HEAD" --oneline | sed 's/^/    /'
    die "Local commits are not pushed. The server fetches from origin/$BRANCH."
  fi
  grn "  ✓ clean and pushed"
fi

# ── 1b. CI must be green for this commit ────────────────────────────────────
# Not optional by accident: a machine without gh used to skip this in silence,
# and a run that took more than 20 seconds to appear was treated as no run.
if [ "$CHECK_ONLY" != "1" ] && [ "${SKIP_CI:-0}" != "1" ]; then
  command -v gh >/dev/null 2>&1 || die "the GitHub CLI (gh) is not installed, so CI cannot be checked — install it, or SKIP_CI=1 to deploy without CI"
  ci_run() { gh run list --commit "$SHA" --workflow ci --json databaseId -q '.[0].databaseId' 2>/dev/null || true; }
  RUN_ID=$(ci_run)
  tries=0
  while [ -z "$RUN_ID" ] && [ $tries -lt 9 ]; do
    [ $tries -eq 0 ] && info "waiting for GitHub to start the CI run"
    sleep 20; RUN_ID=$(ci_run); tries=$((tries + 1))
  done
  [ -n "$RUN_ID" ] || die "no CI run for $SHA after 3 minutes — check GitHub Actions and \`gh auth status\`, or SKIP_CI=1"
  info "CI run $RUN_ID — waiting for it"
  if gh run watch "$RUN_ID" --exit-status >/dev/null 2>&1; then grn "  ✓ CI green"
  else die "CI is red for $SHA — fix it before deploying (SKIP_CI=1 to override)"; fi
fi

# ── 2. What is the server actually running? ─────────────────────────────────
echo
echo "Server"
remote 'true' >/dev/null 2>&1 || die "cannot reach $TARGET — check the address, your ssh access, and that $APP exists (docs/RUNBOOK.md)"
BEFORE=$(remote 'git rev-parse HEAD' | tr -d '[:space:]')
info "commit  $(remote 'git log --oneline -1' | head -1)"

DIRTY=$(remote 'git status --porcelain --untracked-files=no' || true)
if [ -n "$DIRTY" ]; then
  red "  ✗ tracked files modified ON THE SERVER:"
  echo "$DIRTY" | sed 's/^/      /'
  info "these will block the pull — usually an npm install --save run there"
fi

if [ "$BEFORE" = "$SHA" ]; then
  grn "  ✓ already at $SHA"
  [ "$CHECK_ONLY" = "1" ] && exit 0
else
  remote 'git fetch -q origin' >/dev/null 2>&1 || true
  info "behind by: $(remote "git rev-list --count ${BEFORE}..$SHA 2>/dev/null" | tr -d '[:space:]') commit(s)"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  [ -n "$DIRTY" ] && die "server has local modifications"
  echo; grn "check only — nothing changed"; exit 0
fi

# ── 2b. One deploy at a time ────────────────────────────────────────────────
# Two deploys from two terminals interleaved their pulls, installs and
# restarts. The lock is a directory on the box (mkdir is atomic); one older
# than 30 minutes belongs to a deploy that died, and is taken over.
LOCKED=0
PULLED=0
unlock() { if [ "$LOCKED" = "1" ]; then remote 'rmdir .deploy-lock' >/dev/null 2>&1 || true; fi; }
trap unlock EXIT
GOT=$(remote 'mkdir .deploy-lock 2>/dev/null && echo got-lock || find .deploy-lock -maxdepth 0 -mmin +30' || true)
case "$GOT" in
  *got-lock*) LOCKED=1 ;;
  *deploy-lock*) ylw "  ! taking over a deploy lock left more than 30 minutes ago"; remote 'touch .deploy-lock' >/dev/null 2>&1 || true; LOCKED=1 ;;
  *) die "another deploy is running on $TARGET (remove $APP/.deploy-lock there if you are sure it is not)" ;;
esac

# After the server's files have moved, a failure puts them back: left on the
# new commit, the next crash-restart would start code that just failed its
# tests or build, against node_modules that may be half-installed.
fail() {
  red "✗ $*"
  if [ "$PULLED" = "1" ] && [ -n "$BEFORE" ]; then
    ylw "  putting the server's checkout back on $BEFORE"
    remote "git reset -q --hard $BEFORE && npm ci > logs/deploy-restore.log 2>&1 && npm --prefix ui ci >> logs/deploy-restore.log 2>&1 && npm run build:ui >> logs/deploy-restore.log 2>&1 && echo RESTORED || echo RESTORE-FAILED" | tail -1 | sed 's/^/    /'
    info "the running process was not restarted; it is still on $BEFORE"
  fi
  exit 1
}

# ── 3. Deploy ───────────────────────────────────────────────────────────────
echo
echo "Deploying"
if [ -n "$DIRTY" ]; then
  # `git checkout -- .` rather than a computed file list: the list has to
  # survive three shell layers and the quoting silently mangles. A deploy
  # target should never carry local edits, so discarding all of them is both
  # simpler and more correct than reconstructing which ones.
  info "discarding the server's local edits to tracked files"
  remote 'git checkout -- .' >/dev/null || true
  STILL=$(remote 'git status --porcelain --untracked-files=no' || true)
  [ -n "$STILL" ] && die "could not discard the server's local edits: $STILL"
fi

# To exactly $SHA, not to whatever origin has: a push that landed while CI ran
# used to be deployed untested. The server is a deploy target with no commits
# of its own, so a reset is a fast-forward or, for --to, a step back.
# When the server's commit is not in GitHub's history at all, that history was
# rewritten (as it was once, to take personal data out of it). That is either
# deliberate or a hostile force-push, and only a person can say which, so it
# needs ALLOW_REWRITE=1; then the old objects are pruned so the data does not
# linger in the server's .git either. Untracked files (helper scripts) are not
# touched.
if [ "${ALLOW_REWRITE:-0}" = "1" ]; then
  REWRITE="echo history on GitHub was rewritten, the server follows it; git reset -q --hard $SHA && git reflog expire --expire=now --all && git gc -q --prune=now && echo SYNCED"
else
  REWRITE="echo REWRITE-REFUSED"
fi
SYNC="git fetch -q origin && git cat-file -e $SHA && git merge-base --is-ancestor $SHA origin/$BRANCH && if git merge-base --is-ancestor HEAD origin/$BRANCH; then git reset -q --hard $SHA && echo SYNCED; else $REWRITE; fi"
PULL=$(remote "$SYNC 2>&1 | tail -3" || true)
echo "$PULL" | grep -v SYNCED | sed 's/^/    /' || true
echo "$PULL" | grep -q REWRITE-REFUSED && die "the server's commit $BEFORE is not in GitHub's history — it was rewritten. If you did that on purpose, run again with ALLOW_REWRITE=1"

# ── 4. The check that is the whole point ────────────────────────────────────
AFTER=$(remote 'git rev-parse HEAD' | tr -d '[:space:]')
if [ "$AFTER" != "$SHA" ]; then
  echo
  red "✗ DEPLOY DID NOT APPLY"
  info "expected $SHA"
  info "server   $AFTER"
  info "the server could not move to it — resolve the blockers above and run again"
  exit 1
fi
[ "$AFTER" != "$BEFORE" ] && PULLED=1
grn "  ✓ server is on $AFTER"

# ── 5. Only now is it worth building ────────────────────────────────────────
echo
echo "Building"
remote 'mkdir -p logs' >/dev/null 2>&1 || true
# npm ci, never npm install: install rewrote package-lock.json on the box and
# blocked the next pull.
NPM=$(remote 'npm ci > logs/deploy-npm.log 2>&1 && npm --prefix ui ci >> logs/deploy-npm.log 2>&1 && echo NPM-OK || echo NPM-FAILED; tail -2 logs/deploy-npm.log' || true)
echo "$NPM" | grep -v 'NPM-' | sed 's/^/    /' || true
echo "$NPM" | grep -q NPM-OK || fail "npm ci failed on the server (logs/deploy-npm.log there)"

TESTS=$(remote "(npm test > logs/deploy-tests.log 2>&1 && echo TESTS-PASSED || echo TESTS-FAILED); grep -E '^(Test Suites|Tests):' logs/deploy-tests.log" || true)
echo "$TESTS" | grep -v 'TESTS-' | sed 's/^/    /' || true
echo "$TESTS" | grep -q TESTS-PASSED || fail "tests failed on the server (logs/deploy-tests.log there)"

BUILD=$(remote "npm run build:ui > logs/deploy-build.log 2>&1 && echo BUILD-OK || echo BUILD-FAILED; grep 'built in' logs/deploy-build.log | tail -1" || true)
echo "$BUILD" | grep -v 'BUILD-' | sed 's/^/    /' || true
echo "$BUILD" | grep -q BUILD-OK || fail "UI build failed on the server (logs/deploy-build.log there)"

# ── 5b. Is the box fit to run it? ───────────────────────────────────────────
# --existing: this box has run before, so a missing database is not "the first
# boot will create it" but a DATA_DIR pointing at the wrong place.
echo
echo "Preflight"
EXISTING="--existing"
[ "${FIRST_DEPLOY:-0}" = "1" ] && EXISTING=""
PRE=$(remote "NODE_ENV=production node main/scripts/preflight.js $EXISTING 2>&1 && echo PREFLIGHT-OK || echo PREFLIGHT-FAILED" || true)
echo "$PRE" | grep -v 'PREFLIGHT-' | sed 's/^/    /' || true
echo "$PRE" | grep -q PREFLIGHT-OK || fail "preflight failed on the server — fix the ✗ lines above"

# ── 5c. A verified backup before anything restarts ──────────────────────────
echo
echo "Backing up"
BACKUP=$(remote 'node main/db/backup.js --kind predeploy 2>&1 && echo BACKUP-OK || echo BACKUP-FAILED' || true)
echo "$BACKUP" | grep -E '^(Backed up|Backup failed)' | sed 's/^/    /' || true
echo "$BACKUP" | grep -q BACKUP-OK || fail "backup did not succeed — not restarting"

echo
echo "Restarting"
# Reload through the committed ecosystem file so the restart policy (backoff,
# max_restarts) is what runs. The first deploy after a bare `pm2 start` cannot
# reload into the new options, so it is deleted and started once.
if remote 'pm2 jlist' | grep -q '"exp_backoff_restart_delay":1000'; then
  remote "pm2 startOrReload ecosystem.config.js --update-env >/dev/null 2>&1; pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep $PM2_APP" | sed 's/^/    /'
else
  info "first deploy under ecosystem.config.js — replacing the bare pm2 process once"
  remote "pm2 delete $PM2_APP >/dev/null 2>&1 || true; pm2 start ecosystem.config.js >/dev/null 2>&1; pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep $PM2_APP" | sed 's/^/    /'
fi
PULLED=0   # restarted onto it: from here a bad outcome is rolled back with --to, not by moving files under a running process

# ── 6. The running process, not the files on disk ───────────────────────────
# Asked a few times: a reload that takes longer than one check used to read as
# a failed deploy, and a single dropped request as an unhealthy one.
CONFIRMED=""
ROLLBACK_HINT="to step back: npm run deploy -- --to $BEFORE"
if [ -z "$HEALTH" ]; then
  ylw "  ! DEPLOY_HEALTH is not set — cannot confirm the RUNNING process is on $SHA"
  ylw "    set it in main/.deploy.env; this is the check that catches a restart that did not happen"
else
  RUNNING=""; HEALTH_OUT=""
  for attempt in 1 2 3 4 5 6; do
    HEALTH_OUT=$(curl -sk --max-time 10 "$HEALTH" || true)
    RUNNING=$(echo "$HEALTH_OUT" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
    if echo "$HEALTH_OUT" | grep -q healthy && [ "$RUNNING" = "$SHA" ]; then break; fi
    [ "$attempt" -lt 6 ] && sleep 5
  done
  info "$HEALTH_OUT"
  echo "$HEALTH_OUT" | grep -q healthy || die "health check did not report healthy after 30 s — $ROLLBACK_HINT"
  [ "$RUNNING" = "$SHA" ] || die "the running process reports commit '${RUNNING:-none}', not $SHA — it did not restart onto the new code; $ROLLBACK_HINT"
  grn "  ✓ running process is on $RUNNING"
  CONFIRMED=" running process confirmed,"
fi

# ── 7. Daily backup cron (idempotent), log rotation, a name for this deploy ──
# node by absolute path: cron's PATH need not include node. Resolved in its own
# remote call and pasted in as a literal (see the note on dollar signs above).
# Only this app's line is replaced: the filter used to drop any crontab line
# mentioning main/db/backup.js, including the Xero app's on the same box.
NODE_BIN=$(remote 'command -v node' | tr -d '[:space:]')
[ -n "$NODE_BIN" ] || NODE_BIN=node
# The health watch (main/scripts/healthwatch.js) runs every five minutes and
# posts to Slack after two misses in a row.
remote "(crontab -l 2>/dev/null | grep -v 'cd $APP && .*main/db/backup.js' | grep -v 'cd $APP && .*main/scripts/healthwatch.js' ; printf '0 19 * * * cd %s && %s main/db/backup.js >> logs/backup.log 2>&1\n*/5 * * * * cd %s && %s main/scripts/healthwatch.js >> logs/healthwatch.log 2>&1\n' $APP $NODE_BIN $APP $NODE_BIN) | crontab -" >/dev/null 2>&1 \
  && info "daily backup and five-minute health watch installed in cron ($NODE_BIN)" || ylw "  ! could not install the cron lines"
# pm2's own log files grow without limit otherwise; the module rotates them.
remote 'pm2 jlist | grep -q pm2-logrotate || (pm2 install pm2-logrotate > /dev/null 2>&1 && pm2 set pm2-logrotate:max_size 10M > /dev/null && pm2 set pm2-logrotate:retain 14 > /dev/null)' >/dev/null 2>&1 \
  || ylw "  ! could not set up pm2 log rotation"
TAG="deploy/$(date -u +%Y%m%d-%H%M%S)"
git tag -f "$TAG" "$SHA" >/dev/null 2>&1 && git push -q origin "$TAG" 2>/dev/null && info "tagged $TAG" || ylw "  ! could not push tag $TAG"

echo
if [ -n "$CONFIRMED" ]; then
  grn "✓ deployed $SHA — server commit verified, tests passed, preflight clean, backed up,$CONFIRMED healthy"
else
  ylw "✓ shipped $SHA — server commit verified, tests passed, preflight clean, backed up."
  ylw "  NOT confirmed: that the running process is on $SHA. Set DEPLOY_HEALTH and run --check."
fi
