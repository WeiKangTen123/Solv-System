# Solv Expense Claims — Design

**Date:** 2026-09-17 (approved 2026-09-18)
**Status:** Approved for planning
**Companion:** `docs/plans/2026-09-17-solv-expense-claims-overview.html` (the illustrated plan this spec condenses)

## Goal

A standalone web app where staff submit expense receipts in any currency, an AI
reader extracts the fields, every foreign amount is converted to SGD with a
live exchange rate that is frozen on the line and can be edited, expenses are
grouped into an Expense Report with a cover, a manager approves, finance
exports the report as PDF/XLSX/CSV in the company's template structure, and
approved reports are posted to Xero as ACCPAY bills with the receipts attached.

## Decisions (resolved 2026-09-18)

| # | Decision | Answer |
|---|---|---|
| 1 | Standalone app or extend the Xero app | **Standalone**, at the workspace root `Solv System/`, same stack as `xero-invoice-app-master`, modules ported file by file with their tests |
| 2 | Company and base currency | **Solv, SGD, Asia/Singapore** |
| 3 | Exchange-rate policy | **Rate on the receipt date**, fetched live, frozen on the line; **editable by the claimant and by finance** with a reason, audited and flagged to the approver |
| 4 | Report columns | **Configurable per company**; default: Air & Transport, Lodging, Meals, Entertainment, Phone, Fuel/Mileage, Other |
| 5 | Receipt to report lines | **Many lines per receipt**, split by category, reconciled to the receipt total |
| 6 | Approval chain | **One manager**, then finance marks paid |
| 7 | Xero posting | **In scope.** One ACCPAY bill per approved report, `CurrencyRate` set to the frozen rate, receipts attached (≤3 MB copies). Same endpoint and approach as `xero-invoice-app-master/main/xero/` |
| 8 | Reader | **Gemini**, through the ported client; the reader is one function so the model can change in one file |

## Non-goals (this version)

- Email intake of claims (the IMAP watcher is not ported).
- Mileage, per-diem, policy limits, multi-level approval, multi-company UI.
- A native phone app; the QR capture page is the phone path.

## Constraints

| Constraint | Consequence |
|---|---|
| Both sample folios are scanned PDFs (zero text layer) | A page renderer is mandatory before the vision reader |
| A hotel folio is one document over 2–4 pages | Multi-page single-document read; never split a folio by page |
| Xero attachments ≤3 MB, JPG/PNG/PDF only | Originals stored full size; a ≤3 MB copy is made only for Xero |
| Xero ExpenseClaims endpoints are disabled | A claim is an ACCPAY bill with attachments, as in the Xero app |
| Gemini free tier 15 RPM per key | Ported per-user limiter and key rotation; batch reads of 5 |
| Nothing reaches Xero without a person clicking Post | Post is a finance action on an approved report |

## Architecture

```
Desktop upload ─┐
Phone (QR)     ─┼─▶ Intake API ─▶ Store (disk + SQLite) ─▶ Job runner ─▶ Read ─▶ FX ─▶ Review ─▶ Submit ─▶ Approve ─▶ Export ─▶ Post to Xero
ZIP + XLSX     ─┘                                                          │        │
                                                                photo→vision    fx_rates cache
                                                                text PDF→text   Frankfurter (ECB) → open.er-api → manual
                                                                scan→render→vision
```

Single VM, pm2, nginx, SQLite (WAL), daily verified backup, deploy waits for CI.

### Units

| Unit | Path | Origin | Responsibility |
|---|---|---|---|
| Gemini client | `main/utils/gemini-client.js` | port | Key/model rotation, 15 RPM limiter |
| Receipt reader | `main/utils/receipt-parser.js` | port + extend | Vision/text prompts, normalise, batch; **new:** multi-page single document (`parseReceiptPages`), per-line `category`, `tax` breakdown, `onBehalfOf` detection |
| Page renderer | `main/utils/pdf-render.js` | new | Scanned PDF → JPEG per page via `pdfjs-dist` + `@napi-rs/canvas`, downscaled with sharp |
| PDF pages | `main/utils/pdf-pages.js` | port | Per-page text, hasText |
| Intake | `main/intake/document.js`, `dedup.js` | port | Normalisers, SHA-256 + field dedup |
| Categories | `main/claims/categories.js` | port + extend | Per-company list = report columns; account hints |
| Job runner | `main/jobs/` (+ `claims/claim-queue.js`, `claim-worker.js`) | port | Durable disk queue, 3 retries, boot recovery |
| Batch import | `main/claims/claim-archive.js`, `claim-form.js`, `claim-matcher.js`, `claim-import.js` | port + extend | ZIP + XLSX → expenses in a draft report |
| Stores | `main/utils/receipt-store.js`, `thumbnailer.js`, `pairing.js` | port | Files, thumbnails, QR tokens |
| Expense store | `main/store/expenses.js` | new | receipts, expenses, expense_lines CRUD (cents) |
| Report store | `main/store/reports.js` | new | expense_reports, events, numbering, status machine |
| FX service | `main/fx/providers.js`, `rates.js`, `convert.js` | new | Provider chain, cache, policy, arithmetic |
| Report export | `main/reports/expense-doc.js`, `expense-render.js`, `expense-xlsx.js` | new (pattern ported) | pdfmake docDefinition as data; XLSX; CSV; receipts appendix |
| Xero | `main/xero/oauth.js`, `token-cache.js`, `contacts.js`, `invoices.js`, `xero-utils.js`, `connect.js` | port | Bill with attachments; `CurrencyRate` |
| Routes | `main/routes/{auth,company,users,receipts,expenses,reports,fx,claims,approvals,xero-oauth,admin,dashboard}.js` | port/new | One router per area |
| UI | `ui/src/` | port + new | Home, My expenses, Expense review, Reports, Report detail, Approvals, Finance, Settings, Capture |

## Data model (SQLite, cents as integers, UTC timestamps)

- `companies(id, name, base_currency, fx_policy, timezone, report_columns JSON, logo, next_report_no)`
- `users(id, company_id, email, password, name, employee_id, department, role employee|manager|finance|admin, manager_id, created_at, last_seen_at)`
- `receipts(id, company_id, user_id, file, mime, size_bytes, sha256, pages, source upload|phone|import, group_id, received_at, parsed_at, parse_json, confidence)`
- `expenses(id, receipt_id, user_id, report_id NULL, merchant, receipt_date, receipt_time, invoice_no, currency, total_cents, tax_cents, subtotal_cents, purpose, status reading|review-needed|reviewed|duplicate|rejected, duplicate_of, error_msg, ai_read_at, box, page, created_at, updated_at)`
- `expense_lines(id, expense_id, sort_order, category, description, amount_cents, currency, fx_rate, fx_rate_date, fx_source, fx_fetched_at, fx_policy, fx_override_by, fx_override_reason, base_cents, on_behalf_of, account_code)`
- `expense_reports(id, company_id, user_id, number, kind trip|period, title, purpose, period_from, period_to, destination, nights, status draft|submitted|approved|rejected|paid|posted, submitted_at, approved_by, approved_at, rejected_reason, advances_cents, paid_at, xero_invoice_id, xero_error, notes, created_at, updated_at)`
- `fx_rates(base, quote, rate_date, rate, source, fetched_at, PRIMARY KEY(base, quote, rate_date, source))`
- `report_events(id, report_id, actor_id, action, note, at)`
- `user_gemini_keys`, `company_credentials(xero_* encrypted)` as in the Xero app.

Rules: an expense's lines must sum to its `total_cents`; `base_cents = round(amount_cents × fx_rate)` per line; a report's total is the sum of its lines' `base_cents`; a line in a non-base currency with no `fx_rate` blocks submit/export ("rate pending").

## FX

- Direction: rate = SGD per 1 unit of the foreign currency.
- Providers in order: Frankfurter v1 (`https://api.frankfurter.dev/v1/{date}?base=X&symbols=SGD`, ECB reference rates, historical, weekend → last business day, date echoed in the reply) → open.er-api.com (`/v6/latest/{X}`, latest only, 160+ currencies) → manual.
- Cache: `fx_rates`; historical rows permanent; `latest` refreshed hourly; provider timeout 5 s; fetch inside the job runner.
- Edit: claimant or finance may change a line's rate with a reason; stored as source `manual`, `fx_override_by`, and a `fx_overridden` event; the approver sees a flag.
- Disclosure printed on every export: per line `INR 43,131.36 × 0.01341 = SGD 578.39`; footnote per (currency, rate date): source, rate date, fetched time, policy, rounding rule; manual edits listed with who and why.
- Xero: `CurrencyRate` on the bill equals the frozen rate (one rate per bill; a report mixing rate dates posts one bill per rate date).

## Pipeline

1. Arrive (upload / phone / import). 2. Store first: hash, write file, create receipt + expense rows (`reading`); exact hash → `duplicate`. 3. Read: image → vision; text PDF → text reader with same-invoice-number pages merged; scan → render pages → vision, all pages in one call as one document; multi-receipt photo → split guard. 4. Normalise + per-line categories. 5. Field-level duplicate suspicion → warning only. 6. FX per line (policy date) → frozen; failure → rate pending. 7. Lines grouped by category; claimant can edit; must reconcile. 8. File into the open report covering the date, else unfiled. 9. Review: purpose typed by the claimant; on-behalf marks; `reviewed`. 10. Submit locks; manager approves/rejects with reason; finance exports, marks paid, posts to Xero.

Failure rules: file before parse; parse failure = saved expense with blank fields; model outage = manual entry; jobs survive restarts, 3 attempts then visible failure.

## Report export

pdfmake docDefinition built as plain data (tested without rendering) from the same payload the screen shows; XLSX via exceljs (sheets: Cover, Lines, Rates, Receipts; SUM formulas); CSV. Landscape A4. Cover block (employee, ID, department, manager, purpose, trip or period, destination, nights, status, total, advances); lines table (#, date, description, ccy, amount, rate, category columns in SGD, total SGD); category totals; exchange-rate footnote; on-behalf and foreign-tax notes; claimant/approver/office-use block; appendix of receipt pages numbered R1..Rn.

## Screens

Home (cover: Add expense / Use my phone / Import a claim; Unfiled; Open reports; Approvals for managers) · My expenses · Expense review (image | fields | rate panel | line split | report picker) · Reports · Report detail (cover, lines, totals, rates used, history; Submit / Approve / Reject / Mark paid / Post to Xero by role) · Approvals · Finance (awaiting payment, rates table, Xero status) · Settings (company, users/roles, reader keys, Xero) · Capture (ported phone page).

## API

Auth (ported) · `GET|PATCH /api/company` · `GET|POST /api/users`, `PATCH|DELETE /api/users/:id` · Receipts (ported: upload, pair, capture, image, token, reread, group, merge) · `GET /api/expenses`, `GET|PATCH|DELETE /api/expenses/:id`, `PUT /api/expenses/:id/lines`, `PATCH /api/expenses/:id/status`, `PATCH /api/expenses/:id/fx` · `GET|POST /api/reports`, `GET|PATCH /api/reports/:id`, `POST /api/reports/:id/expenses`, `DELETE /api/reports/:id/expenses/:expenseId`, `POST /api/reports/:id/submit|approve|reject|paid|post`, `GET /api/reports/:id/export-url`, `GET /api/reports/:id/export` · `GET /api/fx/rate`, `GET|POST /api/fx/rates`, `POST /api/fx/refresh` · Batch import (ported `/api/claims/*`) · `GET /api/approvals` · `GET /api/reports/:id/events` · Xero OAuth (ported) · `GET /api/admin/audit|logs` · health.

## Security, ops, tests

Ported: JWT with role read per request, bcrypt, AES-256-GCM secrets, helmet, per-user rate limits, signed image/export tokens, single-use QR tokens (upload only), path sanitisation. Added: role guards (employee own; manager direct reports; finance company), audit events, report locking after submit. Ops ported: pm2, nginx, backup, deploy, runbook. Tests: jest + supertest co-located; ported tests must pass in the new repo before Solv code; new tests for renderer, multi-page read (mocked model), FX (cache, fallback order, weekend, override, pending), line reconciliation, report docDefinition, approval state machine, role guards, Xero payload (CurrencyRate, attachments, never sent without Post).

## Phases

0 Scaffold and port foundation · 1 Intake and reading (acceptance: both Marriott folios read as one expense each, lines Lodging/Meals reconcile, transferred room flagged) · 2 FX · 3 Reports and export · 4 Roles and approval · 5 Post to Xero.
