# Solv Expenses

Expense claims for a company that pays its staff back in SGD for receipts in any currency. Staff add receipts (drag-drop, phone camera by QR code, or a ZIP with the claim-form spreadsheet); the reader extracts merchant, date, invoice number, currency, total, tax and category lines, including from scanned multi-page hotel folios; every foreign line is converted at a live exchange rate that is frozen on the line and can be edited with a reason; reviewed expenses are filed into an expense report with a cover; the claimant submits, the manager approves, the claimant marks it claimed once it has gone through, and finance posts it to Xero as a draft bill with the receipts attached; the report exports as PDF, XLSX or CSV with the rate footnote and the receipts appended.

Built on the same stack as `xero-invoice-app-master`, with its proven modules ported (reader, duplicate detection, job queue, phone capture, batch import, Xero connection) and five things added: scanned-PDF rendering, multi-page single-document reads, the exchange-rate service, expense reports with approval, and the exports.

## Run it

```bash
npm install && npm --prefix ui install
cp main/.env.example main/.env          # set JWT_SECRET and ENCRYPTION_KEY (64 hex chars)
npm run dev                             # server on :4000, UI on :5173
```

Open http://localhost:5173. The first account registered becomes the administrator and creates the company (Solv, SGD, Asia/Singapore). In **Settings** add a Gemini API key for the reader (or put `Gemini_API_KEY` in `main/.env`), add staff with roles and managers, set the report columns, and connect Xero when ready.

Production: `npm run build:ui` then `NODE_ENV=production npm start` (serves the built UI). `npm run preflight` says whether a machine is fit to run it before you find out from a restart loop, and `npm run deploy` ships to your server and refuses to call it deployed until the running process reports the commit you shipped. Set the target once in `main/.deploy.env` (gitignored; template beside it). Everything about the box — nginx, TLS, backups, restore, rollback, crashes, key rotation — is in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Cases

A case is a bundle of receipts that belong together: a trip, a job, a month of fuel. It is the same object as a report, so everything downstream is unchanged, and it prints as one.

There are two ways to start one. Drop a zip of receipts and the import creates a case named after the file, reads every receipt in it and files them all in. Or create one by hand and add receipts to it as they happen, by dropping files on the case, by importing a zip into it, or by scanning its QR code and photographing them on a phone, in which case every photograph taken while that session is open lands in that case.

Unlike the bulk filing route, a receipt uploaded into a case joins it before anyone has checked it, which is the point of working case-first. Submitting still refuses until every receipt in the case has been checked and priced.

Checking happens in one table at `/reports/:id/check`: a row per receipt, the fields editable in place, the receipt beside the row you are on, and one button to check them all. Anything that cannot be checked says why.

## Roles and flow

| Role | Does |
|---|---|
| employee | adds receipts, reviews the reader's fields and lines, files them into reports, submits |
| manager | approves or sends back direct reports' submitted reports |
| finance | everything a manager can, plus manual exchange rates, Xero, exports for anyone |
| admin | finance plus staff and company settings |

`draft → submitted → approved → claimed → posted`; `submitted/approved → rejected → submitted`. An expense inside a submitted report is locked until the report is sent back.

The last step belongs to the claimant, not to finance. Solv records claims; it does not move money, so it cannot know that anybody was paid — what it can know is that the person put an approved claim through, so they are the one who says so. Marking a report claimed marks every receipt in it; a receipt can also be claimed on its own, for a one-off put through outside any report, and claiming one receipt inside a case says nothing about the case.

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

Porcelain: a cool white ground, near-black actions, hairline borders, and no brand colour at all. The primary button is the darkest thing on the page rather than the most colourful, which leaves every colour on screen belonging to a status. Light is the default; the toggle switches to the night version, where the ink and the paper swap, and the choice is remembered. The whole palette is [ui/src/styles/theme.css](ui/src/styles/theme.css), tokens only, and nothing outside that file names a colour, so a repaint means editing one file.

Three rules the palette keeps:

- Colour means state and nothing else. No accent competes with it, because the accent has no colour.
- Each status owns a hue: blue in progress, amber needs you, green settled, teal claimed, rose refused. The same five in both themes, deepened for white and brightened for black.
- Surfaces separate by edge, not by shadow. Shadows are kept for things that genuinely float, such as a modal.

It is also deliberately nothing like the Xero automation, which is dark with an indigo accent. Anyone running both knows which window they are in without reading a word.

Every foreground and background pair in both themes was measured against 4.5:1, and muted helper text against 3:1.

Inter Tight carries the interface and IBM Plex Mono every figure, so amounts line up down a column. Both are self-hosted in `ui/public/fonts` (Latin and Latin Extended) because the server's content security policy allows styles and fonts from itself only, and because no staff browser should have to call Google to render an expense claim. To refresh them, fetch the family from the Google Fonts CSS API with a browser user agent, keep the `latin` and `latin-ext` faces, and rewrite `ui/src/styles/fonts.css` to match.

## Scripts

| Command | What |
|---|---|
| `npm test` | 55 suites, jest + supertest, everything mocked at the network edge |
| `npm run lint` | eslint over server and UI (errors fail the suite too) |
| `node main/scripts/read-sample.js <file>` | read one receipt with the live model and print the fields and lines |
| `node main/scripts/fx-sample.js samples/reads/<folio>.json` | price a saved read with the live providers |
| `node main/scripts/demo-report.js [--xero-dry-run]` | build the real report from the two sample folios into `docs/acceptance/exports/` |
| `node main/scripts/smoke-flow.js` | the whole flow through the HTTP API on a fresh production server |
| `node main/scripts/audit-flow.js` | every route, including who is refused and what a bad input returns (`--no-model` to skip the reader) |
| `npm run preflight` | is this machine fit to run Solv — versions, native modules, secrets, disk, schema, built UI (`--json` for a machine) |
| `npm run deploy` | ship to the server and prove it applied (`-- --check` reports drift and changes nothing) |
| `npm run backup` / `npm run backup:pull` | a verified database backup on the box / the whole backup set copied to your machine |

## Exchange rates, stated

A rate is how much of the base currency one unit of the foreign currency is worth, fetched for the receipt date (company policy; submission-date and monthly-fixed are the alternatives). The European Central Bank's reference rates come first, through Frankfurter, which publishes about thirty currencies with history by date. ExchangeRate-API covers the rest, around 160 in total, but only for today, so a currency the ECB does not publish is priced at the day's rate and the report says so. After both, whatever finance types in.

Thirty-two currencies are offered by name in the claim screen and the rates page, from [main/intake/currencies.js](main/intake/currencies.js). That is a convenience, not a limit: any three-letter code can be typed, and the reader accepts whatever it reads off the receipt.

Below a rate of 0.1 the provider is asked the other way round and the answer inverted. Both providers round to decimal places rather than significant figures, so one Indonesian rupiah comes back as 0.000072 Singapore dollars, which is two figures and puts a ten-million-rupiah hotel bill SGD 2.69 out. Asked as "how many rupiah to the dollar" the same provider gives 13,941.2, and inverting that keeps the precision. Rates are printed to six significant figures and stored with every digit.

Four checks stand between a provider's number and a figure somebody is paid. The two providers are fetched together when both can answer for the day, and a disagreement over 1% is recorded on the rate and shown. A rate more than 10% from the last one known for that pair is refused rather than frozen onto a line: the line says why and finance settles it by entering the rate, which is never blocked. A rate priced after the receipt date, which happens for the currencies with no published history, marks the expense and the report footnote rather than passing quietly. And a sweeper re-prices every quarter of an hour anything left without a rate because a provider was unreachable, skipping locked expenses and anything somebody typed a rate onto.

The rate, its date, its source and the moment it was fetched are stored on every line and printed on the report. Each line is converted and rounded to the cent; the report total is the sum of the lines. A rate finance or the claimant types in is kept with the person and the reason until someone asks for a refresh.

## Not yet

- A live post to the real Xero organisation: the code and a dry run exist; connect the org in Settings and click Post.
- A server: the deploy path, preflight, backups and runbook exist ([docs/RUNBOOK.md](docs/RUNBOOK.md)); no box has been provisioned and nothing is running anywhere yet.
- Email intake of claims, mileage, per-diem, policy limits, multi-level approval.
