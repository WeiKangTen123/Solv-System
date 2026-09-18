function fatal(kind, msg) {
  console.error(`${kind}:`, msg);
  try { require('./utils/logger').error(kind, { error: msg }); } catch {}
  setTimeout(() => process.exit(1), 1500).unref();
}
process.on('uncaughtException', err => {
  if (err.code === 'EADDRINUSE') { console.error(`Port ${process.env.PORT || 4000} is already in use.`); process.exit(1); }
  fatal('FATAL CRASH', `${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', err => fatal('FATAL REJECTION', err?.stack || err?.message || String(err)));

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const morgan      = require('morgan');
const logger      = require('./utils/logger');
const { rateLimitKey } = require('./middleware/rate-limit-key');

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
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false,
                    message: { error: 'Too many requests — slow down' } }));
// Files arrive as base64 inside JSON (4/3 inflation): 25 MB carries a 15 MB original.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

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

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const HOST = process.env.HOST || (PROD ? '127.0.0.1' : '0.0.0.0');
app.listen(PORT, HOST, () => {
  logger.info(`Solv server running on ${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`);
  try { require('./claims/claim-worker').recoverPendingJobs(); } catch (err) { logger.warn('Job recovery skipped', { error: err.message }); }
});

module.exports = app;
