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
front of it. Two things matter beyond a default proxy block: receipts arrive as
base64 inside JSON, so the body limit has to be generous, and the read of a
scanned folio can take a while.

```nginx
server {
  server_name  solv.your-domain;                 # or <ip-with-dashes>.sslip.io
  client_max_body_size 30m;                      # 25 MB of JSON plus headroom
  location / {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 180s;                     # reading a multi-page folio
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
2. waits for the GitHub Actions run for that commit to be green (`SKIP_CI=1`
   skips this — only when CI itself is broken);
3. pulls on the box, and **stops unless the server's HEAD is now the commit you
   are deploying**;
4. installs both trees with `npm ci`, runs the tests there, builds the UI;
5. runs preflight on the box;
6. takes a verified backup;
7. reloads pm2 through `ecosystem.config.js` (restart backoff, at most 10
   restarts before it stops and waits for a person);
8. checks `/dashboard/health` reports `healthy` **and that the running process
   reports the shipped commit**;
9. installs the daily backup cron and pushes a `deploy/<timestamp>` tag.

Step 3 and step 8 are the ones that matter. On the Xero app next door, three
deploys in a row silently did not apply — untracked files on the box blocked
every `git pull` — while each deploy reported a healthy server and a passing
test count, both of which were true of the *old* code. A deploy has not
happened until the running process reports the same SHA you have locally.

`npm run deploy -- --check` reports drift without changing anything.

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

- **Daily, on the box:** the deploy installs a cron line that runs
  `node main/db/backup.js` at 19:00 UTC (03:00 Singapore). Each backup is one
  portable `.db` file, opened and checked with `integrity_check` before it
  counts; the newest 14 are kept. Output: `logs/backup.log`.
- **Before every deploy:** `deploy.sh` takes a verified backup before it
  restarts anything, and refuses to restart if the backup fails.
- **Off the box:** `npm run backup:pull` takes a fresh backup and copies it,
  `main/data/users` and `.env` to `~/solv-backups/<timestamp>/solv-backup.tgz`
  on your machine. Run it after anything important and at least weekly — one
  VM's disk is one failure domain.

## Restore

On the box, in the app directory, as the user pm2 runs as:

```bash
pm2 stop solv-expense
cp main/data/backups/app-<timestamp>.db main/data/app.db
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

Every successful deploy is tagged `deploy/<timestamp>` on GitHub.

```bash
# on the box
git fetch --tags && git checkout deploy/<timestamp>
npm ci && npm --prefix ui ci && npm run build:ui
pm2 startOrReload ecosystem.config.js --update-env && pm2 save
```

Then `npm run deploy -- --check` from your machine reports the drift until
`main` is moved back too. One caution the schema makes necessary: migrations
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
- Application logs are in `logs/`. `pm2 logs solv-expense` for what pm2 caught
  around a crash.
- Nothing external watches the health URL. A free uptime checker pointed at it
  is the cheapest next step.

## Keys

- **Rotate `JWT_SECRET`:** change it in `main/.env`, `pm2 restart solv-expense`;
  everyone logs in again.
- **Rotate `ENCRYPTION_KEY`:** there is no re-encryption path — changing it
  makes every stored Xero credential and reader key unreadable. Do not rotate
  it without planning a re-encrypt step first.
- **The reader key** is per company in Settings, encrypted in the database;
  `Gemini_API_KEY` in `main/.env` is only the fallback for a company that has
  not added one.
