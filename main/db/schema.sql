-- Solv Expense Claims — SQLite schema. Money is INTEGER cents; timestamps are UTC ISO strings.

CREATE TABLE IF NOT EXISTS companies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  base_currency  TEXT NOT NULL DEFAULT 'SGD',
  fx_policy      TEXT NOT NULL DEFAULT 'receipt_date' CHECK (fx_policy IN ('receipt_date', 'submission_date', 'monthly_fixed')),
  timezone       TEXT NOT NULL DEFAULT 'Asia/Singapore',
  report_columns TEXT NOT NULL DEFAULT '[]',   -- JSON array of category names, in report column order
  logo           TEXT,
  next_report_no INTEGER NOT NULL DEFAULT 1,
  allow_registration INTEGER NOT NULL DEFAULT 0,   -- may people create their own account (Company settings)
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        TEXT NOT NULL UNIQUE,
  password     TEXT NOT NULL,
  name         TEXT,
  employee_id  TEXT,
  department   TEXT,
  role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  disabled_at  TEXT,                                -- removed: cannot sign in, records kept
  token_version INTEGER NOT NULL DEFAULT 0          -- bumped to end every session (sign-out, new password, removal)
);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- Company-level connections. Secrets are AES-256-GCM encrypted (utils/crypto.js).
CREATE TABLE IF NOT EXISTS company_credentials (
  company_id               TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  xero_client_id           TEXT,
  xero_client_secret       TEXT,
  xero_oauth_client_id     TEXT,
  xero_oauth_client_secret TEXT,
  xero_oauth_refresh_token TEXT,
  xero_oauth_connected_at  TEXT,
  xero_connection_type     TEXT,
  default_account_code     TEXT
);

CREATE TABLE IF NOT EXISTS company_gemini_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  api_key    TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_gemini_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key    TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_gemini_keys ON user_gemini_keys(user_id);

CREATE TABLE IF NOT EXISTS xero_tenants (
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  tenant_name  TEXT,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (company_id, tenant_id)
);

-- One stored file. Several expenses may point at one receipt (a photo of several
-- receipts, or a batch import that reuses a byte-identical file).
CREATE TABLE IF NOT EXISTS receipts (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT,
  pages         INTEGER,
  source        TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'phone', 'import')),
  group_id      TEXT,
  original_name TEXT,
  received_at   TEXT NOT NULL,
  parsed_at     TEXT,
  parse_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_receipts_hash ON receipts(company_id, sha256);

CREATE TABLE IF NOT EXISTS expense_reports (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number          TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'trip' CHECK (kind IN ('trip', 'period', 'case')),
  title           TEXT,
  purpose         TEXT,
  period_from     TEXT,
  period_to       TEXT,
  destination     TEXT,
  nights          INTEGER,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed')),
  advances_cents  INTEGER NOT NULL DEFAULT 0,
  claimed_at      TEXT,
  xero_invoice_id TEXT,
  xero_error      TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_user ON expense_reports(user_id, status);

CREATE TABLE IF NOT EXISTS expenses (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id     TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  report_id      TEXT REFERENCES expense_reports(id) ON DELETE SET NULL,
  merchant       TEXT,
  receipt_date   TEXT,
  receipt_time   TEXT,
  invoice_no     TEXT,
  currency       TEXT,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  tax_cents      INTEGER,
  subtotal_cents INTEGER,
  purpose        TEXT,
  description    TEXT,
  category       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('reading', 'review-needed', 'reviewed', 'duplicate', 'rejected')),
  duplicate_of   TEXT REFERENCES expenses(id) ON DELETE SET NULL,
  error_msg      TEXT,
  ai_read_at     TEXT,
  ai_confidence  TEXT,
  ai_read        TEXT,      -- JSON: what the reader first read off the receipt, kept beside later edits
  box            TEXT,      -- JSON [ymin,xmin,ymax,xmax] 0-1000 when one photo held several receipts
  page           INTEGER,   -- 1-based page when one PDF page is its own receipt
  source         TEXT NOT NULL DEFAULT 'upload',
  claimed_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_user    ON expenses(user_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_report  ON expenses(report_id);
CREATE INDEX IF NOT EXISTS idx_expenses_receipt ON expenses(receipt_id);

CREATE TABLE IF NOT EXISTS expense_lines (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id         TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  category           TEXT,
  description        TEXT,
  amount_cents       INTEGER NOT NULL DEFAULT 0,
  currency           TEXT,
  fx_rate            REAL,
  fx_rate_date       TEXT,
  fx_source          TEXT,
  fx_fetched_at      TEXT,
  fx_policy          TEXT,
  fx_override_by     TEXT,
  fx_override_reason TEXT,
  fx_asked_date      TEXT,   -- the date the policy asked for, which is not always the date the provider priced
  fx_check           TEXT,   -- a sentence when the rate could not be trusted as it came
  base_cents         INTEGER,
  on_behalf_of       TEXT,
  account_code       TEXT
);
CREATE INDEX IF NOT EXISTS idx_lines_expense ON expense_lines(expense_id);

CREATE TABLE IF NOT EXISTS fx_rates (
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate_date  TEXT NOT NULL,
  rate       REAL NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  divergence REAL,           -- how far the second provider was from this one, as a fraction
  moved      REAL,           -- how far this rate moved from the last one known for the pair
  PRIMARY KEY (base, quote, rate_date, source)
);

-- The live board (fx/live.js). The latest rate for every currency a company
-- watches, refreshed on a schedule; same direction as fx_rates, one unit of
-- `base` in `quote` (INR → SGD is base INR, quote SGD). Replaced in place on
-- each refresh: the history is the daily close, written into fx_rates.
CREATE TABLE IF NOT EXISTS fx_live (
  base          TEXT NOT NULL,
  quote         TEXT NOT NULL,
  rate          REAL NOT NULL,
  source        TEXT NOT NULL,
  provider_date TEXT,            -- the day the provider says the rate is for
  provider_time TEXT,            -- when the provider last moved it, where it says
  fetched_at    TEXT NOT NULL,
  divergence    REAL,            -- how far the other provider was, as a fraction
  PRIMARY KEY (base, quote)
);

-- Currencies an admin asked to watch before any receipt used them. Every
-- currency a receipt has used is watched without being listed here.
CREATE TABLE IF NOT EXISTS fx_watch (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  currency   TEXT NOT NULL,
  added_by   TEXT,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (company_id, currency)
);

-- One row per company per day the close has been taken, so a restart neither
-- takes it twice nor forgets to take it.
CREATE TABLE IF NOT EXISTS fx_closes (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  close_date TEXT NOT NULL,
  closed_at  TEXT NOT NULL,
  summary    TEXT,
  PRIMARY KEY (company_id, close_date)
);

-- Every change to a receipt's details after it was read: who, when, which
-- field, from what to what, and whether it came from the page, the assistant
-- or a re-read. The owner sees it on the receipt; nothing deletes a row but
-- deleting the receipt itself.
CREATE TABLE IF NOT EXISTS expense_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  actor_id    TEXT,
  actor_role  TEXT,            -- owner | admin
  via         TEXT NOT NULL DEFAULT 'app',   -- app | assistant | reread
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_expense ON expense_changes(expense_id, id);

-- The assistant (main/assistant). A conversation is its owner's alone: no
-- route returns one to anybody else, admins included.
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON assistant_conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_conv ON assistant_messages(conversation_id, id);

-- A change the assistant proposed. Nothing changes until its person presses
-- Apply, and then it goes through receipts/edit.js like any other edit.
CREATE TABLE IF NOT EXISTS assistant_actions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id      INTEGER,
  user_id         TEXT NOT NULL,
  expense_id      TEXT,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  summary         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'failed')),
  result          TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_conv ON assistant_actions(conversation_id);

-- One row per question asked, with no content: the hourly limit counts it,
-- and Users & Monitoring shows how much each person uses the assistant.
-- Kept apart from the messages so deleting a conversation resets neither.
CREATE TABLE IF NOT EXISTS assistant_usage (
  user_id TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON assistant_usage(user_id, at);

CREATE TABLE IF NOT EXISTS report_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
  actor_id  TEXT,
  action    TEXT NOT NULL,
  note      TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_report ON report_events(report_id);
