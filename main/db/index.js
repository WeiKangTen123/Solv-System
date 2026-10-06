const path     = require('path');
const Database = require('better-sqlite3');

// Tests get an isolated in-memory DB per process; production and dev use a
// file under DATA_DIR so data survives restarts.
const DB_PATH = process.env.NODE_ENV === 'test'
  ? ':memory:'
  : (process.env.DB_PATH || path.join(require('../utils/paths').DATA_DIR, 'app.db'));

if (DB_PATH !== ':memory:') require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Every db.prepare(sql) compiled the statement afresh, and the stores call it
// on every request: listing 2,500 receipts compiled 5,000 statements. A
// statement is compiled once per distinct SQL text and reused. better-sqlite3
// re-prepares a statement itself after a schema change, and nothing here
// uses the modes (pluck, raw, expand, iterate) that would make sharing one
// unsafe. Bounded, oldest out, for SQL built on the fly.
const STATEMENTS_KEPT = 1000;
const _prepare = db.prepare.bind(db);
const _statements = new Map();
db.prepare = sql => {
  let st = _statements.get(sql);
  if (st) return st;
  st = _prepare(sql);
  if (_statements.size >= STATEMENTS_KEPT) _statements.delete(_statements.keys().next().value);
  _statements.set(sql, st);
  return st;
};

module.exports = db;
module.exports.path = DB_PATH;
