# Runbook

What the server needs, how a deploy happens, and what to do when the box, the
database or a deploy goes wrong.

Everything here assumes the layout `main/scripts/deploy.sh` uses: a git checkout
at `DEPLOY_PATH` on the box, run by pm2 as `solv-expense`, behind nginx with
TLS. Where your box is lives in `main/.deploy.env`, which is gitignored — this
repository is public and the address of your server is not something to publish.
Copy `main/.deploy.env.example` and fill it in once.

## Before the first deploy

The box needs, once:

```bash
# Node 22 (what CI runs and what the native modules are built against)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pm2
sudo apt install -y nginx git

# the checkout, owned by the user pm2 runs as
sudo -u weika git clone https://github.com/WeiKangTen123/Solv-System.git /home/weika/solv-system
cd /home/weika/solv-system && sudo -u weika npm ci && sudo -u weika npm --prefix ui ci

# the secrets — generate them ON THE BOX, do not copy the development ones
sudo -u weika cp main/.env.example main/.env
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
# put both in main/.env, set NODE_ENV=production, and add Gemini_API_KEY

sudo -u weika npm run build:ui
sudo -u weika npm run preflight        # must say ready before you go further
sudo -u weika pm2 start ecosystem.config.js && sudo -u weika pm2 save
sudo -u weika pm2 startup              # run the line it prints, so a reboot restores it
```

`npm run preflight` is the gate: Node version, the three native modules, both
secrets, the data and log directories, the database's integrity and schema, the
built UI, the fonts, disk space, and the settings that should not be true of a
production box (self-registration open, the all-zero test encryption key, a
non-HTTPS Xero callback). It reads and never repairs. Anything it marks ✗ is a
boot failure waiting to happen, and `deploy.sh` runs it on the box and refuses
to restart when it fails.

### nginx

The app listens on `127.0.0.1:4000` in production and nginx terminates TLS in
front of it. Four things matter beyond a default proxy block:

- receipts arrive as base64 inside JSON, so the body limit has to be generous;
- the read of a scanned folio can take a while;
- the assistant streams its answer, which nginx must pass on as it comes
  rather than buffer (the app also sends `X-Accel-Buffering: no` and a
  keep-alive line every 15 seconds);
- query strings carry credentials — receipt-image and export links, a phone
  link's token in its path, Xero's `?code=` — so the access log records the
  path without them. The default `combined` format logs `$request`, query
  string and all.

```nginx
# In the http block: the path, never the query string, and no phone-link token.
map $uri $solv_uri { ~^(?<pre>/api/receipts/capture/)[^/]+(?<post>.*)$ $pre[token]$post; default $uri; }
log_format solv '$remote_addr - [$time_local] "$request_method $solv_uri" $status $body_bytes_sent "$http_user_agent"';

server {
  server_name  solv.your-domain;                 # or <ip-with-dashes>.sslip.io
  client_max_body_size 30m;                      # 25 MB of JSON plus headroom
  access_log   /var/log/nginx/solv.access.log solv;
  location / {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 180s;                     # reading a multi-page folio
  }
  location /api/assistant/chat {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_buffering    off;                      # stream the answer as it is written
    proxy_read_timeout 300s;
  }
}
```

`certbot --nginx -d solv.your-domain` for the certificate. The app sets
`trust proxy`, so the rate limiter sees the real client address through
`X-Forwarded-For` rather than limiting nginx itself.

**Running beside the Xero automation on the same VM.** Nothing collides: that
app is `xero-invoice-app` on its own port, this one is `solv-expense` on 4000,
each with its own pm2 entry, checkout, database and nginx `server` block. They
need different `server_name`s, which means a second hostname pointing at the
same IP — a real subdomain, or the sslip.io name of a second address. Give each
its own `main/.env`: sharing `ENCRYPTION_KEY` between two applications means
one leak unlocks both.

## Deploying

`npm run deploy`, from your machine:

1. refuses uncommitted or unpushed local changes;
2. waits for the GitHub Actions run for that commit to be green — it needs the
   GitHub CLI (`gh`) signed in, and refuses rather than skipping without it
   (`SKIP_CI=1` skips this — only when CI itself is broken);
3. takes a lock on the box (`.deploy-lock`; one older than 30 minutes is taken
   over), so two deploys cannot interleave;
4. moves the box to **exactly the commit you are deploying** — not whatever
   GitHub has by then — and stops unless the server's HEAD is now that commit;
5. installs both trees with `npm ci`, runs the tests there, builds the UI;
6. runs preflight on the box with `--existing`, so a missing database fails
   instead of being created empty;
7. takes a verified backup (`predeploy-…`);
8. reloads pm2 through `ecosystem.config.js` (restart backoff, at most 10
   restarts before it stops and waits for a person);
9. checks `/dashboard/health` reports `healthy` **and that the running process
   reports the shipped commit**, asking up to six times over 30 seconds;
10. installs the daily backup and the health-watch cron lines (replacing only
    this app's), pm2 log rotation, and pushes a `deploy/<timestamp>` tag.

Every remote step is judged by its exit status. If steps 5–7 fail, the box's
checkout is put back on the commit it was on, so the next crash-restart does
not pick up code that just failed its own tests.

Step 4 and step 9 are the ones that matter. On the Xero app next door, three
deploys in a row silently did not apply — untracked files on the box blocked
every `git pull` — while each deploy reported a healthy server and a passing
test count, both of which were true of the *old* code. A deploy has not
happened until the running process reports the same SHA you have locally.

- `npm run deploy -- --check` reports drift without changing anything.
- `npm run deploy -- --to <commit or deploy/tag>` deploys an earlier commit:
  the rollback (below).
- `ALLOW_REWRITE=1` is needed when the history on GitHub was rewritten on
  purpose; without it a box whose commit is no longer in GitHub's history is
  left alone.
- `FIRST_DEPLOY=1` for a new box with no data yet.

## What a restore needs (the backup set)

| Item | Where on the box | Why |
|---|---|---|
| `app.db` | `main/data/app.db` (backups in `main/data/backups/`) | companies, staff, receipts, expenses, reports, exchange rates, encrypted Xero credentials |
| receipt files | `main/data/users/<id>/` | the receipt images and PDFs themselves, and the thumbnails |
| `.env` | `main/.env` | `ENCRYPTION_KEY` — without it every stored Xero credential and reader key in that database is unreadable; `JWT_SECRET` |

Keep `ENCRYPTION_KEY` and `JWT_SECRET` in a password manager as well. Losing
`ENCRYPTION_KEY` means every company reconnects Xero and re-enters its reader
key; losing `JWT_SECRET` only logs everyone out.

## Backups

Each backup is one portable `.db` file, copied in a single step (the copy
does not restart under the live server's writes), written as `.tmp`, opened and
checked with `integrity_check`, and only then renamed into place. Three kinds,
pruned separately so one kind never pushes another out:

| File | Made by | Kept |
|---|---|---|
| `app-<time>.db` | the daily cron, 19:00 UTC (03:00 Singapore) | every one from the last 14 days, and never fewer than 3 |
| `predeploy-<time>.db` | `deploy.sh`, before every restart | the newest 5 |
| `pull-<time>.db` | `npm run backup:pull` | the newest 2 |

- **Daily:** output in `logs/backup.log`. Preflight warns when the newest
  daily copy is more than two days old.
- **Before every deploy:** the deploy refuses to restart if the backup fails.
- **Off the box:** `npm run backup:pull` has the box make a fresh backup and
  pack it with `main/data/users` (the receipt files) and `.env` into an archive
  only its owner can read, streams it back over ssh to
  `~/solv-backups/<timestamp>/solv-backup.tgz` on your machine, and deletes it
  from the box. The copies on the box are on the box's one disk; this is the
  backup that survives losing it. Run it after anything important and at least
  weekly.

## Restore

On the box, in the app directory, as the user pm2 runs as:

```bash
pm2 stop solv-expense
cp main/data/backups/<app|predeploy>-<timestamp>.db main/data/app.db
rm -f main/data/app.db-wal main/data/app.db-shm      # stale WAL pages from the old file
# if restoring files too, from a pulled set:
#   tar xzf solv-backup.tgz main/data/users main/.env    (run from the app directory)
npm run preflight
pm2 start ecosystem.config.js && pm2 save
curl -sk "$DEPLOY_HEALTH"
```

The database is migrated on boot (`main/db/migrate.js`), so an older backup
opens under newer code. Preflight will say which schema the file is on and what
boot will migrate it to.

## Rollback a deploy

Every successful deploy is tagged `deploy/<timestamp>` on GitHub. From your
machine:

```bash
git tag -l 'deploy/*' | tail            # pick the one before the bad deploy
npm run deploy -- --to deploy/<timestamp>
```

That runs the whole deploy for the older commit — tests, build, preflight,
backup, reload and the running-commit check — so a rollback is proved the same
way a deploy is. A failed health check at the end of a deploy prints the exact
command. One caution the schema makes necessary: migrations
run forward on boot and have no down step, so rolling *code* back past a
migration that has already run leaves a database newer than the code. Preflight
says so ("schema 4 is newer than this code expects"). Restore the backup taken
before that deploy rather than hoping.

## Health and crashes

- `/dashboard/health` returns `{ status, commit, timestamp }`, unauthenticated.
  `commit` is what the running process was started from — compare it with
  `git rev-parse HEAD` locally.
- A fatal exit posts the reason to Slack when `SLACK_WEBHOOK_URL` is set in
  `main/.env`, then exits; pm2 restarts it with backoff. If it stops restarting
  (`max_restarts` reached): `pm2 logs solv-expense --err --lines 100`, fix,
  then `pm2 restart solv-expense`.
- Application logs are in `logs/`. Every request carries an id: it is on the
  access-log line, on an unexpected error's log line, and in the answer's
  `X-Request-Id` header (and in a 500's body), so a person's report of an error
  can be found. `pm2 logs solv-expense` for what pm2 caught around a crash;
  pm2-logrotate (installed by the deploy) keeps those files to 10 MB × 14.
- **The health watch:** a cron line runs `main/scripts/healthwatch.js` every
  five minutes on the box. Two misses in a row post to Slack, and so does the
  recovery; `logs/healthwatch.log` has each miss.
- It runs on the same VM, so it cannot report the VM itself being down. Point
  a free external uptime checker at `DEPLOY_HEALTH` for that.

## Keys

- **Rotate `JWT_SECRET`:** change it in `main/.env`, `pm2 restart solv-expense`;
  everyone logs in again.
- **Rotate `ENCRYPTION_KEY`:** there is no re-encryption path — changing it
  makes every stored Xero credential and reader key unreadable. Do not rotate
  it without planning a re-encrypt step first.
- **The reader key** is per company in Settings, encrypted in the database;
  `Gemini_API_KEY` in `main/.env` is only the fallback for a company that has
  not added one.
