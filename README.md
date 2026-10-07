# Solv Expenses

Expense claims for a company that pays its staff back in SGD for receipts in any currency. Staff add receipts (drag-drop, phone camera by QR code, or a ZIP with the claim-form spreadsheet); the reader extracts merchant, date, invoice number, currency, total, tax and category lines, including from scanned multi-page hotel folios; every foreign line is converted at a live exchange rate that is frozen on the line and can be edited with a reason; receipts are bundled into a case with a cover; the claimant marks the case claimed once they have put it through, and can post it to Xero as a draft bill with the receipts attached; the case exports as PDF, XLSX or CSV with the rate footnote and the receipts appended.

Built on the same stack as `xero-invoice-app-master`, with its proven modules ported (reader, duplicate detection, job queue, phone capture, batch import, Xero connection) and five things added: scanned-PDF rendering, multi-page single-document reads, the exchange-rate service, cases with a printed cover, and the exports.

## Run it

```bash
npm install && npm --prefix ui install
cp main/.env.example main/.env          # set JWT_SECRET and ENCRYPTION_KEY (64 hex chars)
npm run dev                             # server on :4000, UI on :5173
```

Open http://localhost:5173. The first account registered becomes the administrator and creates the company (Solv, SGD, Asia/Singapore). In **Settings** add a Gemini API key for the reader (or put `Gemini_API_KEY` in `main/.env`), add staff, set the report columns, and connect Xero when ready (with an advances account if claims carry advances).

Production: `npm run build:ui` then `NODE_ENV=production npm start` (serves the built UI). `npm run preflight` says whether a machine is fit to run it before you find out from a restart loop, and `npm run deploy` ships to your server and refuses to call it deployed until the running process reports the commit you shipped. Set the target once in `main/.deploy.env` (gitignored; template beside it). Everything about the box — nginx, TLS, backups, restore, rollback, crashes, key rotation — is in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Cases

A case is a bundle of receipts that belong together: a trip, a job, a month of fuel. It is the same object as a report, so everything downstream is unchanged, and it prints as one.

Every receipt lives in a case; there is no loose pile. Pick one image or ten on Home and one case is made for them, named by the day. Drop a zip and the import makes a case named after the file, reads every receipt in it and files them all in. Scan the QR code on Home and a case is made for the phone session, so every photograph taken while it is open lands there; a session that produced nothing deletes its case again. Or create a case by hand and add to it as receipts happen — by dropping files on it, importing a zip into it, or scanning its own code.

Unlike the bulk filing route, a receipt uploaded into a case joins it before anyone has checked it, which is the point of working case-first. Claiming still refuses until every receipt in the case has been checked and priced.

Checking happens in one table at `/reports/:id/check`: a row per receipt, the fields editable in place, the receipt beside the row you are on, and one button to check them all. Anything that cannot be checked says why.

## Roles and flow

Two roles, like most systems: people who claim, and the person who runs it.

| Role | Does |
|---|---|
| user | their own receipts and cases, start to finish: adds receipts, checks the reader's fields and lines, keeps them in cases, marks a case claimed, posts it to Xero, exports it. Sees nobody else's claims and no staff list |
| admin | runs the system: adds and removes people, roles, passwords, company settings, LLM keys, exchange rates, the Xero connection, and Users & Monitoring. Sees everyone's claims to monitor them and can correct a receipt's details while checking one, but files, checks, claims, reopens, deletes and posts only their own |

There are no managers and nobody approves anything. Solv records claims; it does not route them.

`open → claimed`, and back again with **Reopen**. A case is open while receipts go in and claimed once its owner has put it through whatever actually reimburses them; claimed closes it to filing, checking, re-reading and deleting. Claiming refuses until every receipt in the case has been checked and priced. Once a case has been posted to Xero it is final and cannot be reopened, so the app and the books never disagree.

The step belongs to the claimant. Solv does not move money, so it cannot know that anybody was paid — what it can know is that the person put the claim through, so they are the one who says so, and nobody can say it for them. A receipt can also be claimed on its own, once it is checked and priced, for a one-off put through outside any case. A receipt in a case is claimed with its case and never on its own as well, and one claimed on its own cannot then go into a case, so nothing is claimed twice.

**Accounts.** Self-registration is off unless an admin switches it on in Company & Policy; otherwise an admin adds people in Users & Monitoring. Removing a person ends their access and every session they have, and keeps their receipts, cases and totals; they can be restored. Passwords are at least 8 characters. A sign-in lasts 24 hours and ends early on sign-out or a password change.

**Correcting a receipt** ([main/receipts/edit.js](main/receipts/edit.js)). Its details are the merchant, date, invoice number, currency, amounts, category, purpose, lines and exchange rate. The owner and any admin of the same company can correct them, while the case is open and after it is claimed, until the case is posted to Xero, where the bill already exists. Every change is logged with who made it, when, the old and new value, and whether it came from the page, the assistant or a re-read; the log shows on the receipt to its owner and to admins. A change after a claim is also written to the case's history. Where a saved field no longer matches what the reader first read off the receipt, the page shows the reader's value beside it.

**A typed exchange rate** must be within 5% of the day's published rate, with a reason; an admin is not held to that.

## The assistant

The **Ask** button on every page opens a chat ([main/assistant/](main/assistant/)) that uses the same Gemini keys as the reader, from Settings → LLM API Setup. Answers stream in as they are written. What the person most likely asks about (the receipt or case on screen, their open items, latest receipts and this month's spending) is looked up before the model is asked, so most questions take one model call. Each key is held to its own per-minute quota whoever is using it, a person waiting for an answer goes ahead of receipts being read and always has a slot kept for them, the fast model is tried on every key before the slow fallback, and a key that ran out is left alone until Google says it may be asked again; receipts read while every key is resting wait for the first one back rather than failing.

- **What it does.** It finds and explains receipts and cases, checks a receipt for problems, looks at the receipt's picture or PDF to compare it with what was saved, summarises spending, and looks up exchange rates. An admin can ask about anyone in the company; a user, about their own.
- **How it changes things.** It never changes anything itself. It proposes a change as a card, and nothing happens until the person presses **Apply**. Applying goes through the same rules as the page and is logged on the receipt as having come through the assistant. A card fails rather than overwrites if the receipt changed after it was proposed, and expires after a day.
- **What it can propose.** Corrections to a receipt's details, lines and exchange rate, on the same terms as the page. For the person's own receipts it can also propose marking one reviewed or filing it in one of their open cases.
- **What it cannot do.** It has no tool for passwords, accounts, roles, keys, settings, the Xero connection, deleting, claiming, reopening or posting. It is told to refuse dishonest edits, such as an amount that no longer matches the receipt, and to treat text on receipts as data rather than instructions.
- **Privacy and limits.** Conversations are private to the person who had them; no route shows one to anybody else, admins included. Each person can ask 60 questions an hour (`ASSISTANT_PER_HOUR`). Users & Monitoring shows how many questions each person asked in the last 30 days, never what they asked.

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
                 users.js (companies, staff, roles, company config),
                 summary.js (the dashboard's figures, aggregated in SQL and scoped by role)
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
ui/src/          pages: Login, Home, MyExpenses, ExpenseReview, Reports, ReportDetail, Settings,
                 Capture, CaseCheck; components/Insights.jsx draws the home dashboard
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
| `npm test` | the whole suite, jest + supertest, everything mocked at the network edge |
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

A rate is how much of the base currency one unit of the foreign currency is worth, fetched for the receipt date in the company's own calendar (company policy; submission-date, which is the day the receipt arrived, and monthly-fixed are the alternatives). The base currency cannot be changed once receipts have been converted to it. The European Central Bank's reference rates come first, through Frankfurter, which publishes about thirty currencies with history by date. ExchangeRate-API covers the rest, around 160 in total, but only for today, so a currency the ECB does not publish is priced at the day's rate and the report says so. After both, whatever an admin types in.

Thirty-two currencies are offered by name in the claim screen and the rates page, from [main/intake/currencies.js](main/intake/currencies.js). That is a convenience, not a limit: any three-letter code can be typed, and the reader accepts whatever it reads off the receipt.

Below a rate of 0.1 the provider is asked the other way round and the answer inverted. Both providers round to decimal places rather than significant figures, so one Indonesian rupiah comes back as 0.000072 Singapore dollars, which is two figures and puts a ten-million-rupiah hotel bill SGD 2.69 out. Asked as "how many rupiah to the dollar" the same provider gives 13,941.2, and inverting that keeps the precision. Rates are printed to six significant figures and stored with every digit.

Four checks stand between a provider's number and a figure somebody is paid. The two providers are fetched together when both can answer for the day, and a disagreement over 1% is recorded on the rate and shown. A rate more than 10% from the last one known for that pair is refused rather than frozen onto a line: the line says why and an admin settles it by entering the rate, which is never blocked. A rate priced after the receipt date, which happens for the currencies with no published history, marks the expense and the report footnote rather than passing quietly. And a sweeper re-prices every quarter of an hour anything left without a rate because a provider was unreachable, skipping locked expenses and anything somebody typed a rate onto.

The rate, its date, its source and the moment it was fetched are stored on every line and printed on the report. Each line is converted and rounded to the cent; the report total is the sum of the lines. A rate an admin or the claimant types in is kept with the person and the reason until someone asks for a refresh.

**The live board and the daily log** ([main/fx/live.js](main/fx/live.js), Settings → Exchange Rates). Every currency a receipt has used, plus any an admin adds, is refreshed every hour (`FX_LIVE_MINUTES`), one request per source whatever the number of currencies. At 23:55 company time the day's last figure is written as that day's close, and the close is the price of the day: it outranks any lookup made for that date, and only a rate an admin typed beats it. A receipt dated today takes the live figure and moves to the close that night unless its case has been claimed. A day the server was down for is closed late from the providers' history. The free feeds publish once a day, so without a key the board moves when they publish; an Open Exchange Rates App ID, entered on the same page and checked before it is kept, makes it hourly on their free plan and faster on paid ones, with the ECB kept as its cross-check.

## Not yet

- A live post to the real Xero organisation: the code and a dry run exist; connect the org in Settings and click Post.
- Email intake of claims, mileage, per-diem, policy limits, multi-level approval.
