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
  index.js       mounts every /api route, serves ui/dist in production
  routes/        auth users company receipts expenses claims reports fx xero dashboard
  receipts/      read-receipt (photo / text PDF / scanned PDF, and how lines are built),
                 receipt-parser (prompts + normaliser), receipt-store (files on disk),
                 thumbnailer, pairing (phone-capture QR tokens)
  intake/        what every document becomes on the way in: document.js (one shape),
                 dedup.js (hash, number, near-match), categories.js (the category list)
  llm/           gemini-client (company keys, rate limit), llm-json (parsing what a model returns)
  pdf/           render.js + render-worker.mjs (pages → JPEG in a child process), pages.js (one document or many)
  store/         expenses.js (receipts, expenses, lines, cents), reports.js (reports, totals, events),
                 users.js (companies, staff, roles, company config)
  fx/            providers (Frankfurter/ECB, open.er-api), rates (cache, manual priority),
                 apply (per-line, policy, overrides)
  reports/       workflow (state machine), expense-payload, expense-doc (pdfmake definition, CSV,
                 workbook model), expense-export (PDF/XLSX/CSV bytes)
  xero/          connect + oauth + oauth-state + token-cache (company-scoped), reconnect, contacts,
                 category-account, attachments, bills
  claims/        ZIP and claim-form batch import, durable job queue and worker, category suggestions
  db/            schema.sql, migrations, backups     middleware/  auth, roles, rate limit
  utils/         the generic helpers only: base64, crypto, ids, logger, paths
  scripts/       read-sample.js, fx-sample.js, demo-report.js, smoke-flow.js, jest setup
ui/src/          pages: Login, Home, MyExpenses, ExpenseReview, Reports, ReportDetail, Approvals,
                 Settings, Capture
docs/            specs/, plans/, acceptance/ (+ exports/), reference/ — see docs/README.md
samples/         receipts/ (the two Marriott folios), reads/ (the reader's saved output for each)
```

## Look and feel

Midnight indigo: a deep indigo ground with warm sand text, coral for actions, and a separate hue for every status. Dark is the default; the toggle in the header switches to the sand-and-ink light theme and the choice is remembered. The whole palette is [ui/src/styles/theme.css](ui/src/styles/theme.css), around fifty lines of tokens, and nothing outside that file names a colour, so a repaint means editing one file.

Three rules the palette keeps: the accent means "you can do this" and is never also the success colour; each status owns a hue (blue in progress, amber needs you, green settled, violet paid, rose refused); and the destructive button is tinted rather than filled, so Reject never outweighs Submit.

Manrope carries the interface and IBM Plex Mono every figure, so amounts line up down a column. Both are self-hosted in `ui/public/fonts` (Latin and Latin Extended, 94 kB in total) because the server's content security policy allows styles and fonts from itself only, and because no staff browser should have to call Google to render an expense claim. To refresh them, fetch the family from the Google Fonts CSS API, keep the `latin` and `latin-ext` faces, and regenerate `ui/src/styles/fonts.css` to match.

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
