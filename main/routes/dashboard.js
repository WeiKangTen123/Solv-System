const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const router     = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const users      = require('../store/users');
const { summary } = require('../store/summary');

// The commit this process is running, read from the checkout ONCE, at boot:
// the code loaded at boot is the code on disk at boot. Read again per request
// it would report a `git pull` nobody restarted onto, which is exactly the
// false positive deploy.sh exists to catch. Health reports it so a deploy can
// prove the RUNNING process is on the shipped commit, not only the files.
//
// DEPLOY_SHA (ecosystem.config.js) is the fallback, not the answer. pm2 keeps
// a process's environment across `pm2 restart`, so after one the variable
// still named the commit of the start before, and health reported eight
// commits behind the code that was answering it.
//
// Read from .git directly rather than by spawning git: the process under pm2
// need not have git on its PATH, and a child process at boot is one more
// thing that can hang.
function gitHead(root) {
  try {
    let dir = path.join(root, '.git');
    if (fs.statSync(dir).isFile()) {                         // a worktree: ".git" names the real dir
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dir, 'utf8'));
      if (!m) return null;
      dir = path.resolve(root, m[1].trim());
    }
    // A worktree keeps HEAD of its own and shares refs through commondir.
    const commonFile = path.join(dir, 'commondir');
    const common = fs.existsSync(commonFile) ? path.resolve(dir, fs.readFileSync(commonFile, 'utf8').trim()) : dir;
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/i.test(head) ? head : null;   // detached
    const ref = head.slice(4).trim();
    const loose = path.join(common, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim() || null;
    const packed = path.join(common, 'packed-refs');
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, 'utf8').split('\n').find(l => l.endsWith(` ${ref}`));
      if (line) return line.split(' ')[0];
    }
    return null;
  } catch { return null; }
}

const COMMIT = gitHead(path.join(__dirname, '..', '..')) || process.env.DEPLOY_SHA || 'unknown';

// GET /health — used by deployment health checks (no auth required). Exported
// alongside the router so index.js can also serve it at the legacy
// /dashboard/health path without duplicating the payload.
function health(_req, res) {
  res.json({ status: 'healthy', commit: COMMIT, timestamp: new Date().toISOString() });
}

router.get('/health', health);

// GET /summary — the dashboard's figures, aggregated in SQL and scoped to what
// this person may see: their own expenses, or the company for an admin. The
// scope is decided here from the caller's own row, never from a query
// parameter.
router.get('/summary', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  if (!me) return res.status(401).json({ error: 'Not signed in' });
  // The company's own day decides which month is "this month": receipt dates
  // are written where the claimant is, not in UTC.
  const company = users.getCompany(me.companyId);
  res.json(summary(me, { timezone: company?.timezone || users.DEFAULT_TIMEZONE, base: company?.baseCurrency }));
});

module.exports         = router;
module.exports.health  = health;
module.exports.gitHead = gitHead;
module.exports.COMMIT  = COMMIT;
