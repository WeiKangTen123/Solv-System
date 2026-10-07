// A fatal exit under pm2 is one silent restart. Say why — in the log, and in
// Slack when a webhook is configured — and exit once the post has gone (or
// failed); ecosystem.config.js's backoff keeps a crash loop from becoming a
// storm. It used to exit after a fixed 1.5 s while the post was allowed 4 s,
// so a slow Slack lost the one message that said why.
let _fatal = false;
function fatal(kind, msg) {
  console.error(`${kind}:`, msg);
  if (_fatal) return;
  _fatal = true;
  try { require('./utils/logger').error(kind, { error: msg }); } catch {}
  let sent = Promise.resolve();
  try { sent = require('./utils/notify').notifyError({ context: `${kind} — process exiting`, error: String(msg) }).catch(() => {}); } catch {}
  const cap = new Promise(resolve => setTimeout(resolve, 5000).unref());
  Promise.race([sent, cap]).finally(() => process.exit(1));
}
process.on('uncaughtException', err => {
  if (err.code === 'EADDRINUSE') { console.error(`Port ${process.env.PORT || 4000} is already in use.`); process.exit(1); }
  fatal('FATAL CRASH', `${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', err => fatal('FATAL REJECTION', err?.stack || err?.message || String(err)));

// When this process started: a receipt still 'reading' from before it was
// being read by the process this one replaced (receipts/recover.js).
const BOOT_AT = new Date().toISOString();

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const morgan      = require('morgan');
const logger      = require('./utils/logger');
const { rateLimitKey } = require('./middleware/rate-limit-key');

// No signing secret, no server: checked here rather than on the first login,
// so a misconfigured box refuses to start instead of starting open.
require('./middleware/auth-middleware').jwtSecret();

require('./db/migrate').run();

const app  = express();
const PORT = process.env.PORT || 4000;
const PROD = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'"], connectSrc: ["'self'"],
      frameSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"],
    },
  },
}));
app.use(compression());
app.set('trust proxy', 1);
// The access log records paths, never query strings, and never a phone-capture
// link's token. Receipt-image links, export links and Xero's sign-in code all
// travel in the query string, and every one of them used to be written to
// combined.log for anyone who could read it to replay.
app.use((req, res, next) => {
  req.id = require('crypto').randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});
morgan.token('id', req => req.id);
morgan.token('safe-url', req => String(req.originalUrl || req.url || '').split('?')[0].replace(/\/capture\/[^/]+/, '/capture/[token]'));
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :id',
  { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false,
                    message: { error: 'Too many requests — slow down' } }));
// 100 KB of JSON is plenty for everything except a file. The three routes that
// take one parse their own 25 MB body after checking who is asking (receipts
// and claims routes); a body parsed here, before any route, was 25 MB for
// anyone at all, the login form included.
const LARGE_BODY_ROUTE = /^\/api\/(receipts\/?$|receipts\/capture\/[^/]+\/?$|claims\/import\/?$)/;
const smallJson = express.json({ limit: '100kb' });
app.use((req, res, next) => (req.method === 'POST' && LARGE_BODY_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
// One plain value per query parameter. The parser turns ?from=a&from=b into an
// array and ?a[b]=1 into an object, and the stores bind query values straight
// into SQL, where either became "Too many parameter values" and a 500.
app.use('/api', (req, res, next) => {
  for (const v of Object.values(req.query || {})) {
    if (typeof v !== 'string') return res.status(400).json({ error: 'Each query parameter may be given once, as plain text.' });
  }
  next();
});

const authRoutes      = require('./routes/auth');
const userRoutes      = require('./routes/users');
const companyRoutes   = require('./routes/company');
const receiptRoutes   = require('./routes/receipts');
const expenseRoutes   = require('./routes/expenses');
const claimRoutes     = require('./routes/claims');
const fxRoutes        = require('./routes/fx');
const reportRoutes    = require('./routes/reports');
const xeroRoutes      = require('./routes/xero');
const dashRoutes      = require('./routes/dashboard');
const assistantRoutes = require('./routes/assistant');
app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/company',   companyRoutes);
app.use('/api/receipts',  receiptRoutes);
app.use('/api/expenses',  expenseRoutes);
app.use('/api/claims',    claimRoutes);
app.use('/api/fx',        fxRoutes);
app.use('/api/reports',   reportRoutes);
app.use('/api/xero',      xeroRoutes);
app.use('/api/dashboard', dashRoutes);
app.use('/api/assistant', assistantRoutes);
app.get('/dashboard/health', dashRoutes.health);

const UI_DIST = path.join(__dirname, '../ui/dist');
if (PROD) {
  app.use(express.static(UI_DIST, {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(path.sep + 'index.html')) res.setHeader('Cache-Control', 'no-store, must-revalidate');
      else if (filePath.includes(path.sep + 'assets' + path.sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Asset not found'));
  app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-store, must-revalidate'); res.sendFile(path.join(UI_DIST, 'index.html')); });
} else {
  app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/', (_req, res) => res.json({ app: 'Solv Expense Claims API', status: 'running', ui: 'npm run dev:ui', health: '/dashboard/health' }));
}

// A body that is too large or not JSON is the caller's mistake and says so;
// an error made to be shown (`expose`, as utils/http-error sets) is shown;
// everything else is ours, logged in full and answered without the details.
// A route that had already started its answer cannot be given a second one:
// Express is handed the error and closes the connection, rather than this
// throwing ERR_HTTP_HEADERS_SENT and leaving the client to time out.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status < 500) {
    const msg = err.type === 'entity.too.large' ? 'That request is too large.'
      : err.type === 'entity.parse.failed' ? 'That request is not valid JSON.'
      : err.expose && err.message ? err.message : 'Bad request';
    return res.status(status).json({ error: msg, ...(err.expose && err.extra ? err.extra : {}) });
  }
  logger.error('Unhandled error', { requestId: req.id, method: req.method, path: String(req.originalUrl || '').split('?')[0], error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

const HOST = process.env.HOST || (PROD ? '127.0.0.1' : '0.0.0.0');
const server = app.listen(PORT, HOST, () => {
  logger.info(`Solv server running on ${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`);
  // recoverPendingJobs is async, so the try/catch this used to sit in
  // caught only its synchronous prologue; a rejection went to
  // unhandledRejection, which exits the process — a crash loop at boot.
  require('./claims/claim-worker').recoverPendingJobs()
    .catch(err => logger.warn('Could not recover pending import jobs', { error: err.message }));

  // Re-prices anything left without an exchange rate because a provider was
  // unreachable when the receipt was read. Quarter-hourly, small batches.
  require('./fx/sweeper').start();

  // The live exchange-rate board: refreshed through the day, and closed into
  // the daily log at 23:55 company time. See fx/live.js.
  require('./fx/live').start();

  // The assistant's usage rows feed an hourly limit and a 30-day count, so a
  // daily sweep keeps them to a month.
  assistantRoutes.pruneUsage();
  setInterval(assistantRoutes.pruneUsage, 24 * 60 * 60 * 1000).unref();

  // Receipts a restart left half-read are read again, or released with a note.
  require('./receipts/recover').recoverStuckReads({ before: BOOT_AT })
    .catch(err => logger.warn('Could not recover interrupted reads', { error: err.message }));

  // Copies of receipts left in the temp folder by a PDF read this process's
  // predecessor did not finish: an exit skips the read's own clean-up.
  require('./pdf/workers').sweepStaleTemp();
});

// pm2 sends SIGINT on a reload and waits kill_timeout before killing. Stop
// taking requests and give the reads under way that long to land; whatever
// does not is picked up by recoverStuckReads on the next boot. The rate timers
// stop first, so a tick does not start new provider calls and writes inside
// the drain, and the database is closed last so its WAL is checkpointed.
let _stopping = false;
function shutdown(signal) {
  if (_stopping) return;
  _stopping = true;
  logger.info('Shutting down', { signal });
  server.close();
  try { require('./fx/sweeper').stop(); require('./fx/live').stop(); } catch {}
  const deadline = new Promise(resolve => setTimeout(resolve, 6500).unref());
  Promise.race([receiptRoutes._drain(), deadline]).finally(() => {
    try { require('./db').close(); } catch {}
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
