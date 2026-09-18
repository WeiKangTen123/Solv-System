# Acceptance: the expense report built from the two folios

**Date:** 18 Sep 2026 · **Script:** `node main/scripts/demo-report.js` (throwaway data directory; expenses from the saved reader output; live ECB rates; real receipt files appended).

**Journey exercised:** Elaine (employee, Sales, S0042, reports to Henry) has both folios as reviewed expenses → files them into report **EXP-2026-0001 "India trip, Sep 2026"** (31 Aug – 4 Sep 2026, Mumbai and Pune, 4 nights) → submits → Henry (manager) approves → the report is exported.

| Output | Result |
|---|---|
| `docs/acceptance/exports/EXP-2026-0001_Elaine-Xin-Yu-Khoo.pdf` | 7 pages, 765 KB: the report page, then R1 (2 pages, JW Marriott Mumbai) and R2 (4 pages, Courtyard Pune) appended |
| `docs/acceptance/exports/EXP-2026-0001_Elaine-Xin-Yu-Khoo.xlsx` | sheets Cover, Lines (with a SUM formula), Rates, Receipts |
| `docs/acceptance/exports/EXP-2026-0001_Elaine-Xin-Yu-Khoo.csv` | 8 lines, one per category line |

**Figures on the report** (SGD, rate INR→SGD 0.01341 for 1 Sep and 4 Sep 2026, ECB via Frankfurter):

| # | Date | Line | INR | SGD |
|---|---|---|---|---|
| 1 | 1 Sep | JW Marriott Mumbai · rooms, on behalf of Tan Suan Kuan ‡ | 20,737.50 | 278.09 |
| 2 | 1 Sep | JW Marriott Mumbai · rooms | 20,738.50 | 278.10 |
| 3 | 1 Sep | JW Marriott Mumbai · breakfast | 1,417.00 | 19.00 |
| 4 | 1 Sep | JW Marriott Mumbai · breakfast, on behalf of Tan Suan Kuan ‡ | 1,416.00 | 18.99 |
| 5 | 4 Sep | Courtyard Pune · rooms | 44,071.86 | 591.00 |
| 6 | 4 Sep | Courtyard Pune · rooms, on behalf of Tan Suan Kuan ‡ | 35,772.84 | 479.71 |
| 7 | 4 Sep | Courtyard Pune · MoMo Cafe meals | 6,426.57 | 86.18 |
| 8 | 4 Sep | Courtyard Pune · MoMo Cafe meals, on behalf of Tan Suan Kuan ‡ | 1,917.50 | 25.71 |
| | | **Lodging 1,626.90 · Meals 149.88 · Total reimbursement** | | **1,776.78** |

Footnotes printed: the two rate lines with source, date and fetch time; the policy and rounding rule; the ‡ on-behalf note naming Tan Suan Kuan; the foreign-tax note. Signature block: Claimant (submitted date), Approved by Henry Bennett with the timestamp, For office use (not yet paid; Receipts: 2 (R1, R2)).

Checks passed: one R-number per receipt file shared by its lines; category columns collapsed to the two used; the total equals the sum of the rounded lines (1,776.78, against 1,776.79 if each receipt were converted whole, which is the rule the footnote states); the workflow refused approval before submission and refused the claimant approving her own report (covered in `main/routes/reports.test.js`).
