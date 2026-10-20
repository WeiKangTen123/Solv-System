// The daily backup, run by cron at 19:00 UTC (deploy.sh installs the line).
//
// A file of its own rather than `node main/db/backup.js`: the Xero app on the
// same box rewrites the shared crontab on every deploy of its own and drops
// every line that mentions main/db/backup.js, this app's as well as its own,
// before adding its own back. Solv's daily backup vanished that way on 29 Sep
// and nothing said so for three weeks. This path is not one that filter
// matches. healthwatch.js now also says when the newest daily copy is old.
require('../db/backup').cli(['--kind', 'app']);
