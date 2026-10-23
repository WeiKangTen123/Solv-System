# New case with receipts: plan and contract (2026-10-21)

Approved by the product owner on 2026-10-21 with every default below. This file
is the contract the work is built against: the data model, the API, the module
interfaces, the UI routes and who owns which files. Where code and this file
disagree after the work lands, the code wins and this file is history.

## Decisions (all defaults taken)

1. **Receipts first.** "New case" opens a page with a drop zone and the case
   details side by side. The first file saves a **draft** case; the AI fills the
   details as reads land; any field the person types is theirs and the AI stops
   touching it. "Create case" turns the draft into an open case with a number.
2. **No more automatic "Receipts, <date>" cases.** Home and My receipts send
   files to the New case page. A draft whose receipts all fall inside an open
   case's dates is offered that case instead ("Move them there").
3. **Kinds** stay `trip | period | case` in the database and read **Trip /
   Month / Other** on screen. The AI picks one; the person can change it at
   any time while the case is open. The store's default becomes `case`.
4. **Formats now:** JPG, PNG, PDF stored as they are; HEIC/HEIF, WebP, TIFF
   (multi-page becomes a PDF), GIF and AVIF converted to JPEG on the server;
   ZIP of receipts unpacked into the case; ZIP or XLSX with a claim form goes
   to the existing claim import. BMP is converted in the browser (canvas) and
   refused by the server. EML/MSG and an email-in address are Phase 6.
5. **Converted files:** only the converted JPEG (or PDF) is kept; the receipt
   row records what it was converted from.
6. **Big batches:** one call per receipt (accuracy), read through a durable
   queue that is fair between people and retries by itself when the AI is busy.
   The page shows "about N min left" and the person may leave it.
7. **Scope:** Phases 0-5 now; Phase 6 (email-in, per diem, mileage, admin
   rules, SSE, Xero single PDF) later.

## Data model

### Cases (`expense_reports`) — migration step 8, a `_rebuild`

- `number TEXT` becomes **nullable**. A draft has none; the number is taken from
  `companies.next_report_no` when the draft is opened, so abandoned drafts leave
  no gaps.
- `status` CHECK becomes `('draft', 'open', 'claimed')`, default stays `'open'`.
- `kind` default becomes `'case'` (CHECK unchanged).
- New column `cover_ai TEXT` (JSON, via `_ensureColumn`):
  `{"auto": ["kind","title","periodFrom","periodTo","destination","nights"], "user": ["purpose"]}`.
  `auto` = fields whose current value the AI wrote (shown with a marker);
  `user` = fields the owner set (the AI never writes them again).
- Editable means `draft` or `open` (`reports/workflow.js` `EDITABLE`). Only an
  `open` case can be claimed. A draft cannot be exported or posted.
- Every query that says `status = 'open'` must be read again and given `draft`
  where it means "still editable / not claimed": `fx/sweeper.js`, `fx/live.js`,
  `store/summary.js`, the assistant's case tools, `claims/claim-import.js`.

### Receipts and expenses

- `receipts.converted_from TEXT` — the original MIME type when the server
  converted the file (`image/heic`, `image/webp`, `image/tiff`, …), else null.
- `expenses.city TEXT`, `expenses.country TEXT` (ISO 3166-1 alpha-2),
  `expenses.doc_type TEXT` (`hotel | flight | ride | meal | fuel | parking |
  telco | other`). Written by the reader; `aiRead` gains the same three keys.
  Exposed on the expense object as `city`, `country`, `docType`.

### New tables (schema.sql, `CREATE TABLE IF NOT EXISTS`, no step needed)

```sql
CREATE TABLE IF NOT EXISTS read_jobs (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  receipt_id  TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  expense_id  TEXT REFERENCES expenses(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'reading', 'done', 'failed', 'cancelled')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     TEXT NOT NULL,
  error_kind  TEXT,            -- 'unavailable' | 'error'
  error       TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_read_jobs_pick ON read_jobs(state, next_at);
CREATE INDEX IF NOT EXISTS idx_read_jobs_receipt ON read_jobs(receipt_id);

CREATE TABLE IF NOT EXISTS phone_pairings (
  token_hash  TEXT PRIMARY KEY,   -- sha256 of the token; the token itself is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id   TEXT REFERENCES expense_reports(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  max_uses    INTEGER NOT NULL,
  revoked_at  TEXT,
  receipt_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_phone_pairings_user ON phone_pairings(user_id);
```

## Server API

All paths under `/api`. Existing behaviour not named here is unchanged.

### Cases

| Call | Contract |
|---|---|
| `POST /reports` | Body as today, plus `draft: true` → a draft (no number, `status: 'draft'`). Any non-empty cover field in the body goes into `cover_ai.user`. Without `draft` it creates an open case exactly as today. |
| `POST /reports/:id/open` | Owner; draft only (409 otherwise). Optional cover fields in the body are saved first (and become `user`). A missing title is filled from the suggestion, else `Receipts, <d Mon YYYY>`. Takes a number, status → `open`, event `opened`. Returns the case view. |
| `PATCH /reports/:id` | As today (owner, editable). Every cover field in the body moves to `cover_ai.user`. `kind` may change while editable. |
| `DELETE /reports/:id` | As today. `?withReceipts=1` is allowed **only on a draft** and deletes its receipts, their files and their read jobs too. Draft deletion without it leaves the receipts outside any case. |
| `POST /reports/:id/merge` | Body `{ into }`. Owner of both, both editable, not the same case. Moves every receipt of `:id` into `into`, adds an `edited` event to the target ("Merged N receipts from …"), deletes `:id`. Returns the target's case view. |
| `POST /reports/:id/expenses` | Body `{ expenseIds, move? }`. Each id goes through `receipts/edit.js fileInCase` (owner's own, not a duplicate, not claimed alone, both ends editable). **No longer requires reviewed.** In another case: moved when `move: true` and that case is editable, else skipped `already in another case`. Returns the case view plus `skipped: [{ id, why }]`. |
| `GET /reports` | Query: `scope=mine|all`, `status=draft,open,claimed`, `kind=trip,period,case`, `q` (title, number, purpose, destination, or a merchant in the case), `ready=1` (open, ≥1 receipt, nothing unchecked, unpriced or without an amount), `posted=1|0`, `owner=<userId>` (admin with `scope=all`), `sort=newest|oldest|amount|dates`, `limit`, `offset`. Returns `{ reports, total, counts }`. `counts` = `{ draft, open, ready, claimed, all }` for the same scope and owner, ignoring status/ready/q/paging. Without `limit` every row comes back, as today. Each row adds `reading` (receipts still being read) and `ready` (boolean). |
| `GET /reports/:id` | As today. The report adds `coverAi: { auto, user }`. Every expense in `report.expenses` adds `flags` (below). |
| `GET /reports/:id/intake` | **New, built at integration.** Owner or admin viewer. `{ caseId, status, counts: { files, queued, reading, done, failed, receipts, toCheck }, etaSeconds, files: [{ receiptId, originalName, mime, convertedFrom, sizeBytes, receivedAt, read: { state, attempts, nextAt, errorKind, error } \| null, expenses: [{ id, status, merchant, receiptDate, currency, total, baseTotal, category, city, country, docType, flags, errorMsg }] }], coverAi, suggestion, match }`. `suggestion` is the AI's cover from `suggestCover`; `match` is `findMatch`'s case or null. Not counted by the global rate limiter. |
| `GET /reports/:id/export-url` | 409 for a draft. |

A daily sweep (and one at boot) deletes drafts that have **no receipts** and
are older than 24 hours. Drafts with receipts are never deleted automatically.

### Receipts

| Call | Contract |
|---|---|
| `POST /receipts` | As today, but the file goes through `intake/convert.js` first (HEIC/HEIF/WebP/TIFF/GIF/AVIF → JPEG; multi-page TIFF → PDF), and the read is **queued** (`read_jobs`) instead of run in memory. 400 for a file that is none of the accepted kinds, with a message naming them. 415 is not used. Response adds `receipt.convertedFrom`. |
| `POST /receipts/archive` | **New.** Body `{ data, filename, reportId }` (base64 zip, same body limit as an upload). Owner's editable case required. Every receipt entry (jpg, jpeg, png, pdf, heic, heif, webp, tif, tiff, gif, avif) goes through `storeReceipt`. `{ stored: [{ receipt, expense }], skipped: [{ name, why }] }`. A zip that holds an `.xlsx` answers 409 `{ error, claimForm: true }` so the browser sends it to `/claims/import` instead. |
| `POST /receipts/:id/read/retry` | **New.** Owner. A queued or failed job is read again now (`next_at = now`, a failed one back to queued). |
| `DELETE /receipts/:id/read` | **New.** Owner. Cancels a queued job; its rows leave `reading` for `review-needed` with the note "Reading was stopped. Type the fields from the receipt, or press Re-read." |
| `POST /receipts/pair` etc. | As today, backed by `phone_pairings`: 30-minute life that slides with each upload, 50 uploads, at most 3 live per person, survives a restart. |

### Expenses

- `GET /expenses` adds `q` (merchant, description, invoice number), and each
  row adds `reportNumber`, `reportTitle`, `reportStatus` and `flags`.
- `GET /expenses/:id` adds `flags`.
- The duplicate messages no longer mention a "restore" that does not exist.

### Flags

`receipts/flags.js` → `flagsFor(expense, report | null, { baseCurrency, today })`
returns `[{ code, level: 'red' | 'yellow', text, field? }]`, computed on read,
never stored. Red stops a claim: `no-amount`, `no-merchant`, `no-date`,
`lines-off`, `no-rate`. Yellow is "have a look": `outside-case` (date outside
the case's from/to), `possible-duplicate` (`duplicateOf` set),
`currency-assumed` (the reader's assumed-currency note), `gst-mismatch` (SGD,
dated 2024 or later, tax shown and more than 2% or 0.05 away from 9/109 of the
total), `edited-amount` (total differs from `aiRead.total`), `future-date`.
A receipt still `reading` has no flags.

## Server modules

| Module | Owner | Interface |
|---|---|---|
| `intake/convert.js` | intake engine | `async toStorable(buffer, { declaredMime, filename })` → `{ buffer, mime, convertedFrom, note }`; throws an HttpError(400/413) with a person-readable message. JPEG output: EXIF-rotated, long edge ≤ 2400, white background, quality 85, metadata stripped. |
| `receipts/read-queue.js` | intake engine | `enqueue({ companyId, userId, receiptId, expenseId })`, `start()`, `stop()`, `async drain(ms)`, `statesFor(receiptIds) → Map`, `retryNow(receiptId)`, `cancel(receiptId)`, `setOnDone(fn(job))`, `recover()`, `_tick()` for tests. `READ_CONCURRENCY` (default 4) at once, `READ_PER_USER` (default 2) per person; the oldest job of the person with the fewest running goes next. AI busy (`unavailable`): retried after 1, 5, 15 and 60 minutes, then released with the existing note. Any other failure: once more after 30 s, then released. |
| `receipts/read-receipt.js` | intake engine (`readReceipt`), AI mapping (`applyRead`) | `readReceipt(args, { deferIfUnavailable })` → `{ expenseIds }` or `{ unavailable: true }` (rows untouched, still `reading`) when nothing was read because every key was busy. `applyRead` also writes `city`, `country`, `docType`. |
| `receipts/receipt-parser.js` | intake engine | The prompt asks for `city`, `country` (ISO-2, only when printed or plain from the address, phone code or tax name) and `docType`; `normalise` cleans them (unknown → null; country upper-case, 2 letters). |
| `reports/cover-suggest.js` | cases | `suggestCover(expenses, { baseCurrency, today })` → `{ kind, title, periodFrom, periodTo, destination, nights, basis }` or null; `findMatch(caseId, userId)` → `{ id, number, title, periodFrom, periodTo } \| null`. Rules below. |
| `reports/cover-auto.js` | cases | `refresh(reportId)`: draft → writes every field not in `user`; open → only `periodFrom`, `periodTo`, `destination`, `nights` not in `user`, and the dates widen only to a receipt within 3 days of them (a Month never widens); claimed → nothing. Updates `cover_ai.auto`. No event. Wired to `read-queue.setOnDone` at integration. (Changed after the QA pass on 2026-10-22: stretching to fit every receipt turned a reopened four-day trip into seven weeks.) |
| `receipts/flags.js` | cases | as above |

### Cover suggestion rules

- Use the case's receipts that are read and dated, duplicates left out.
- Home country from the base currency (SGD → SG, MYR → MY, …; unknown → SG).
- A receipt is **foreign** when its country is not home, or its currency is not
  the base currency. **Travel** documents are `hotel` and `flight`.
- **Kind:** any foreign or travel receipt → `trip`; else all in one calendar
  month → `period`; else `case`.
- **Trip:** from = earliest date, to = latest, nights = days between. Destination
  = up to three most frequent cities of the foreign receipts, then the country
  name when there is one country ("Mumbai, Pune, India"); several countries →
  their names. No city or country but a foreign currency → that currency's
  country. Title `"<Country> trip, Sep 2026"` (two countries "India and Sri
  Lanka trip, …", more → "Trip, …"; a span of months "Sep–Oct 2026").
- **Period:** the whole calendar month; title `"October 2026 claims"`.
- **Case:** earliest to latest; title `"Receipts, 3 Sep – 18 Oct 2026"`.
- **Purpose** is never suggested: the reader does not invent a business reason.
- **Match:** among the owner's other editable cases with both dates set, the one
  whose dates hold every dated receipt of this one; the narrowest wins.

## UI

### Routes

| Path | Page |
|---|---|
| `/reports` | Cases list (redesigned) |
| `/reports/new` | New case (`?draft=<id>` resumes one) |
| `/reports/:id` | Case page (redesigned). A draft redirects to `/reports/new?draft=<id>`. |
| `/reports/:id/review` | Review (split view). `/reports/:id/check` redirects here. |
| `/expenses` | My receipts (redesigned) |
| `/expenses/:id` | A receipt outside any case (kept); inside a case, its back link goes to the case. |

### Shared pieces (wave 1, UI foundations)

`ui/src/components/ui/`: `PageHeader`, `Tabs` (tablist, arrow keys,
`aria-selected`), `FilterChips` (`aria-pressed`, counts), `SearchInput`
(debounced), `EmptyState`, `Skeleton`, `DropZone` (drag and drop, click,
keyboard, `onFiles`, compact variant), `Stepper`, `ProgressBar`, `KindBadge`,
`FlagList`, `Pagination`. `ui/src/utils/format.js` gains `fmtDateRange(from,
to)` ("1–4 Sep 2026", "28 Sep – 2 Oct 2026", "Oct 2026" for a whole month) and
`fmtDay`. `ui/src/utils/kinds.js` holds the Trip / Month / Other labels.

### Intake (wave 2)

`ui/src/components/intake/`: `IntakePanel` (drop zone, Choose files, Take photo
on a phone, Phone QR, the file rows, "N of M read", ETA), `useUploader`
(prepares, uploads three at a time, keeps a state per local file: preparing,
uploading, stored, duplicate, unsupported, failed with retry), `useIntake`
(polls `/reports/:id/intake` every 2 s while anything is queued or reading),
`FileRow`, `CoverForm` (Trip / Month / Other, AI markers, saves as you type),
`handoff.js` (files handed from Home or My receipts to the New case page).

## Who builds what

Each agent works in its own git worktree and touches only the files it owns.

| Wave | Agent | Owns |
|---|---|---|
| 1 | Cases (server) | `db/migrate.js` step 8 and `cover_ai`; `schema.sql` `expense_reports`; `store/reports.js`; `routes/reports.js`; `reports/workflow.js`; `reports/cover-suggest.js`; `reports/cover-auto.js`; `receipts/flags.js`; `receipts/edit.js`; `routes/expenses.js`; the `open` → `draft` review of `fx/sweeper.js`, `fx/live.js`, `store/summary.js`, `assistant/*`, `claims/claim-import.js`; the draft sweep |
| 1 | Intake engine (server) | `intake/convert.js`; `receipts/read-queue.js`; `routes/receipts.js`; `receipts/read-receipt.js`; `receipts/receipt-parser.js`; `receipts/recover.js`; `receipts/pairing.js`; `store/expenses.js`; `schema.sql` new tables and expense/receipt columns; their `_ensureColumn` lines; `index.js`; `llm/gemini-client.js` test models; `claims/claim-archive.js` extensions |
| 1 | UI foundations | `ui/src/components/ui/*`, `ui/src/utils/*`, `ui/src/styles/*`, small fixes in `ExpenseReview.jsx`, `Header.jsx`, `Login.jsx`, `Settings.jsx`, `BottomNav.jsx` |
| — | Integration (lead) | `GET /reports/:id/intake`, rate-limit skip, `setOnDone` → `cover-auto`, merge, full test run |
| 2 | New case | `pages/NewCase.jsx`, `components/intake/*`, `receipt-upload.js`, `App.jsx`, `PhonePairingModal.jsx` |
| 2 | Review | `pages/CaseReview.jsx`, `components/receipt/*` (pieces lifted out of `ExpenseReview.jsx`), `ExpenseReview.jsx`, `CaseCheck.jsx` |
| 3 | Cases list and case page | `pages/Reports.jsx`, `pages/ReportDetail.jsx` |
| 3 | Home, receipts, phone, nav | `pages/Home.jsx`, `pages/MyExpenses.jsx`, `pages/Capture.jsx`, `ReceiptUpload.jsx`, `Sidebar.jsx`, `BottomNav.jsx`, `Settings.jsx` user rows |
| — | Finish (lead) | README, docs, lint, tests, build, commits, push |

Every agent: `npm test`, `npm run lint`, and for UI work `npm run build:ui`
before handing back; write tests for every new route and module; keep the
existing comment style (say why, not what).

## Phase 6 (2026-10-22): email, per diem, mileage, policy, live progress, Xero

Approved with "proceed" on 2026-10-22; every default below was taken. Same
working rules as the waves above.

### Decisions (defaults)

1. **Email in, two ways.** (a) An `.eml` or Outlook `.msg` file dropped on the
   New case page or a case: its receipt attachments become receipts; when it
   has none, the message itself is kept as a PDF receipt and read like a typed
   PDF (an e-receipt from Grab or an airline). (b) A personal forwarding
   address `receipts+<token>@<INBOUND_EMAIL_DOMAIN>`: the mail provider posts
   the raw message to `POST /api/inbound/email`. Off until the box sets
   `INBOUND_EMAIL_DOMAIN` and `INBOUND_EMAIL_SECRET`; the provider is the
   company's choice (the runbook shows Cloudflare Email Routing with a small
   Email Worker, and Mailgun routes). Only mail **from the person's own
   address** is taken. A subject naming one of their open cases
   (`EXP-2026-0002`) files the receipts there; otherwise they land outside any
   case, on Home under "Not in a case" — no case is ever made by itself.
2. **Per diem** from rates an admin keeps per country (amount a day, in any
   currency, from a date). "Add per diem" on a Trip makes one receipt-less
   expense: days × the destination's rate, first and last day at the
   company's travel-day percentage (default 100%), category Meals, checked.
   Adding it again replaces it. A Meals receipt on a per-diem day gets a
   yellow flag.
3. **Mileage**: an admin sets a rate per km in the base currency. "Add
   mileage" on a case: date, from, to, km, one way or return, purpose → a
   receipt-less expense in Fuel/Mileage, checked.
4. **Policy** an admin sets: a limit per receipt for each category (base
   currency), a maximum age in days, and weekend receipts flagged or not.
   All are yellow "have a look" flags: nobody approves anything in Solv.
5. **Live progress** over server-sent events for the intake, with polling
   kept as the fallback.
6. **Xero**: a case that would need more than Xero's 10 attachments per bill
   sends the case PDF (cover plus every receipt) instead, split into as few
   files as fit the per-file cap.
7. `npm audit fix` for the production dependency follow-redirects.

### Data

- `users.inbound_token TEXT` (unique when set), via `_ensureColumn`.
- `company_policy` (company_id PK, json TEXT, updated_by, updated_at): `{ mileageRatePerKm, travelDayPct, categoryLimits: { "<category>": amount }, maxAgeDays, flagWeekends }`.
- `per_diem_rates` (id, company_id, country, currency, daily_cents, effective_from, created_by, created_at); the rate for a day is the latest `effective_from` on or before it.
- Expenses made here: `source` = `email` (from a mail), `per_diem`, `mileage`; `receipt_id` NULL for the last two. A file from email is a normal receipt with `receipts.source = 'upload'` and `original_name` = the attachment's name (the receipts.source CHECK is not widened).

### Server API

| Call | Contract |
|---|---|
| `POST /api/receipts/email` | `{ data, filename, reportId }` (base64 .eml or .msg, upload body limit). Owner's editable case. → `{ stored: [{ receipt, expense }], skipped: [{ name, why }], subject, from }`. 400 when the file is not a mail. |
| `POST /api/inbound/email` | Raw MIME body (`message/rfc822`, up to 25 MB), header `Authorization: Bearer <INBOUND_EMAIL_SECRET>`. 404 when not configured. Recipient token → person; sender must be that person's email, else 202 and dropped with a log line. → 202 `{ stored, skipped, reportId }`. Not behind the session auth or the per-user limiter; its own limit of 100 mails a day per person. |
| `GET /api/users/me/inbound-address` | `{ address }` or `{ address: null, configured: false }`. |
| `POST /api/users/me/inbound-address` | Makes a new token (the old address stops working) → `{ address }`. |
| `GET /api/company/policy`, `PUT /api/company/policy` | Any signed-in person reads (the UI needs the mileage rate); admin writes. Validated: limits ≥ 0, maxAgeDays 1–3650 or null, travelDayPct 0–100. |
| `GET /api/company/per-diem-rates`, `POST`, `DELETE /:id` | Read: anyone; write: admin. Country ISO-2, currency ISO-3, amount > 0, date. |
| `POST /api/reports/:id/per-diem` | Owner, editable Trip with both dates. Body `{ country? }` (default: the destination's country from the receipts). 400 with a reason when no rate covers it. → the case view. |
| `POST /api/reports/:id/mileage` | Owner, editable case. `{ date, from, to, km, returnTrip, purpose }` → the case view. 400 when the company has no mileage rate. |
| `GET /api/reports/:id/intake/stream` | Same visibility as `/intake`. `text/event-stream`, `X-Accel-Buffering: no`; an `intake` event with the same body as `/intake` at once and whenever the case's files or receipts change (debounced 300 ms), a comment every 25 s, closed after 15 minutes (the client reopens it). Not rate limited. As built: an `end` event `{ reason: 'time' | 'gone' }` before a planned close, so the page tells a 15-minute end (reopen at once) and a case deleted or merged away from a fault (fall back to polling, retry after 30 s, 60 s, doubling to 5 min). |

### Flags added (yellow)

`over-limit` (base amount over the category's limit), `too-old` (older than
maxAgeDays on the day shown), `weekend` (when flagWeekends), `per-diem-meal`
(a Meals receipt on a day the case's per diem covers).

### Who builds what

| Wave | Agent | Owns |
|---|---|---|
| 4a | Email (server) | `intake/email.js`, `routes/inbound.js` (new; the lead mounts it), the `/email` route in `routes/receipts.js`, `users.inbound_token` + helpers in `store/users.js`, the inbound-address routes in `routes/users.js`, RUNBOOK and `.env.example` sections, tests |
| 4a | Allowances and policy (server) | `store/policy.js`, `routes/policy.js` (new; mounted under /api/company by the lead), `reports/allowances.js` + `routes/allowances.js` (new; mounted under /api/reports by the lead), the two tables, `receipts/flags.js`, tests |
| 4a | Live progress and Xero | `utils/events.js` (new), emits in `receipts/read-queue.js`, `routes/intake-stream.js` (new; mounted by the lead), `ui/src/components/intake/useIntake.js` (stream with polling fallback), `xero/bills.js` + `xero/attachments.js`, tests |
| — | Lead | `index.js` mounts, dependency installs, `npm audit fix`, merge, full run |
| 4b | UI | Settings (Policy, Per diem rates, Mileage rate; the forwarding address in My profile), case page "Add per diem" / "Add mileage", .eml/.msg in the drop zone, receipt-less rows in the case table and the review page |
| — | Lead | QA pass in a browser, docs, deploy |
