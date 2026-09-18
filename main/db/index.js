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

module.exports = db;
module.exports.path = DB_PATH;
