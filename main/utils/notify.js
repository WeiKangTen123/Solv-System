// A fatal exit under pm2 is one silent restart: the process dies, pm2 starts
// it again, and unless somebody is reading the logs nobody learns that it
// happened. This posts the reason to Slack first, so a crash loop announces
// itself instead of being discovered days later.
//
// Silent by design when SLACK_WEBHOOK_URL is unset, which is every developer
// machine and every test run. It never throws and never rejects: the caller
// is usually a process that is already on its way out, and an alert that
// crashes the crash handler loses the message it was sent to deliver.
const logger = require('./logger');

const TIMEOUT_MS = 4000;
const LIMIT = 1500; // Slack truncates a long block anyway; a stack tail is enough to name the file.

function webhook() {
  const url = (process.env.SLACK_WEBHOOK_URL || '').trim();
  return /^https:\/\//.test(url) ? url : null;
}

// `where` names the deployment, so two boxes posting to one channel are
// telling you apart rather than both saying "the server crashed".
function where() {
  const host = process.env.DEPLOY_NAME || process.env.HOSTNAME || '';
  const sha = (process.env.DEPLOY_SHA || '').slice(0, 7);
  return [host, sha && `commit ${sha}`].filter(Boolean).join(' · ') || 'unnamed host';
}

async function notifyError({ context, error }) {
  const url = webhook();
  if (!url) return { sent: false, reason: 'no webhook configured' };
  const text = `*Solv Expenses* — ${context}\n_${where()}_\n\`\`\`${String(error).slice(0, LIMIT)}\`\`\``;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { sent: false, reason: `Slack answered ${res.status}` };
    return { sent: true };
  } catch (err) {
    // Logged, not thrown: see the header.
    try { logger.warn('Could not post the failure to Slack', { error: err.message }); } catch {}
    return { sent: false, reason: err.message };
  }
}

module.exports = { notifyError };
