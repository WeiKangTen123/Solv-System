# Acceptance: the two Marriott folios read end to end

**Date:** 18 Sep 2026 · **Reader:** Gemini through `main/receipts/receipt-parser.js`, pages rendered by `main/pdf/render.js` at 150 dpi · **Script:** `node main/scripts/read-sample.js <file>`

Both files in `samples/receipts/` are scanned PDFs with no text layer. Each was rendered to page images and read as ONE document in a single model call. Raw outputs: `2026-09-18-jw-marriott-mumbai.json`, `2026-09-18-courtyard-marriott-pune.json`. The same Pune file was also uploaded through the running production server (`POST /api/receipts`) and came back as one expense in `review-needed` after about 27 seconds with the figures below.

| Check | JW Marriott Mumbai (2 pages) | Courtyard Pune (4 pages) |
|---|---|---|
| One expense, not one per page | PASS — 1 document | PASS — 1 document |
| Merchant | PASS — JW Marriott Mumbai Sahar | PASS — Courtyard By Marriott Pune Chakan |
| Receipt date | PASS — 2026-09-01 | PASS — 2026-09-04 (bill date; stay 1–4 Sep) |
| Invoice number | PASS — 3967-860265 | PASS — 93/713-181024 |
| Currency | PASS — INR | PASS — INR |
| Total | PASS — 44,309.00 (folio: 44,309.00) | PASS — 88,188.77 (folio: 88,188.77) |
| Tax (CGST + SGST, from the tax lines) | NEAR — 6,760.00 (folio: 6,759.00; one SGST line read as 109 instead of 108) | PASS — 13,452.52 (folio: 13,452.52) |
| Charge lines found | 13 lines (12 charges and the card payment, which is dropped) | 39 charges, sum 88,188.77 (payment line dropped) |
| Lines split by category and reconciled | PASS — Lodging 20,738.50; Lodging on behalf of Tan Suan Kuan 20,737.50; Meals 1,417.00; Meals on behalf of Tan Suan Kuan 1,416.00 | PASS — Lodging 44,071.86; Lodging on behalf of Tan Suan Kuan 35,772.84; Meals 6,426.57; Meals on behalf of Tan Suan Kuan 1,917.50 |
| Colleague's transferred room detected | PASS — Tan Suan Kuan on every transferred line | PASS — Tan Suan Kuan; one CGST line (940.50) lost its transfer note, so the on-behalf share reads 35,772.84 against a true 36,713.34 |
| Time to read | 14 s | 12–34 s across three runs |
| Confidence reported | high | high |

## What was fixed during acceptance

1. The payment line ("Manual MasterCard / Euro Card 88,188.77") came back as a charge and doubled the sum, so the split fell back to one line. Payment and settlement lines are now dropped in the normaliser, and a line that merely restates the total is dropped when other lines exist.
2. Tax came back as 0 (Mumbai prints "VAT 0.00" in the footer) or null. When the document states no tax, the tax is now the sum of the GST, VAT and service-charge lines.
3. The colleague's name came back as the raw transfer string ("Tan Suan Kuan #1155 => Khoo #110") or was missed where it sat inside the description. It is now read from the printed "NAME #room=>" text, or cleaned from the model's answer, and title-cased so one colleague groups as one line.

## Left for the claimant to correct on screen

- Mumbai: one rupee on one SGST line (109 read, 108 printed). The line split still reconciles to the total because the residual is absorbed by the largest line.
- Pune: one of the six transferred-room CGST lines lost its transfer note in the read, so 940.50 sits on the claimant's own Lodging line instead of the colleague's. The review screen's line editor moves it in one edit.

Both are model reads of a scanned image, not pipeline defects; the Re-read button gives the model another look, and every figure is editable before the expense is marked reviewed.
