# Acceptance: the Xero bill that would be posted for EXP-2026-0001 (dry run)

**Date:** 18 Sep 2026 · **Script:** `node main/scripts/demo-report.js --xero-dry-run` · **Sent to Xero:** nothing. The dry run builds the bill against Xero's default Singapore chart of accounts and tax rates with a pretend connected organisation, and stops.

| Field | Value |
|---|---|
| Type / status | ACCPAY (bill) / DRAFT — finance approves it in Xero as usual |
| Contact (payable to) | Elaine Xin Yu Khoo, elaine@solv.sg (created as a supplier if absent) |
| Invoice number / reference | EXP-2026-0001 / India trip, Sep 2026 |
| Date / due | approval date / + 7 days |
| Currency | SGD, amounts tax-inclusive |
| Total | SGD 1,776.78 (equals the printed report) |
| Attachments | R1 (JW Marriott Mumbai, 2-page PDF), R2 (Courtyard Pune, 4-page PDF), each within Xero's 3 MB limit |

| Line | SGD | Account | Tax |
|---|---|---|---|
| 1 Sep 2026 · JW Marriott Mumbai Sahar · Lodging · Client meetings, Mumbai office · on behalf of Tan Suan Kuan · INR 20,737.50 × 0.01341 | 278.09 | 494 Travel - International | NONE |
| 1 Sep 2026 · JW Marriott Mumbai Sahar · Lodging · Client meetings, Mumbai office · INR 20,738.50 × 0.01341 | 278.10 | 494 | NONE |
| 1 Sep 2026 · JW Marriott Mumbai Sahar · Meals · Client meetings, Mumbai office · INR 1,417.00 × 0.01341 | 19.00 | 420 Entertainment | NONE |
| 1 Sep 2026 · JW Marriott Mumbai Sahar · Meals · Client meetings, Mumbai office · on behalf of Tan Suan Kuan · INR 1,416.00 × 0.01341 | 18.99 | 420 | NONE |
| 4 Sep 2026 · Courtyard By Marriott Pune Chakan · Lodging · Client site visit, Chakan plant · INR 44,071.86 × 0.01341 | 591.00 | 494 | NONE |
| 4 Sep 2026 · Courtyard By Marriott Pune Chakan · Lodging · Client site visit, Chakan plant · on behalf of Tan Suan Kuan · INR 35,772.84 × 0.01341 | 479.71 | 494 | NONE |
| 4 Sep 2026 · Courtyard By Marriott Pune Chakan · Meals · Client site visit, Chakan plant · INR 6,426.57 × 0.01341 | 86.18 | 420 | NONE |
| 4 Sep 2026 · Courtyard By Marriott Pune Chakan · Meals · Client site visit, Chakan plant · on behalf of Tan Suan Kuan · INR 1,917.50 × 0.01341 | 25.71 | 420 | NONE |

Why these choices: the bill is raised in SGD at each line's frozen base amount, so Xero's figure equals the printed report to the cent whatever mix of currencies and rate dates the report holds; the foreign amount and rate ride in the description. Foreign GST is not Singapore input tax, so every INR line carries the org's zero-tax type; a Singapore receipt with GST would carry the org's "GST on Expenses" rate. Accounts come from the org's own chart by category name (Lodging → Travel - International, Meals → Entertainment on the default SG chart); a category the chart cannot place falls to the company's default account.

A live post waits for the real organisation to be connected in Settings (Custom Connection client id and secret, or the OAuth flow) and for finance to click Post; the same code path, minus the dry-run flag, is covered by `main/xero/bills.test.js` with the Xero SDK mocked.
