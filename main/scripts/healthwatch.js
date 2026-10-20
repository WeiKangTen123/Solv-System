// Run by cron on the box every five minutes (deploy.sh installs it): asks the
// app's own health URL, and posts to Slack (SLACK_WEBHOOK_URL) after two misses
// in a row, then once more when it answers again. Nothing watched the health
// URL before; a process that was up but not answering went unnoticed until a
// person tried to use it.
//
// It runs on the same VM, so it cannot report the VM itself being down: an
// external uptime checker on DEPLOY_HEALTH covers that (docs/RUNBOOK.md).
//
// It also says, once a day, when the newest daily backup is more than 36 hours
// old. The daily backup's cron line was removed by another app's deploy and
// none was taken for three weeks; only a deploy's preflight noticed.
//
//   node main/scripts/healthwatch.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PORT = process.env.PORT || 4000;
const URL_ = `http://127.0.0.1:${PORT}/dashboard/health`;
const STATE = path.join(process.env.LOGS_DIR || path.join(__dirname, '../../logs'), 'healthwatch.json');
const ALERT_AFTER = 2;
const BACKUP_LATE_MS = 36 * 60 * 60 * 1000;

// The newest daily copy ({ file, ageMs }), or null when there is none at all.
function newestDaily(now = Date.now()) {
  const dir = require('../utils/paths').backupsDir();   // after dotenv, so DATA_DIR applies
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^app-.*\.db$/.test(f)).sort(); } catch { return null; }
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { file, ageMs: now - fs.statSync(path.join(dir, file)).mtimeMs };
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { misses: 0, alerted: false }; } }
function writeState(s) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); }

async function check() {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));
    return res.ok && /healthy/.test(String(body.status || '')) ? null : `answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`;
  } catch (err) {
    return err.name === 'TimeoutError' ? 'no answer within 10 seconds' : err.message;
  }
}

// Once a UTC day at most, so a late backup is one message, not 288.
async function checkBackup(state, notifyError, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const newest = newestDaily(now.getTime());
  if (newest && newest.ageMs <= BACKUP_LATE_MS) return state.backupAlertedOn ? { ...state, backupAlertedOn: null } : state;
  if (state.backupAlertedOn === day) return state;
  const what = newest ? `the newest is ${newest.file}, ${Math.round(newest.ageMs / 3600000)} hours old` : 'there is none';
  console.log(`${now.toISOString()} daily backup late: ${what}`);
  await notifyError({ context: 'The daily backup is late', error: `${what}. Check \`crontab -l\` on the box for main/scripts/backup-daily.js.` });
  return { ...state, backupAlertedOn: day };
}

async function main() {
  const { notifyError } = require('../utils/notify');
  const state = await checkBackup(readState(), notifyError);
  const problem = await check();
  const at = new Date().toISOString();
  if (!problem) {
    if (state.alerted) await notifyError({ context: 'Health check answers again', error: `healthy at ${at} after ${state.misses} missed check(s)` });
    writeState({ ...state, misses: 0, alerted: false, lastOk: at });
    return;
  }
  const misses = (state.misses || 0) + 1;
  console.log(`${at} health check missed (${misses}): ${problem}`);
  let alerted = !!state.alerted;
  if (misses >= ALERT_AFTER && !alerted) {
    await notifyError({ context: `Health check failed ${misses} times in a row`, error: `${URL_}: ${problem}` });
    alerted = true;
  }
  writeState({ ...state, misses, alerted, lastMiss: at });
}

if (require.main === module) main().catch(err => { console.error('healthwatch failed:', err.message); process.exitCode = 1; });

module.exports = { check, main, checkBackup, newestDaily, ALERT_AFTER, BACKUP_LATE_MS };
