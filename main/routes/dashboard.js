const express    = require('express');
const router     = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const users      = require('../store/users');
const { summary } = require('../store/summary');

// The commit this process is running. deploy.sh sets DEPLOY_SHA when it
// starts the process; otherwise the checkout is asked once. Health reports it
// so a deploy can prove the RUNNING process is on the shipped commit, not
// only that the files on disk are.
const COMMIT = process.env.DEPLOY_SHA || (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: require('path').join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return 'unknown'; }
})();

// GET /health — used by deployment health checks (no auth required). Exported
// alongside the router so index.js can also serve it at the legacy
// /dashboard/health path without duplicating the payload.
function health(_req, res) {
  res.json({ status: 'healthy', commit: COMMIT, timestamp: new Date().toISOString() });
}

router.get('/health', health);

// GET /summary — the dashboard's figures, aggregated in SQL and scoped to what
// this person may see: their own expenses, a manager's team, or the company for
// finance and admin. The scope is decided here from the caller's own row, never
// from a query parameter.
router.get('/summary', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  if (!me) return res.status(401).json({ error: 'Not signed in' });
  res.json(summary(me, users.getAllUsers(me.companyId)));
});

module.exports        = router;
module.exports.health = health;
