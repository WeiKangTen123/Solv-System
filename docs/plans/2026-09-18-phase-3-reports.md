# Solv Expense Claims — Phase 3 (expense reports, approval, export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reviewed expenses are filed into an Expense Report with a cover, the claimant submits it, their manager approves or rejects it, finance marks it paid, and anyone entitled can export it as a PDF (cover, lines by category in SGD, rate footnote, signatures, receipts appended), an XLSX or a CSV.

**Architecture:** A `reports` store owns `expense_reports` and `report_events`; a `workflow` module owns the state machine and who may move it; `expense-doc.js` turns a report payload into a pdfmake document definition (plain data, tested without rendering) and `expense-export.js` renders PDF/XLSX/CSV and builds the receipts appendix (images resized with sharp, PDFs rendered with the Phase 1 renderer). Expenses inside a submitted report are locked. The UI gains Reports, Report detail and Approvals pages.

**Tech Stack:** as before; pdfmake with the standard Helvetica fonts (no font files), exceljs, sharp.

**Decisions fixed here:** report numbers are `EXP-<year>-<0001>` per company; one approval level (the owner's manager, or finance/admin, never the owner); a rejected report is editable and can be resubmitted; the report total is the sum of the lines' base amounts; advances are entered on the cover and subtracted.

---

## File structure

```
main/store/reports.js            expense_reports + report_events CRUD, numbering, totals
main/reports/workflow.js         submit / approve / reject / markPaid with access rules; isLocked(expense)
main/reports/expense-payload.js  gathers everything an export needs (report, owner, lines, columns, notes, appendix)
main/reports/expense-doc.js      pdfmake docDefinition + csv + workbook model, from the payload (pure data)
main/reports/expense-export.js   renders: pdfBuffer(def), xlsxBuffer(payload), csvText(payload)
main/routes/reports.js           CRUD, filing, transitions, queue, export-url/export
main/routes/expenses.js          refuses edits to a locked expense
ui: pages/Reports.jsx, pages/ReportDetail.jsx, pages/Approvals.jsx; Home + ExpenseReview + StatusBadge + nav edits
```

---

### Task 1: Report store

**Files:** `main/store/reports.js`, `main/store/reports.test.js`

- [ ] **Step 1: Failing test** — numbering per company and year; filing gives totals by category, reimbursement (total minus advances), `pendingRates` and `unreviewed` counts; list carries summary totals and filters by user/status; events record the actor's name; deleting a draft unfiles its expenses.

- [ ] **Step 2: Implement** — `createReport({ companyId, userId, kind, title, purpose, periodFrom, periodTo, destination, nights, advances, notes })` takes the next number from `companies.next_report_no` inside a transaction (`EXP-<year>-<0001>`), writes a `created` event; `getReport(id)` returns the row plus `expenses` (with lines, ordered by receipt date), `totals { totalBase, byCategory, pendingRates, unreviewed, expenseCount, lineCount, reimbursement }` and `events`; `listReports({ companyId, userId, userIds, status })` uses one SQL with sub-selects for `expense_count`, `base_cents` and `pending_lines` and joins the owner's name; `updateReport(id, patch)` for the cover fields and `advances`; `setState(id, patch)` for status fields; `addExpense/removeExpense` set `expenses.report_id`; `deleteReport`; `addEvent/listEvents`.

- [ ] **Step 3:** tests PASS. Commit `feat(reports): report store with numbering, totals and events`.

### Task 2: Workflow and locking

**Files:** `main/reports/workflow.js`, `main/reports/workflow.test.js`, `main/routes/expenses.js`

State machine: draft → submitted → approved → paid → posted; submitted/approved → rejected (finance only from approved); rejected → submitted. `EDITABLE = draft|rejected`.

- [ ] **Step 1: Failing test** — submit needs the owner (or admin), at least one expense, every expense `reviewed`, no pending rate, and refuses a second submit; approve by the owner's manager, finance or admin, never the owner, never an unrelated manager (`canDecide`); reject needs a reason and reopens the report (`isEditable`); paid by finance/admin only after approval; `isLocked(expense)` true while the report is out of the owner's hands.

- [ ] **Step 2: Implement** `submit(reportId, actor)`, `approve`, `reject(reportId, actor, reason)`, `markPaid`, `canDecide`, `isEditable(report)`, `isLocked(expense)`; each transition calls `reports.setState` and `reports.addEvent`. Errors are plain `Error`s with the sentence the UI shows.

- [ ] **Step 3: Lock** — in `routes/expenses.js` guard PATCH `/:id`, PUT `/:id/lines`, PATCH `/:id/status`, POST `/:id/reread`, POST `/:id/fx`, PATCH `/:id/fx`, POST `/:id/merge`, DELETE `/:id` with `if (isLocked(e)) return res.status(409).json({ error: 'This expense is in a report that has been submitted. Ask for it to be rejected to change it.' })`; test it.

- [ ] **Step 4:** tests PASS. Commit `feat(reports): workflow — submit, approve, reject, paid; locked expenses`.

### Task 3: Export payload and document definition

**Files:** `main/reports/expense-payload.js`, `main/reports/expense-doc.js`, `main/reports/expense-export.js`, `main/reports/expense-doc.test.js`

- [ ] **Step 1: Failing test** on a hand-built payload (company with columns, report, owner, manager, approver, four lines incl. an on-behalf line, a manual-rate line and a base-currency line in a category outside the columns, three receipts):
  - `buildModel`: columns collapse to those used plus `Other`; each row's `cells` holds its base amount under its column; `categoryTotals`, `total`, `reimbursement` to the cent.
  - `rateNotes`: one per (currency, rate, date, source, who): the provider form "INR→SGD 0.01341, European Central Bank reference rate for 1 Sep 2026, via Frankfurter, fetched 18 Sep 2026 …", the manual form "INR→SGD 0.0135 entered by elaine@solv.sg on 4 Sep 2026: card statement". `notes` carry the policy + rounding sentence, the ‡ on-behalf sentence, and the foreign-tax sentence when a foreign line has tax.
  - `expenseReportDoc`: landscape; the JSON contains the number, employee, destination, `SGD 661.35`, `Approved by`, `R2`, `rounded to the cent`; the lines table head is `['#','Date','Description','Ccy','Amount','Rate', …columns, 'Total SGD']`; the last row carries the total.
  - `expenseReportCsv`: header `Report,Line,Date,Merchant,Description,Purpose,On behalf of,Category,Currency,Amount,Rate,Rate date,Rate source,SGD,Receipt`; one row per line.
  - `workbookModel`: sheets Cover, Lines, Rates, Receipts.

- [ ] **Step 2: Implement `expense-doc.js`** (pure data): `buildModel(payload)`, `expenseReportDoc(payload)` (cover table without borders; reimbursement block; lines table with banding and rules; EXCHANGE RATES section; notes; Claimant / Approved by / For office use columns; one appendix section per receipt with `pageBreak: 'before'` and each page image `fit: [770, 460]`), `expenseReportCsv(payload)`, `workbookModel(payload)`, `exportFilename(payload)`. Text is folded to Latin-1 (the standard PDF fonts cover nothing else) with a fold that keeps the en dash, right quote, arrow and double dagger.

- [ ] **Step 3: Implement `expense-payload.js`**: `reportPayload(reportId, { withReceipts })` gathers company, report, owner, manager, approver; flattens expenses to lines carrying `ref` (R1, R2 … one per receipt file in report order), merchant, purpose, description, category, currency, amount, all fx fields, baseAmount, onBehalfOf, tax; builds `receipts: [{ ref, title, pages: [{ dataUri }] }]` — images through sharp (rotate, fit 1400 px, JPEG 78), PDFs through `pdfRender.renderPdfPages(buffer, { dpi: 110, maxPages: 10 })`.

- [ ] **Step 4: Implement `expense-export.js`**: `pdfBuffer(definition)` with the Helvetica printer built once; `xlsxBuffer(payload)` from `workbookModel` with money formats, a frozen header on Lines and a SUM formula for the total; `csvText = expenseReportCsv`.

- [ ] **Step 5:** tests PASS. Commit `feat(reports): export payload, document definition, PDF/XLSX/CSV renderers`.

### Task 4: Reports route

**Files:** `main/routes/reports.js`, `main/routes/reports.test.js`, `main/index.js`

- [ ] **Step 1: Failing test** — create + file (only the owner's reviewed unfiled expenses; `skipped` lists the rest) + read with totals; access (owner, manager of owner, finance/admin; others 404); the full journey submit → approve (manager) → paid (finance) with wrong actors refused (403), a locked expense (409) and a locked cover (409), the manager's queue; reject with reason then resubmit; listing by `scope=mine|team|all`; draft deletion; exports through a signed link returning real bytes (`%PDF`, `PK`, `Report,Line`), a bad token 401, a stranger's export-url 404.

- [ ] **Step 2: Implement** `GET /` (`scope`), `POST /`, `GET /queue` (manager: submitted reports of direct reports; finance/admin: submitted + approved), `GET /:id`, `PATCH /:id` (owner/admin, editable else 409), `DELETE /:id`, `POST /:id/expenses { expenseIds }` → `{ report, skipped }`, `DELETE /:id/expenses/:expenseId`, `POST /:id/submit|approve|reject|paid` (workflow errors → 403 when the message is about who may, else 400), `GET /:id/export-url?format=pdf|xlsx|csv` → 5-minute token `{ purpose: 'report-export', reportId, format, userId }`, `GET /:id/export?token=` → payload with receipts, RFC 5987 `Content-Disposition`, bytes. Mount `/api/reports`.

- [ ] **Step 3:** `npm test` PASS. Commit `feat(reports): routes — filing, workflow, queue, exports`.

### Task 5: UI

- [ ] `pages/Reports.jsx`: list with scope toggle (mine / team / all by role), number, title, period, status badge, total, expense count; "New report" form (title, purpose, kind, from, to, destination).
- [ ] `pages/ReportDetail.jsx`: cover form (editable while draft/rejected), rejection banner, expenses table (remove), "Add expenses" panel of own unfiled reviewed expenses, totals by category, advances and reimbursement, rates used, history, actions by role and status (Submit; Approve / Reject with reason; Mark paid), Export PDF / XLSX / CSV.
- [ ] `pages/Approvals.jsx`: the queue; open → detail.
- [ ] Home: open reports list; unfiled reviewed expenses get a "File into…" select. ExpenseReview: report picker; locked banner disables editing. StatusBadge gains the report statuses. Nav gains Reports and Approvals (manager/finance/admin).
- [ ] `npm run build:ui && npm test` PASS. Commit `feat(ui): reports, report detail, approvals, filing`.

### Task 6: Acceptance — the real report from the two folios

- [ ] `main/scripts/demo-report.js`: in a temp `DATA_DIR`, create Elaine (employee, Sales, S0042, manager Henry) and Henry (manager); create expenses from the saved acceptance JSON (real receipt files attached for the appendix), price them with the live provider, file them into "India trip, Sep 2026", set purposes, submit as Elaine, approve as Henry, export PDF + XLSX + CSV into `docs/acceptance/`. Record totals and page count in `docs/acceptance/2026-09-18-report-export.md`. Commit.
