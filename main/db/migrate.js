const fs   = require('fs');
const path = require('path');
const db   = require('./index');

// SQLite has no ADD COLUMN IF NOT EXISTS, so columns added after a deploy are
// ensured here explicitly. Steps numbered through PRAGMA user_version run once.
function _ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function _step(n, name, fn) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= n) return;
  try { fn(); db.pragma(`user_version = ${n}`); }
  catch (err) { require('../utils/logger').warn(`migration step ${n} (${name}) skipped`, { error: err.message }); }
}

function run() {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Phase 2: which day the provider actually priced (a weekend asks for Friday), and who typed a manual rate.
  _ensureColumn('fx_rates', 'provider_date', 'provider_date TEXT');
  _ensureColumn('fx_rates', 'entered_by', 'entered_by TEXT');
}

module.exports = { run, _ensureColumn, _step };
