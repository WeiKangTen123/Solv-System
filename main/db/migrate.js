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
  // What a rate is checked against: the other provider, and the last rate known
  // for the pair.
  _ensureColumn('fx_rates', 'divergence', 'divergence REAL');
  _ensureColumn('fx_rates', 'moved', 'moved REAL');
  // The date the policy asked for (a weekend, or a day the currency has no
  // published rate for), kept beside the date the provider actually priced.
  _ensureColumn('expense_lines', 'fx_asked_date', 'fx_asked_date TEXT');
  _ensureColumn('expense_lines', 'fx_check', 'fx_check TEXT');

  // Rates cached before the providers were asked the other way round carry only
  // the digits the provider printed in that direction — 0.000072 for a rupiah,
  // two significant figures, which puts a ten-million-rupiah bill SGD 2.69 out.
  // Dropping the provider rows makes them refetch at full precision the next
  // time one is needed. Manual rates are somebody's decision and are left
  // alone, and every rate already frozen on an expense line stays frozen, so
  // no report that has been submitted moves.
  // SQLite cannot alter a CHECK constraint, so allowing a third report kind
  // means rebuilding the table around the new one. Everything else about it is
  // unchanged, and the rows are copied straight across.
  _step(2, 'allow a report kind of case', () => {
    const has = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expense_reports'").get();
    if (!has || /'case'/.test(has.sql)) return;
    const on = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(has.sql.replace("CHECK (kind IN ('trip', 'period'))", "CHECK (kind IN ('trip', 'period', 'case'))")
                       .replace('expense_reports', 'expense_reports_rebuilt'));
        db.exec('INSERT INTO expense_reports_rebuilt SELECT * FROM expense_reports');
        db.exec('DROP TABLE expense_reports');
        db.exec('ALTER TABLE expense_reports_rebuilt RENAME TO expense_reports');
      })();
    } finally {
      if (on) db.pragma('foreign_keys = ON');
    }
  });

  _step(1, 'refetch cached provider rates at full precision', () => {
    db.prepare("DELETE FROM fx_rates WHERE source != 'manual'").run();
  });
}

module.exports = { run, _ensureColumn, _step };
