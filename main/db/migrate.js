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

  // Steps run in ascending order, because each one stamps the database with its
  // own number and a lower number is then skipped for good.

  // 1. Rates cached before the providers were asked the other way round carry
  // only the digits the provider printed in that direction — 0.000072 for a
  // rupiah, two significant figures, which puts a ten-million-rupiah bill SGD
  // 2.69 out. Dropping the provider rows makes them refetch at full precision
  // the next time one is needed. Manual rates are somebody's decision and are
  // left alone, and every rate already frozen on an expense line stays frozen,
  // so no report that has been submitted moves.

  // 2. SQLite cannot alter a CHECK constraint, so allowing a third report kind
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
        // DROP TABLE took the table's indexes with it, and schema.sql ran
        // before this step, so its CREATE INDEX IF NOT EXISTS statements have
        // already been satisfied and will not run again until the next boot.
        db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      })();
    } finally {
      if (on) db.pragma('foreign_keys = ON');
    }
  });

  // A receipt can be claimed on its own, so the column is ensured for databases
  // that predate it. Deliberately not part of the status CHECK: an expense's
  // status says how well the reader did, and claiming is a separate question.
  _ensureColumn('expenses', 'claimed_at', 'claimed_at TEXT');

  // Numbered 3, not 1: a database that booted on the build where the steps were
  // declared out of order is stamped 2, and would skip a step numbered below
  // that for ever — while being precisely the database still holding rates
  // fetched to two significant figures.
  _step(3, 'refetch cached provider rates at full precision', () => {
    db.prepare("DELETE FROM fx_rates WHERE source != 'manual'").run();
  });

  // 4. The system records claims; it does not pay anybody. The last step used
  // to be finance marking a report paid, which said something the software had
  // no way of knowing. It is now the claimant marking it claimed. Another CHECK
  // constraint, so another rebuild.
  //
  // The column list is read from the table rather than written out here: an
  // earlier _ensureColumn may have added a column this file does not name, and
  // `INSERT ... SELECT *` cannot carry 'paid' across a CHECK that no longer
  // allows it. Each column is copied by name, with status translated on the way.
  _step(4, 'a report is claimed by its owner, not paid by finance', () => {
    const has = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expense_reports'").get();
    if (!has || /'claimed'/.test(has.sql)) return;
    const cols = db.prepare('PRAGMA table_info(expense_reports)').all().map(c => c.name);
    const select = cols.map(c => {
      if (c === 'status') return "CASE status WHEN 'paid' THEN 'claimed' ELSE status END";
      return `"${c}"`;
    }).join(', ');
    const target = cols.map(c => `"${c === 'paid_at' ? 'claimed_at' : c}"`).join(', ');
    const on = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(has.sql
          .replace("'rejected', 'paid', 'posted'", "'rejected', 'claimed', 'posted'")
          .replace(/\bpaid_at\b/g, 'claimed_at')
          .replace('expense_reports', 'expense_reports_rebuilt'));
        db.exec(`INSERT INTO expense_reports_rebuilt (${target}) SELECT ${select} FROM expense_reports`);
        db.exec('DROP TABLE expense_reports');
        db.exec('ALTER TABLE expense_reports_rebuilt RENAME TO expense_reports');
        db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));   // the indexes DROP TABLE took with it
      })();
    } finally {
      if (on) db.pragma('foreign_keys = ON');
    }
  });

  // 5. Two roles and two states. The system records claims; it does not route
  // them through anybody, so there is nobody for a manager or finance role to
  // be, and nothing for a report to be between open and claimed.
  //
  // Everyone who was not an admin becomes a user; nobody reports to anybody.
  // A report that was draft, submitted, approved or rejected is open — it had
  // not been claimed. Claimed stays claimed, and posted becomes claimed: it was
  // in Xero, which is further along than claimed, and xero_invoice_id still
  // says so. The columns the old chain wrote to are not carried; the events
  // table keeps that history for anyone who wants it.
  _step(5, 'two roles, two states', () => {
    const users = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (users && /'manager'/.test(users.sql)) {
      _rebuild('users', { role: "CASE role WHEN 'admin' THEN 'admin' ELSE 'user' END" });
    }
    const reports = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expense_reports'").get();
    if (reports && !/'open'/.test(reports.sql)) {
      _rebuild('expense_reports', { status: "CASE status WHEN 'claimed' THEN 'claimed' WHEN 'posted' THEN 'claimed' ELSE 'open' END" });
    }
  });
}

// Rebuilds one table to the shape schema.sql now gives it, carrying every row
// across. SQLite cannot alter a CHECK constraint or drop a column that one
// mentions, so the third time this was needed it became a function.
//
// The new table is created from schema.sql's own DDL, so there is exactly one
// definition of the shape. Rows are copied column by column over the
// intersection of old and new: a column schema.sql has dropped is simply not
// carried, and `translate` supplies a SQL expression for any column whose old
// values the new CHECK would refuse.
function _rebuild(table, translate = {}) {
  const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
  if (!ddl) throw new Error(`schema.sql has no CREATE TABLE for ${table}`);
  const on = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(ddl[0].replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_rebuilt (`));
      const oldCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      const newCols = db.prepare(`PRAGMA table_info(${table}_rebuilt)`).all().map(c => c.name);
      const cols = newCols.filter(c => oldCols.includes(c));
      const select = cols.map(c => translate[c] || `"${c}"`).join(', ');
      db.exec(`INSERT INTO ${table}_rebuilt (${cols.map(c => `"${c}"`).join(', ')}) SELECT ${select} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_rebuilt RENAME TO ${table}`);
      db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));   // the indexes DROP TABLE took with it
    })();
  } finally {
    if (on) db.pragma('foreign_keys = ON');
  }
}

// Re-exported for callers that already have migrate loaded. Anything that only
// wants the number requires db/schema-version directly: see the note there.
const { LATEST } = require('./schema-version');

module.exports = { run, LATEST, _ensureColumn, _step };
