const fs   = require('fs');
const path = require('path');
const db   = require('./index');

// SQLite has no ADD COLUMN IF NOT EXISTS, so columns added after a deploy are
// ensured here explicitly. Steps numbered through PRAGMA user_version run once.
function _ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// A step that fails stops the boot. It used to log a warning and carry on, so
// the server ran on a half-migrated schema and failed later, somewhere less
// obvious; refusing to start is what pm2, the deploy's health check and the
// crash alert can all see.
function _step(n, name, fn) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= n) return;
  try { fn(); db.pragma(`user_version = ${n}`); }
  catch (err) {
    require('../utils/logger').error(`migration step ${n} (${name}) failed`, { error: err.message });
    throw new Error(`Migration step ${n} (${name}) failed: ${err.message}`);
  }
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
  // Set when a row is the day's close (fx/live.js): the rate that day's
  // receipts are priced at, ahead of any lookup made for the same day.
  _ensureColumn('fx_rates', 'closed_at', 'closed_at TEXT');
  // An Open Exchange Rates App ID, for a live board that moves within the day.
  _ensureColumn('company_credentials', 'fx_oxr_app_id', 'fx_oxr_app_id TEXT');
  // The account an advance already paid is cleared against on the bill. It
  // used to be taken off the default expense account, which understated the
  // expense and left the advance owed for ever.
  _ensureColumn('company_credentials', 'advances_account_code', 'advances_account_code TEXT');
  // What the reader last saw from each key, so Settings can say which one
  // works and which ran out — rather than only listing them.
  for (const table of ['company_gemini_keys', 'user_gemini_keys']) {
    _ensureColumn(table, 'last_ok_at', 'last_ok_at TEXT');
    _ensureColumn(table, 'last_error_at', 'last_error_at TEXT');
    _ensureColumn(table, 'last_error', 'last_error TEXT');
    _ensureColumn(table, 'last_model', 'last_model TEXT');
  }
  // Removing a person ends their access and keeps their records: deleting the
  // row cascaded through every receipt and case they ever made, while the
  // screen promised "their expenses stay".
  _ensureColumn('users', 'disabled_at', 'disabled_at TEXT');
  // Bumped on sign-out, on a password change and on removal; a session token
  // carries the number it was issued under and dies when they differ.
  _ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
  // Whether people may create their own account, set by an admin in Company
  // settings. It used to be an environment variable, which meant closing it
  // took a server login.
  _ensureColumn('companies', 'allow_registration', 'allow_registration INTEGER NOT NULL DEFAULT 0');
  // What the reader last read off the receipt, kept beside what the receipt
  // now says, so an amount that drifted from the paper is visible.
  _ensureColumn('expenses', 'ai_read', 'ai_read TEXT');
  // Which claim import made a row, so an interrupted import that runs again
  // first removes what its last attempt saved, and an undo finds the rows
  // that have no receipt file to be found by.
  _ensureColumn('expenses', 'import_id', 'import_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_import ON expenses(import_id)');
  // "Duplicate of" points one expense at another with ON DELETE SET NULL, so
  // every expense deleted made SQLite look through all of them for rows
  // pointing at it: undoing a 500-receipt import froze the server for about
  // five seconds at 20,000 receipts, against milliseconds with the index.
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_duplicate_of ON expenses(duplicate_of)');
  // The receipts a file was split into (a folio's pages, a photo of three),
  // asked for every time one of them is opened, and by an import's undo.
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_group ON receipts(group_id)');
  // When the sweeper last tried to price a line and failed, so a line that can
  // never be priced stops holding the batch (fx/sweeper.js).
  _ensureColumn('expense_lines', 'fx_tried_at', 'fx_tried_at TEXT');
  // What a HEIC, WebP, TIFF, GIF or AVIF was before the server made it a JPEG
  // or PDF (intake/convert.js); only the converted file is kept.
  _ensureColumn('receipts', 'converted_from', 'converted_from TEXT');
  // Where a receipt was spent and what kind of document it is, as the reader
  // read them, so a case can be named and dated from its receipts.
  _ensureColumn('expenses', 'city', 'city TEXT');
  _ensureColumn('expenses', 'country', 'country TEXT');
  _ensureColumn('expenses', 'doc_type', 'doc_type TEXT');
  // Each person's forwarding address for receipts (routes/inbound.js),
  // receipts+<token>@INBOUND_EMAIL_DOMAIN, made the first time they ask for
  // it. Unique when set, so one address can only ever be one person's.
  _ensureColumn('users', 'inbound_token', 'inbound_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_inbound_token ON users(inbound_token) WHERE inbound_token IS NOT NULL');

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

  // 6. Sessions became revocable and expire in a day. Every token issued
  // before carries no version, which reads as 0; moving everyone to 1 signs
  // each of them out once rather than leaving week-long tokens alive.
  _step(6, 'end every session issued before revocable sign-in', () => {
    db.prepare('UPDATE users SET token_version = token_version + 1').run();
  });

  // 7. The exchange-rate board starts with ten currencies (intake/currencies.js
  // DEFAULT_BOARD) instead of only those receipts had used. A company made
  // before that gets them once, up to the ten an admin may choose, beside any
  // it already chose; one an admin takes off later stays off, because this
  // step does not run again.
  _step(7, 'put the default currencies on every exchange-rate board', () => {
    const { DEFAULT_BOARD, BOARD_MAX } = require('../intake/currencies');
    const at = new Date().toISOString();
    for (const c of db.prepare('SELECT id, base_currency FROM companies').all()) {
      const have = db.prepare('SELECT currency FROM fx_watch WHERE company_id = ? AND currency != ?').all(c.id, c.base_currency).map(r => r.currency);
      let room = BOARD_MAX - have.length;
      for (const code of DEFAULT_BOARD) {
        if (room <= 0) break;
        if (code === c.base_currency || have.includes(code)) continue;
        db.prepare("INSERT OR IGNORE INTO fx_watch (company_id, currency, added_by, added_at) VALUES (?, ?, 'default', ?)").run(c.id, code, at);
        room--;
      }
    }
  });

  // Which cover fields the AI wrote and which the owner set (store/reports.js),
  // so the AI fills a draft's cover as its receipts are read and never writes
  // over a field somebody typed.
  _ensureColumn('expense_reports', 'cover_ai', 'cover_ai TEXT');

  // 8. A case starts as a draft the moment its first receipt lands, and only
  // takes a number when its owner creates it, so a draft that is abandoned
  // leaves no gap in the numbers. Another CHECK constraint, and a NOT NULL
  // dropped, so another rebuild; every case already made keeps its number.
  // The store's default kind becomes 'case' with it.
  _step(8, 'a case starts as a draft with no number', () => {
    const has = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expense_reports'").get();
    if (!has || /'draft'/.test(has.sql)) return;
    _rebuild('expense_reports');
  });

  // 9. A receipt keeps what it printed (receipts/printed.js): every item,
  // charge and tax with its name and rate, and the rounding, as the receipt
  // shows them, where five figures and one line per category used to be all
  // that survived the read. Each claim line keeps the taxes inside its amount,
  // so the PDF and the Xero bill name the tax the receipt names: a Kuala
  // Lumpur hotel that printed Service Tax 8% of 24.64 and 6% of 5.61 went to
  // Xero as 23.46 and 6.79. Both nullable: null is a receipt from before
  // this, or one typed in, and it stays as it is.
  _step(9, 'a receipt keeps what it printed', () => {
    _ensureColumn('expenses', 'printed', 'printed TEXT');
    _ensureColumn('expense_lines', 'taxes', 'taxes TEXT');
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
