# Solv documentation

Everything written about the system, in the order it was produced.

| Folder | What is in it |
|---|---|
| `specs/` | The approved design, one file per subject, dated. Read `2026-09-17-solv-expense-claims-design.md` first: it carries the decisions the build follows. |
| `plans/` | The illustrated overview shown before any code was written (`2026-09-17-solv-expense-claims-overview.html`, open it in a browser), then one implementation plan per phase. |
| `acceptance/` | What was actually checked against real data: the folio reads, the exchange rates, the exported report, the Xero dry run. `exports/` holds the report those notes describe. |
| `RUNBOOK.md` | Running it on a server: what the box needs, what a deploy does and proves, backups, restore, rollback, crashes, key rotation. |
| `reference/report-templates/` | The two printed report templates Solv's report is built from. The cover comes from the business trip report, the column set, advances and office-use block from the expense report. |

Sample data lives outside this folder, in `samples/`: the two Marriott folios under `receipts/`, and the reader's saved output for each under `reads/`. Scripts read the saved output so a demo needs no model call.

New specs go in `specs/`, new plans in `plans/`, both named `YYYY-MM-DD-<topic>.md`.
