# A receipt kept as printed

Asked on 2026-10-29: "the tax should follow the receipt: like Malaysian
receipts, we follow all the amounts, including the line items and the tax
rate." Approved on 2026-10-30 with all defaults.

What was found (live reader on 15 receipts plus a two-rate Malaysian hotel,
branch feat/details-activity at 87c562d): the reader sees nearly everything
(251/254 fields), but only five values reach the expense. Items are grouped
into one line per category and person ("Nasi Kandar Ayam Goreng +5 more"),
quantity and unit price are folded into text, no tax name or rate is asked
for or kept, the service charge, rounding, tip and levies vanish into line
amounts, a printed subtotal equal to the total is rewritten as total − tax,
and two tax rates are summed and re-split by amount (KL hotel 24.64/5.61
printed, 23.46/6.79 sent to the PDF and Xero). The PDF names the tax from the
company's currency, not the receipt. Two flags second-guess the printed tax.

The rule from here: **the record of a receipt is what is printed on it.**
Solv never recalculates a printed figure. The amount claimed is still the
total paid.

## Decisions

1. Old receipts stay as they are (no record). They keep today's lines editor
   and show "Read again to see the receipt as printed". No automatic re-read.
2. A Singapore receipt that prints only "Price payable includes GST": a tax
   row "GST 9%", included, amount worked out as 9/109 of the total, marked
   `worked: true` and shown as "worked out". Only when the receipt names the
   GST and prints no amount; never for any other country or tax.
3. The India case is rechecked after "Read again" once this ships.
4. This builds on feat/details-activity; both ship together after QA.

## The record

`expenses.printed` (TEXT, JSON, nullable). `null` means not kept: an old
receipt, a typed-in expense, a claim-form import, an allowance. `aiRead.printed`
holds the reader's own copy, so a row changed away from what was read can say
"AI read: … use".

```js
{
  v: 1,
  rows: [Row],            // in printed order: everything that makes up the total
  subtotal: number|null,  // as printed; null when none is printed. Never derived.
  total: number,          // the amount charged, tip included; always equals expenses.total
}

Row = {
  kind: 'item' | 'charge' | 'discount' | 'tax' | 'rounding',
  label: string,          // as printed: "Nasi Kandar Ayam", "Service Charge", "SST", "Service Tax",
                          // "CGST", "Tourism Tax", "Rounding Adj". Without the rate: the rate is its own field.
  qty: number|null,       // item: when printed
  unitPrice: number|null, // item: when printed
  amount: number,         // as printed, in the receipt's currency. discount and rounding may be negative.
  rate: number|null,      // percent as printed: tax 6, service charge 10, discount 50. null when none printed.
  included: boolean,      // tax: already inside the prices ("GST 9% incl.", "enth. MwSt"), so not added. false otherwise.
  worked: boolean,        // tax: the amount is not printed and was worked out (decision 2). false otherwise.
  category: string|null,  // item/charge/discount: the claim category. A row printed under a charge takes its category.
  onBehalfOf: string|null,// whose charge it is (a folio transfer), as today's lines
  taxRate: number|null,   // item: the combined tax rate the receipt shows applies to it (8, 6, 18, 0), when it shows
                          // (a tax code, a marker, room vs F&B on a hotel bill). null: not shown.
  on: number|null,        // tax/charge/discount printed under one row (a folio's per-charge CGST, an item discount):
                          // that row's index in rows. null: it is for the receipt as a whole.
}
```

- **Kinds.** `item`: what was bought. `charge`: service charge, tip, surcharge,
  delivery, platform fee, and levies that are not the tax on the sale
  (tourism tax, city tax, SF mandate). `discount`: a promotion or voucher.
  `tax`: the government tax on the sale (SST, Service Tax, Sales Tax, GST,
  CGST, SGST, IGST, VAT, MwSt, PPN, PB1, HST, sales tax, 消費税). `rounding`:
  the 5-sen (or other) rounding.
- **Adds up.** The rows that are not included tax sum to `total`. When they
  do not, within the currency's step, the screen says so quietly (below);
  the record is still kept as read and the claim lines still come to the total.
- **Tax figure.** `expenses.tax` = the sum of the tax rows (added and
  included), except that a tax total printed in the receipt's own tax summary
  wins (the JW folio prints 6,759 against per-charge lines of 6,760). So
  CSV, assistant and old code keep working. `expenses.subtotal` = `subtotal`.
- **Limits.** At most 300 rows; labels at most 120 characters.

### The currency's step (one rule, server and screen)

`step(currency)`: MYR 0.05, SGD 0.05, INR 1, JPY 1, KRW 10, IDR 100, VND 1000,
everything else 0.02. The rows "add up" when |sum − total| ≤ step, or ≤ 0.01
when the rows hold a rounding row, or ≤ 0.5% of the total when the record has
per-charge tax rows (`on` set) — a folio's taxes carry their own rounding.

## Claim lines from the record

`main/receipts/printed.js` (new) exports `claimLines(printed, fallbackCategory)`.
Whenever a record exists, `expense_lines` are rebuilt from it on every read
and every save; nobody edits those lines by hand.

- Items group by (category, onBehalfOf), as today. A row with `on` goes with
  the row it is on, and takes its group.
- A charge, discount or rounding with `on: null` is spread over the items by
  amount (rounding: on the claimant's own line in the receipt's category).
- A tax with `on: null`: on the items whose `taxRate` is its rate group; with
  no `taxRate` on any item, on every item. Rate group: a tax row's `rate`, or,
  for a pair printed together (CGST 9 + SGST 9), their sum. Spread by amount
  within the items it is on.
- An added tax adds to its line's amount; an included tax does not (it is
  already in the items) but is still recorded on the line.
- The lines come to the total to the cent. A difference goes to the claimant's
  own line in the receipt's category, as `buildLines` does today, and rows
  nowhere near the total (more than 15%) give one line for the whole total.
- Description: the first item's label, then "+N more", as today.

Each line carries its taxes:

```js
line.taxes = [{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64 }]
// amount: this line's share of that tax, in the line's currency.
// gross: the part of this line's amount (tax-inclusive, as claimed) that the tax
//        was charged on, i.e. what Xero needs as an Inclusive line amount.
// []   : the receipt prints no tax for this line.
// null : not known (a line from before this change, or typed in).
```

Stored in `expense_lines.taxes` (TEXT, JSON, nullable). Shares are rounded to
the cent with the last share taking the residual, so a tax's shares add up to
its printed amount.

## Database

Migration step 9, "a receipt keeps what it printed": `expenses.printed TEXT`,
`expense_lines.taxes TEXT`, both nullable, by `_ensureColumn` inside the step.
`schema.sql` gets both columns; `schema-version.js` LATEST = 9.

## API

- `GET /api/expenses/:id` (and every place an expense is sent): `printed`,
  `aiRead.printed`, and `taxes` on each line.
- `PUT /api/expenses/:id/printed` `{ printed }`: who may is `detailsBlocked`,
  as for details. Validated (shape, numbers, kinds, limits; 400 with a
  sentence otherwise). Saves the record, sets `total`, `tax` and `subTotal`
  from it, rebuilds the lines from it (an exchange rate a person typed is
  kept, as `editLines` keeps it), reprices, logs the change (below) and
  returns the expense as `GET` does.
- `PATCH /api/expenses/:id` with `total` on a receipt that has a record:
  sets `printed.total` too, so the two never differ.
- `PUT /api/expenses/:id/lines` on a receipt that has a record: 409, "This
  receipt's lines come from its items; change the items instead." The
  assistant's line proposals answer the same.
- `POST /api/expenses/:id/reread`: writes the record and `aiRead.printed`.
- A merge of two expenses that combines their lines drops the record on the
  result (it is no longer one printed receipt).

## The change log and Activity

A record's change is written in words, per row, as the change log already does
for fields: "SST 6% 1.58 → 1.60", "Added Teh tarik 5.60", "Removed Rounding
−0.02", "Category of Roti canai Meals → Other", "Service charge 10% → 0%".
At most five rows named, then "and N more".

## The flags

`gst-mismatch` and `subtotal-mismatch` go, with `aiRead.checks.subtotalMismatch`.
Nothing replaces them as a flag. The screen shows one quiet line under the
total when the rows do not add up (step above): "These come to 27.85, 0.30
under the total." with "+ add 0.30" (adds an item "Not itemised" of the gap
in the receipt's category). It does not block a check, does not appear on the
case's flags, and is not in the PDF. The other flags stay.

## Screens

`PrintedPanel` (ui/src/components/receipt/PrintedPanel.jsx) replaces the lines
editor and the Total and Tax fields on the receipt page and the case Review
whenever the receipt has a record.

```
+--------------------------------------------------------------+
| As printed                                              MYR  |
|--------------------------------------------------------------|
| Item                    Qty     Amount  Category    Paid for |
| [Nasi kandar ayam    ]  [1]  [   9.50]  [Meals  v]  [      ] |
| [Roti canai          ]  [2]  [   3.00]  [Meals  v]  [      ] |
| [Teh tarik           ]  [2]  [   5.60]  [Meals  v]  [Jane T] |
| + item                                                       |
|--------------------------------------------------------------|
|                  Subtotal    [  23.90]                       |
| [Service charge] [10]%       [   2.39]                    .. |
| [SST           ] [ 6]%       [   1.58]                    .. |
| [Rounding      ]             [  -0.02]                    .. |
|==============================================================|
|                Total paid    [  27.85]                       |
| + tax   + charge   + discount   + rounding                   |
|     These come to 27.85, 0.30 under the total.  + add 0.30   |  (only when off)
|--------------------------------------------------------------|
| Claimed as: Meals 22.25 · Jane Tan Meals 5.60                |
+--------------------------------------------------------------+
  .. = row menu: change type (item/charge/discount/tax/rounding), split, remove
```

- Items in the table; the other rows in the footer, in printed order. A row
  with `on` sits indented under its row, or, for a folio's per-charge taxes,
  folds into one footer row per (label, rate, included) reading "on 8
  charges", opened to edit them one by one.
- A **Tax** column appears on the items only when the record holds two or more
  tax rate groups; its options are the record's groups and "–".
- An included tax shows under the total: "incl. GST 9% 1.73", and "worked out"
  when `worked`.
- Name, rate and amount are typed over in place; changing a rate never changes
  an amount. "AI read: SST 6% 1.58 · use" on a row that differs from
  `aiRead.printed`.
- "Claimed as" is read-only, from the lines the server returns.
- Narrow (the case Review pane, phones): rows read-only, one per line with a
  muted sub-line ("2 × · Meals · for Jane Tan"), tap opens a sheet with the
  row's fields, "AI read" and Remove.
- No record: today's editor and fields, and a link "Read again to see the
  receipt as printed" (the existing re-read).
- The case receipts table: a muted line under the amount, "incl. SST 6% 1.58";
  for a pair of the same rate, the names joined ("CGST+SGST 18% 3,969.00");
  for different taxes, "incl. 2 taxes 57.20" with the list as a tooltip;
  nothing when no tax is printed.

## Outputs

- **Payload** (reports/expense-payload.js): each line's taxes from
  `line.taxes`, each converted to the base currency at the line's rate;
  `tax`/`baseTax` are their sums. A line with `taxes: null` keeps today's
  proportional share of `expenses.tax`.
- **PDF details**: under the description, "incl. SST 6% · MYR 1.58" (one per
  tax, "incl." for an added tax too: the amount shown includes it). The
  "tax x" under the amount goes.
- **PDF summary**: "Tax by rate, as printed": one row per (label, rate,
  currency) with the number of receipts, the amount in the receipt's currency
  and in the base currency; a sub-heading for receipts in other currencies;
  "No tax printed: N receipts"; old lines without taxes as "Tax (rate not
  kept)". The company-currency name guess (`TAX_NAME`) goes. "Included in the
  amounts above, as printed on each receipt."
- **CSV and workbook**: per line "Tax as printed" ("SST 6%"; several joined
  with " + "), "Tax", and "Tax (base)". The hard-coded foreign-tax note goes.
- **Xero** (xero/bills.js): a claim line becomes one bill line per tax gross
  (taxes sharing a gross go together: CGST+SGST), with `taxAmount` the
  printed share in base and the tax type matched on the combined rate among
  the organisation's active purchase rates; no match: today's choice. The
  rest of the line (untaxed: a tourism tax, an unrated charge) is a line of
  its own on the zero type. Foreign currency lines stay on the zero type.
  Lines with `taxes: null` behave as today. `Inclusive` as today.
- **Assistant**: `get_receipt` returns the record's rows; the "tax is X but
  the reader read Y" and "tax is more than the total" remarks go; line
  proposals on a receipt with a record are refused as above.

## Reading

- The prompt asks for `rows` in printed order with the fields above, every
  row including an included tax (marked `included`) and the tax summary's
  total when one is printed; and `subTotal` exactly as printed.
- What today's normaliser protects stays: payments, restated totals and
  subtotals are not rows; a tip under "Total" is part of the amount charged;
  folio transfers and their tax lines keep their person; a service charge or
  a levy is never tax; tax above the total is not believed; refunds.
- What goes: the subtotal rewrite; quantity folded into text; tax rows removed
  from the items; the item regrouping as the only record.
- The reader eval (`npm run eval:reader`) scores the rows too: each tax's
  label, rate and amount, the charges, the rounding, the items' count, and the
  subtotal as printed. It gains the Malaysian two-rate hotel (Service Tax 8% on
  the room, SST 6% on F&B, service charge, tourism tax) and a 6%-and-8% bill.

## Who owns what

| Builder | Branch / worktree | Owns |
|---|---|---|
| 1 Reader and record | ap/read, solv-wt/ap-read | main/receipts/{receipt-parser,read-receipt,line-kinds,flags,edit,printed}.js, main/intake/document.js, main/store/{expenses,changes}.js, main/db/*, main/routes/expenses.js, main/scripts/eval/*, their tests, README's reading paragraphs |
| 2 Screens | ap/ui, solv-wt/ap-ui | ui/src/** (PrintedPanel, ui/src/utils/printed.js with the step rule, the receipt page, case Review, case receipts, intake row), one appended section of globals.css |
| 3 Outputs | ap/out, solv-wt/ap-out | main/reports/{expense-payload,expense-pdf,expense-doc,activity}.js, main/xero/bills.js, main/assistant/*, their tests, README's PDF/Xero paragraphs |

Nobody edits another's files; a needed change is asked for. The record's
shape, `line.taxes` and the API above are fixed; a builder that finds them
wrong says so rather than working around them.
