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

  // Rates cached before the providers were asked the other way round carry only
  // the digits the provider printed in that direction — 0.000072 for a rupiah,
  // two significant figures, which puts a ten-million-rupiah bill SGD 2.69 out.
  // Dropping the provider rows makes them refetch at full precision the next
  // time one is needed. Manual rates are somebody's decision and are left
  // alone, and every rate already frozen on an expense line stays frozen, so
  // no report that has been submitted moves.
  _step(1, 'refetch cached provider rates at full precision', () => {
    db.prepare("DELETE FROM fx_rates WHERE source != 'manual'").run();
  });
}

module.exports = { run, _ensureColumn, _step };
