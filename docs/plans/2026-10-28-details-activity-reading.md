# Case details with AI, a real Activity tab, and reading accuracy (2026-10-28)

Approved with "proceed" on 2026-10-28, every default taken. Built on the
branch `feat/details-activity`; nothing is merged to `main`, pushed or deployed
until the product owner asks. Read with docs/plans/2026-10-21-case-intake.md.

## What the investigation found (short)

- **Details**: the AI's rules fill kind/title/dates/destination/nights on a
  draft; on an open case the "AI suggests" line shows only inside Edit, only
  for fields the person owns, and ignores the case's kind and the 3-day widen
  rule (a Trip is offered "Month"; one stray receipt offers 49 nights).
- **Activity**: lists case events only; details edits, AI changes, receipt
  edits and checks on an open case, and receipts taken out are missing.
- **Reading**: 92% of 285 field checks right on 19 live reads; the errors are
  tax names other than GST/VAT/CGST, included tax counted again, discounts and
  residuals put on the largest line whatever its person or category, US date
  order, tips, and colleagues' lines on hotel folios. Production's Courtyard
  folio has INR 940.50 on the wrong person; no flag fired anywhere.

## Decisions

1. **Purpose**: a factual draft built by rules from the receipts ("Hotel stays
   and local transport in Mumbai and Pune, 1–4 Sep 2026") plus up to three of
   the person's own past purposes. Offered, never saved until the person picks
   one (and can edit it). Never names a client, a meeting or a reason.
2. **The India case in production**: no writes; the owner gets a correction list.
3. **Old receipts' city/country/type**: left empty (a re-read would overwrite
   reconciled values).
4. Three agents in parallel, then QA.

## A. Reading accuracy (server)

Fixes, each with a unit test (the investigation's experiments are the cases):

- **P1 tax lines**: recognise tax names by country (GST, CGST/SGST/IGST/UTGST,
  VAT, SST, PPN/PB1, MwSt/USt, HST/GST/PST, IVA, TVA, 消費税), matched at the
  start of a line's description; leave out city/tourism/hotel levies and
  "incl./included/tax-free" wording; override the model's tax figure from the
  lines only when there are two or more tax lines.
- **P2 included tax**: the prompt says not to list a tax already included in
  the prices; lines marked included are dropped when the other items already
  add up to the total.
- **P3 discounts and rounding**: kept as negative amounts in their category;
  a category group at zero or below is dropped.
- **P4 residuals**: the difference between the lines and the total goes to
  the claimant's own line in the receipt's category, never a colleague's or
  another category's; above 2% the receipt gets the `lines-adjusted` check.
- **P5 dates**: the prompt asks for the date as printed and the merchant
  country's convention; a date whose day and month are both 12 or under, read
  from a receipt of a month-first country (US, and any the model says), gets
  the `date-order` check.
- **P6 tips**: a tip/gratuity is part of the amount charged; prefer a GRAND
  TOTAL or card line larger than "Total".
- **P7 subtotal**: worked out after the final tax.
- **P8 currency**: codes validated against `Intl.supportedValuesOf('currency')`;
  RMB→CNY, YEN→JPY, NTD→TWD, RM→MYR.
- **P9 payment filter**: a visa *fee* is a charge; "cash tendered" is not; a
  real line equal to the total is kept when it is the only line.
- **P10 categories**: synonyms (Hotel/Accommodation → Lodging, Transport/Taxi
  → Air & Transport, Food/F&B → Meals, …); on a hotel folio a line the model
  put in Office Supplies, Software/Utilities or Medical goes to the receipt's
  category.
- **P11 decimal comma**: "12,50", "1.234,56", "Rp 1.250.000" read right.
- **P12 people on folios**: the prompt keeps the full printed description of
  every line (room number and transfer arrow), and a transfer header carries
  to the lines under it even across a page break.
- **Refunds**: a negative total is read as no amount with the note "This looks
  like a refund; refunds are not claimed here."

Read-time checks stored in `aiRead.checks` (computed in read-receipt.js, so
they survive edits and show what the AI saw):
`{ subtotalMismatch: { subtotal, tax, total } | null, chargedTwice: [{ description, amount, count }], people: [names], adjusted: { amount, pct } | null, dateOrder: { read, other } | null }`.

New yellow flags in receipts/flags.js: `split-people` ("Split between you and
Tan Suan Kuan: check each person's lines"), `subtotal-mismatch` (any
currency), `charged-twice`, `lines-adjusted`, `date-order`.

**Eval harness** committed under `main/scripts/eval/` (synthetic receipts with
ground truth made by script, the two sample folios with their ground truth,
a runner and a scorer), run with `npm run eval:reader` against the live model,
never by jest. Before/after scores go in the final report.

## B. Details with AI (server + UI)

- `reports/cover-help.js` (new): `caseSuggestion(report)` — kind-aware: a
  draft gets `suggestCover`; an open case keeps its kind (title made for that
  kind), dates by cover-auto's open rule (exported from cover-auto.js), nights
  from those dates. `purposeDraft(report)` — rules only, from categories,
  cities/countries and the dates. `pastPurposes(userId)` — the person's own
  three most recent distinct purposes from their cases.
- `GET /api/reports/:id/cover-suggestions` (routes/cover.js, new, mounted under
  /api/reports by the lead) → `{ fields: { kind, title, periodFrom, periodTo,
  destination, nights }, current: {…}, coverAi, basis: { receipts, cities,
  countries, from, to }, purposeDraft, pastPurposes }`. Owner or admin viewer.
- `POST /api/reports/:id/cover-ai { fields }` — hand fields back to the AI:
  out of `user`, into `auto`, then `cover-auto.refresh`. Owner, editable.
- `reports/intake-view.js`: `suggestion` becomes `caseSuggestion(report)`.
- `reports/cover-auto.js`: when it changes fields it writes a report event
  `ai_details` with a note like "Dates 1–4 Sep 2026 → 31 Aug – 4 Sep 2026;
  nights 3 → 4".
- `reports/cover-patch.js` (new): the cover validation now private in
  routes/reports.js (`_coverPatch`), exported; the lead switches
  routes/reports.js to it at integration.
- Assistant: `propose_case_details` (owner, open case, not a draft; kind,
  title, dates, destination, nights, purpose, notes; validated with
  cover-patch; Apply checks the "from" values and calls
  `reports.updateReport`); `get_case` returns `coverAi` and the suggestion.
- UI: on Details a "✦ Fill from receipts" panel — each field's suggestion
  beside its current value, a tick per field, a source line ("from 4 receipts
  in Mumbai and Pune, 31 Aug – 4 Sep"), Apply (PATCH the ticked fields), and
  "Let the AI keep this up" per field (cover-ai). Purpose gets a "Suggest"
  button with the draft and past purposes as choices that fill the field.
  The same purpose choices on the New case page's form. "Done" stays open and
  shows the error when a save failed.

## C. Activity (server + UI)

- Events written:
  - `details_edited`: the owner's PATCH, one event per actor per 15 minutes,
    listing the fields (updated in place while the person keeps typing).
  - `checked`: a single receipt checked from any page, coalesced the same way
    ("3 receipts").
  - `removed`: a receipt taken out of a case, naming it — routed through
    `edit.fileInCase(id, null)` so the receipt's own log records it too.
  - Draft creation keeps `created` with note `draft`; the UI says "Draft
    started", and `opened` says "Created".
- `GET /api/reports/:id/activity` (routes/activity.js, new, mounted by the
  lead) → `{ items: [{ at, actor: { type: 'person' | 'ai' | 'system', name },
  scope: 'case' | 'receipt', action, text, receiptId?, merchant?, field?, old?,
  new? }] }`: report events plus `expense_changes` of the receipts in the case
  (and the `case` field changes that moved a receipt in or out), newest first.
  AI = `ai_details` events and `via: 'reread'` changes; system = the reader,
  Xero, the sweeper.
- UI: Activity as one timeline grouped by day, filter All / People / AI /
  System, each entry linking to its receipt on the review page; "Rates used"
  stays. `xero_failed` and every action has a label. The admin banner says
  what is really logged.

## Who builds what

| Agent | Owns |
|---|---|
| A Reading | `receipts/receipt-parser.js`, `receipts/read-receipt.js`, `intake/document.js`, `intake/categories.js`, `receipts/flags.js`, `main/scripts/eval/*`, `package.json` (only the `eval:reader` script), tests |
| B Details | `reports/cover-suggest.js`, `reports/cover-auto.js`, `reports/intake-view.js`, new `reports/cover-help.js`, new `reports/cover-patch.js`, new `routes/cover.js`, `assistant/tools.js`, `assistant/actions.js`, `ui/src/components/cases/CaseDetails.jsx`, `ui/src/components/intake/CoverForm.jsx`, `ui/src/components/intake/useCover.js`, tests |
| C Activity | `store/reports.js`, `store/changes.js`, `receipts/edit.js`, `routes/reports.js` (event writes; no new routes), `routes/expenses.js` (the checked event), new `reports/activity.js`, new `routes/activity.js`, `ui/src/components/cases/CaseActivity.jsx`, `ui/src/pages/ReportDetail.jsx` (banner only), tests |
| Lead | mounts in index.js, switching routes/reports.js to cover-patch.js, merging the CSS sections, the full run, QA, the correction list |

Each appends its CSS to the end of ui/src/styles/globals.css in one marked
section. Every agent runs `npm test`, `npm run lint` and `npm run build:ui`.
