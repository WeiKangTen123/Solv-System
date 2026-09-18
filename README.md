# Solv Expenses

Expense claims for a company that pays its staff back in SGD for receipts in any currency. Staff add receipts (drag-drop, phone camera by QR code, or a ZIP with the claim-form spreadsheet); the reader extracts merchant, date, invoice number, currency, total, tax and category lines, including from scanned multi-page hotel folios; every foreign line is converted at a live exchange rate that is frozen on the line and can be edited with a reason; reviewed expenses are filed into an expense report with a cover; the claimant submits, the manager approves, finance marks it paid and posts it to Xero as a draft bill with the receipts attached; the report exports as PDF, XLSX or CSV with the rate footnote and the receipts appended.

Built on the same stack as `xero-invoice-app-master`, with its proven modules ported (reader, duplicate detection, job queue, phone capture, batch import, Xero connection) and five things added: scanned-PDF rendering, multi-page single-document reads, the exchange-rate service, expense reports with approval, and the exports.

## Run it

```bash
npm install && npm --prefix ui install
cp main/.env.example main/.env          # set JWT_SECRET and ENCRYPTION_KEY (64 hex chars)
npm run dev                             # server on :4000, UI on :5173
```

Open http://localhost:5173. The first account registered becomes the administrator and creates the company (Solv, SGD, Asia/Singapore). In **Settings** add a Gemini API key for the reader (or put `Gemini_API_KEY` in `main/.env`), add staff with roles and managers, set the report columns, and connect Xero when ready.

Production: `npm run build:ui` then `NODE_ENV=production npm start` (serves the built UI). pm2 config in `ecosystem.config.js`; the Xero app's runbook (`docs/RUNBOOK.md` there) describes the VM, nginx, backups and deploy script, which apply unchanged.

## Roles and flow

| Role | Does |
|---|---|
| employee | adds receipts, reviews the reader's fields and lines, files them into reports, submits |
| manager | approves or sends back direct reports' submitted reports |
| finance | everything a manager can, plus marks paid, manual exchange rates, Xero, exports for anyone |
| admin | finance plus staff and company settings |

`draft → submitted → approved → paid → posted`; `submitted/approved → rejected → submitted`. An expense inside a submitted report is locked until the report is sent back.

## Where things are

```
main/
  routes/        auth users company receipts expenses claims reports fx xero dashboard
  receipts/      read-receipt.js — how a file is read (photo / text PDF / scanned PDF) and how lines are built
  utils/         receipt-parser (Gemini prompts + normaliser), pdf-render (pages → JPEG in a child process),
                 pdf-pages, receipt-store, thumbnailer, pairing (QR tokens), token-cache, gemini-client, users
  store/         expenses.js (receipts, expenses, lines, cents), reports.js (reports, totals, events)
  fx/            providers (Frankfurter/ECB, open.er-api), rates (cache, manual priority), apply (per-line, policy, overrides)
  reports/       workflow (state machine), expense-doc (pdfmake definition, CSV, workbook model), expense-export, expense-payload
  xero/          connect/oauth/token cache (company-scoped), contacts, category-account, attachments, bills
  claims/        ZIP + claim-form batch import, durable job queue and worker, categories
  scripts/       read-sample.js, fx-sample.js, demo-report.js, smoke-flow.js, jest setup
ui/src/          pages: Login, Home, MyExpenses, ExpenseReview, Reports, ReportDetail, Approvals, Settings, Capture
docs/            plan/ (illustrated plan), superpowers/specs and plans, acceptance/ (real outputs from the sample folios)
```

## Scripts

| Command | What |
|---|---|
| `npm test` | 51 suites, jest + supertest, everything mocked at the network edge |
| `npm run lint` | eslint over server and UI (errors fail the suite too) |
| `node main/scripts/read-sample.js <file>` | read one receipt with the live model and print the fields and lines |
| `node main/scripts/fx-sample.js samples/reads/<folio>.json` | price a saved read with the live providers |
| `node main/scripts/demo-report.js [--xero-dry-run]` | build the real report from the two sample folios into `docs/acceptance/exports/` |
| `node main/scripts/smoke-flow.js` | the whole flow through the HTTP API on a fresh production server |

## Exchange rates, stated

A rate is SGD per one unit of the foreign currency, fetched for the receipt date (company policy; submission-date and monthly-fixed are the alternatives) from the European Central Bank reference rates via Frankfurter, then open.er-api for currencies the ECB does not publish, then whatever finance types in. The rate, its date, its source and the moment it was fetched are stored on every line and printed on the report. Each line is converted and rounded to the cent; the report total is the sum of the lines. A rate finance or the claimant types in is kept with the person and the reason until someone asks for a refresh.

## Not yet

- A live post to the real Xero organisation: the code and a dry run exist; connect the org in Settings and click Post.
- Deployment to a server (pm2, nginx, backups) — follow the Xero app's runbook.
- Email intake of claims, mileage, per-diem, policy limits, multi-level approval.
