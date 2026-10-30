# Solv Expenses

Expense claims for a company that pays its staff back in SGD for receipts in any currency. Staff add receipts (drag-drop, phone camera by QR code, or a ZIP with the claim-form spreadsheet); the reader extracts merchant, date, invoice number, currency, total, tax and category lines, including from scanned multi-page hotel folios; every foreign line is converted at a live exchange rate that is frozen on the line and can be edited with a reason; receipts are bundled into a case with a cover; the claimant marks the case claimed once they have put it through, and can post it to Xero as a draft bill with the receipts attached (past Xero's ten attachments a bill, as the case PDF split between receipts); the case exports as PDF, XLSX or CSV with the rate footnote and the receipts appended.

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

**New case, receipts first** (`/reports/new`). The page is a drop zone beside the case's details. Drop, pick or photograph any number of receipts — JPG, PNG, PDF, iPhone HEIC/HEIF, WebP, TIFF (a multi-page TIFF becomes a PDF), GIF and AVIF, up to 15 MB each; a ZIP of receipts is unpacked into the case, and a ZIP or spreadsheet with a claim form goes through the claim import. The first file saves the case as a **draft** with no number yet. Each file gets its own row — uploading, waiting, reading, read with what it found, needs a look, failed with a reason and a way to try again — with "N of M read" and about how long is left; the person can leave the page and reading goes on. As reads land, the AI fills the details: Trip, Month or Other, a title such as "India trip, Sep 2026", the dates from the earliest and latest receipt, and the destination from where the receipts were issued. It never suggests a purpose. Any field the person types is theirs from then on and the AI leaves it alone. When a draft's receipts all fall inside an open case's dates, the page offers to move them there instead. **Create case** gives it its number and opens the review; **Discard** removes the draft and its receipts. Drafts nobody put a receipt in are removed after a day.

Home and My receipts send dropped files to the same page, so no case is ever made without the person choosing it. A case takes more receipts the same way on its own page — dropped on it, a ZIP, or its own phone code (a phone link lasts 30 minutes from its last photo and takes 50) — and receipts move between a person's open cases, or two cases merge, from the case page.

**Reading** ([main/receipts/read-queue.js](main/receipts/read-queue.js)). Every file is read through a queue kept in the database, so a restart loses nothing: one call per receipt, four at a time across the company and two per person, the person with the fewest running going next. When every AI key is busy the read waits and tries again after 1, 5, 15 and 60 minutes before it gives up and says so; the person can try again at once or type the fields instead. Files the reader cannot take as they are (HEIC, WebP, TIFF, GIF, AVIF) are converted to JPEG on the server first ([main/intake/convert.js](main/intake/convert.js)), and the receipt keeps a note of what it was. The New case page and the case page hear about each file over a stream the server pushes as reads land (`/api/reports/:id/intake/stream`), and poll instead when the stream cannot be held open.

**A receipt kept as printed** ([main/receipts/printed.js](main/receipts/printed.js)). The record of a receipt is what is printed on it, and Solv never recalculates a printed figure. The reader keeps every row in printed order — each item with its quantity and unit price, each service charge, tip, surcharge and levy, each discount, each tax with its own name and rate (SST 6%, Service Tax 8%, CGST and SGST 9%, GST 9% inside the prices, MwSt, PB1, 消費税), and the rounding — together with the subtotal exactly as printed and the total paid. A row printed under another (a folio's CGST under its room, a discount under its item) says which. The claim lines are made from those rows every time they change, one per category and person as before, and each line carries the taxes inside it with the amount each was charged on, so the PDF and the Xero bill name the tax the receipt names: a Kuala Lumpur hotel's 8% on the room and 6% on dinner stay 24.64 and 5.61, where they used to be summed and split again by amount. The receipt's tax is the sum of its tax rows, or the total of its own tax summary when it prints one. What the reader has always guarded stays guarded: a payment, a restated total or a repeated tax summary is not a row; a tip written under "Total" is part of the amount charged; a folio's transferred charges keep their person, and so do the taxes under them; a service charge or a city, tourism or hotel levy is never tax; a tax larger than its rate could make is not believed; a refund is no amount. One thing is worked out, and marked so: a Singapore receipt that says only "Price payable includes GST" gets its GST as 9/109 of the total. The person types over a row's name, rate or amount, adds and removes rows (`PUT /api/expenses/:id/printed`), and the change log says it in words ("SST 6% 1.58 → 1.60", "Added Teh tarik 5.60"). Rows that do not come to the total within the currency's step (5 sen, a rupee, 100 rupiah, 2 cents elsewhere) are said quietly on the page and nowhere else. Receipts read before this keep their lines as they were, with "Read again to see the receipt as printed".

**Receipts by email** ([main/intake/email.js](main/intake/email.js)). An `.eml` or Outlook `.msg` file dropped like any other becomes its receipts: PDF and image attachments are kept, logos and tracking pixels are not, and a mail with no receipt attached (an e-receipt from a ride app or an airline) is kept as a PDF of the message and read like a typed PDF. Each person also has a forwarding address, `receipts+<token>@<domain>`, shown in My profile, once the box is set up to take mail (`INBOUND_EMAIL_DOMAIN`, `INBOUND_EMAIL_SECRET`; the provider posts each message to `/api/inbound/email` — [docs/RUNBOOK.md](docs/RUNBOOK.md) shows Cloudflare Email Routing). Only mail from the person's own address is taken; a case number in the subject (`EXP-2026-0002`) files the receipts in that open case, and anything else lands under "Not in a case" on Home.

**Per diem and mileage** ([main/reports/allowances.js](main/reports/allowances.js)). An admin keeps a daily per-diem rate for each country and a mileage rate per km in Company settings. On a Trip with both dates, "Add per diem" adds one expense for the days of the trip at the destination's rate, with the first and last day at the company's travel-day percentage; adding it again replaces it. "Add mileage" takes the date, from, to, km and one way or return. Neither has a receipt file; both are checked when they are made, export like any receipt, and post to Xero as lines with nothing to attach.

**Policy** (Company settings): a limit per receipt for any category, a maximum receipt age, and whether weekend receipts are flagged. They raise "have a look" flags, as does a meal receipt on a day the case's per diem already covers. Nobody approves anything, so a policy flag is information for the claimant and for an admin looking over a case, not a stop.

Unlike the bulk filing route, a receipt uploaded into a case joins it before anyone has checked it, which is the point of working case-first. Claiming still refuses until every receipt in the case has been checked and priced.

**Checking** happens on one page, `/reports/:id/review`: the receipts still to check on the left, the receipt itself in the middle, its fields on the right with what the AI first read beside any field changed since. Each receipt carries flags ([main/receipts/flags.js](main/receipts/flags.js)), worked out when it is shown and never stored: **must fix** (no amount, merchant or date; lines that do not add up; no exchange rate) and **have a look** (a date outside the case's dates, a possible duplicate, a currency the reader assumed, an amount changed from what was read, a date in the future; and, from what the reader saw when it read the receipt, kept as `aiRead.checks`: lines that carry another person's charges, the same charge twice, rows the reader had to adjust to meet the total, and a US-style date that could be read the other way). No flag second-guesses a printed tax or subtotal: they are the receipt's record. A refund is read as no amount, with a note saying refunds are not claimed here. J and K move, Enter checks, "Check all with nothing to fix" checks every receipt with no must-fix flag (have-a-look flags stay on it, and on the case table, for anyone looking over the case later), and the last one leads to claiming the case.

**A case's Details** keep up with its receipts. On a draft the AI fills every field the person has not set; on an open case it keeps only the dates (widening at most three days, a Month never), the destination and the nights. "✦ Fill from receipts" on the Details tab shows what the receipts say for each field beside what the case holds, with where it came from ("from 4 receipts in Mumbai and Pune, 31 Aug – 4 Sep 2026"); the person ticks what to take, and can hand a field they set back to the AI. The purpose is never written for them: "✦ Suggest" offers a plain draft of what the receipts show ("Hotel stays and local transport in Mumbai and Pune, 1–4 Sep 2026") and up to three of their own past purposes, and nothing is saved until they pick one and say why in their own words. The assistant can propose detail changes as a card to Apply, on the same rules ([main/reports/cover-help.js](main/reports/cover-help.js), [main/reports/cover-patch.js](main/reports/cover-patch.js)).

**Activity** is one timeline per case, by day, filtered by people, the AI and the system ([main/reports/activity.js](main/reports/activity.js)): the case's own events (created, details edited — one entry per person per quarter hour —, receipts checked, taken out or deleted, per diem and mileage, claimed, reopened, posted or refused by Xero), every change to a receipt in it with the old and new value and who made it (an admin marked as such), and the AI's changes to the details, said as the AI's.

## Roles and flow

Two roles, like most systems: people who claim, and the person who runs it.

| Role | Does |
|---|---|
| user | their own receipts and cases, start to finish: adds receipts, checks the reader's fields and lines, keeps them in cases, marks a case claimed, posts it to Xero, exports it. Sees nobody else's claims and no staff list |
| admin | runs the system: adds and removes people, roles, passwords, company settings, LLM keys, exchange rates, the Xero connection, and Users & Monitoring. Sees everyone's claims to monitor them and can correct a receipt's details while checking one, but files, checks, claims, reopens, deletes and posts only their own |

There are no managers and nobody approves anything. Solv records claims; it does not route them.

`draft → open → claimed`, and back from claimed to open with **Reopen**. A draft is a case still being put together on the New case page; it has no number and cannot be claimed, exported or posted. A case is open while receipts go in and claimed once its owner has put it through whatever actually reimburses them; claimed closes it to filing, checking, re-reading and deleting. Claiming refuses until every receipt in the case has been checked and priced. Once a case has been posted to Xero it is final and cannot be reopened, so the app and the books never disagree.

The step belongs to the claimant. Solv does not move money, so it cannot know that anybody was paid — what it can know is that the person put the claim through, so they are the one who says so, and nobody can say it for them. A receipt can also be claimed on its own, once it is checked and priced, for a one-off put through outside any case. A receipt in a case is claimed with its case and never on its own as well, and one claimed on its own cannot then go into a case, so nothing is claimed twice.

**Accounts.** Anyone can create an account on the sign-up page (`/signup`) and is signed in at once, like any login system. The very first account becomes the administrator and creates the company; everyone after joins it as a user, and an admin can change roles, or add people with a starting password, in Users & Monitoring. Removing a person ends their access and every session they have, and keeps their receipts, cases and totals; they can be restored. Passwords are at least 8 characters. A sign-in lasts 24 hours and ends early on sign-out or a password change.

**Correcting a receipt** ([main/receipts/edit.js](main/receipts/edit.js)). Its details are the merchant, date, invoice number, currency, amounts, category, purpose, lines and exchange rate; on a receipt kept as printed, its rows in place of the lines, the tax and the categories, which come from them. The owner and any admin of the same company can correct them, while the case is open and after it is claimed, until the case is posted to Xero, where the bill already exists. Every change is logged with who made it, when, the old and new value, and whether it came from the page, the assistant or a re-read; the log shows on the receipt to its owner and to admins. A change after a claim is also written to the case's history. Where a saved field no longer matches what the reader first read off the receipt, the page shows the reader's value beside it.

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
                 read-queue (the durable, fair read queue and its retries),
                 receipt-parser (prompts + normaliser), receipt-store (files on disk),
                 flags (must fix / have a look), thumbnailer, pairing (phone-capture links)
  intake/        what every document becomes on the way in: convert.js (HEIC, WebP, TIFF,
                 GIF, AVIF to JPEG or PDF), document.js (one shape), dedup.js (hash, number,
                 near-match), categories.js (the category list)
  llm/           gemini-client (company keys, rate limit), llm-json (parsing what a model returns)
  pdf/           render.js + render-worker.mjs (pages → JPEG in a child process), pages.js (one document or many)
  store/         expenses.js (receipts, expenses, lines, cents), reports.js (reports, totals, events),
                 users.js (companies, staff, roles, company config),
                 summary.js (the dashboard's figures, aggregated in SQL and scoped by role)
  fx/            providers (Frankfurter/ECB, open.er-api), rates (cache, manual priority),
                 apply (per-line, policy, overrides)
  reports/       workflow (state machine), cover-suggest + cover-auto (the AI's case details),
                 intake-view (what the New case page polls), draft-sweep, expense-payload,
                 expense-doc (the model, CSV, workbook), expense-pdf (the case PDF: cover, summary,
                 lines, allowances, items to note, activity, receipts), pdf-text (embedded Noto
                 fonts, assets/fonts), declaration (the claimant's words), expense-export (bytes)
  xero/          connect + oauth + oauth-state + token-cache (company-scoped), reconnect, contacts,
                 category-account, attachments, bills
  claims/        ZIP and claim-form batch import, durable job queue and worker, category suggestions
  db/            schema.sql, migrations, backups     middleware/  auth, roles, rate limit
  utils/         the generic helpers only: base64, crypto, ids, logger, paths
  scripts/       read-sample.js, fx-sample.js, demo-report.js, smoke-flow.js, jest setup
ui/src/          pages: Login, Signup, Home, MyExpenses, ExpenseReview, Reports, NewCase, ReportDetail,
                 CaseReview, Settings, Capture; components/intake (the drop panel and its rows),
                 components/receipt (viewer, fields, lines, rate), components/ui (shared pieces),
                 components/Insights.jsx draws the home dashboard
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
| `npm run eval:reader -- --out <dir>` | score the reader against 16 drawn receipts and the two sample folios with the live model, field by field and row by row (each tax's name, rate and amount, the charges, the rounding, the items, the subtotal as printed), about 18 calls; never run by the test suite ([main/scripts/eval/](main/scripts/eval/index.js)) |
| `node main/scripts/fx-sample.js samples/reads/<folio>.json` | price a saved read with the live providers |
| `node main/scripts/demo-report.js [--xero-dry-run]` | build the real report from the two sample folios into `docs/acceptance/exports/` |
| `node main/scripts/smoke-flow.js` | the whole flow through the HTTP API on a fresh production server |
| `node main/scripts/audit-flow.js` | every route, including who is refused and what a bad input returns (`--no-model` to skip the reader) |
| `npm run preflight` | is this machine fit to run Solv — versions, native modules, secrets, disk, schema, built UI (`--json` for a machine) |
| `npm run deploy` | ship to the server and prove it applied (`-- --check` reports drift and changes nothing) |
| `npm run backup` / `npm run backup:pull` | a verified database backup on the box / the whole backup set copied to your machine |

## Exchange rates, stated

A rate is how much of the base currency one unit of the foreign currency is worth, fetched for the receipt date in the company's own calendar (company policy; submission-date, which is the day the receipt arrived, and monthly-fixed are the alternatives). The base currency cannot be changed once receipts have been converted to it. The European Central Bank's reference rates come first, through Frankfurter, which publishes about thirty currencies with history by date. ExchangeRate-API covers the rest, around 160 in total, but only for today, so a currency the ECB does not publish is priced at the day's rate and the report says so. After both, whatever an admin types in.

Thirty-two currencies are offered by name in the claim screen and the rates page, from [main/intake/currencies.js](main/intake/currencies.js). That is a convenience, not a limit: any three-letter code can be typed, and the reader accepts any real ISO code it reads off the receipt (and takes "RMB", "RM", "S$" and the like for the one currency they mean).

Below a rate of 0.1 the provider is asked the other way round and the answer inverted. Both providers round to decimal places rather than significant figures, so one Indonesian rupiah comes back as 0.000072 Singapore dollars, which is two figures and puts a ten-million-rupiah hotel bill SGD 2.69 out. Asked as "how many rupiah to the dollar" the same provider gives 13,941.2, and inverting that keeps the precision. Rates are printed to six significant figures and stored with every digit.

Four checks stand between a provider's number and a figure somebody is paid. The two providers are fetched together when both can answer for the day, and a disagreement over 1% is recorded on the rate and shown. A rate more than 10% from the last one known for that pair is refused rather than frozen onto a line: the line says why and an admin settles it by entering the rate, which is never blocked. A rate priced after the receipt date, which happens for the currencies with no published history, marks the expense and the report footnote rather than passing quietly. And a sweeper re-prices every quarter of an hour anything left without a rate because a provider was unreachable, skipping locked expenses and anything somebody typed a rate onto.

The rate, its date, its source and the moment it was fetched are stored on every line and printed on the report. Each line is converted and rounded to the cent; the report total is the sum of the lines. A rate an admin or the claimant types in is kept with the person and the reason until someone asks for a refresh.

**The live board and the daily log** ([main/fx/live.js](main/fx/live.js), Settings → Exchange Rates). Every currency a receipt has used, plus any an admin adds, is refreshed every hour (`FX_LIVE_MINUTES`), one request per source whatever the number of currencies. At 23:55 company time the day's last figure is written as that day's close, and the close is the price of the day: it outranks any lookup made for that date, and only a rate an admin typed beats it. A receipt dated today takes the live figure and moves to the close that night unless its case has been claimed. A day the server was down for is closed late from the providers' history. The free feeds publish once a day, so without a key the board moves when they publish; an Open Exchange Rates App ID, entered on the same page and checked before it is kept, makes it hourly on their free plan and faster on paid ones, with the ECB kept as its cross-check.

## Not yet

- A live post to the real Xero organisation: the code and a dry run exist; connect the org in Settings and click Post.
- Multi-level approval, by design: Solv records claims and routes them through nobody.
- Mileage measured on a map; it is typed in km. Partial per-diem rules beyond one travel-day percentage (meals provided, half days).
- `.msg` files whose body is only RTF give no body text; their attachments are still read.
