# Acceptance: the currencies staff actually travel with

**Date:** 19 Sep 2026 · **Asked for:** USD, MYR, IDR, VND, JPY, INR

## What was already true

Nothing in the system limited which currencies work. The reader accepts any
three-letter code, the rate service is currency-agnostic, and between them the
two providers cover about 160 currencies. All 26 tried resolved a rate against
SGD on the first attempt.

| Provider | Currencies | History |
|---|---|---|
| European Central Bank, via Frankfurter | USD, MYR, IDR, JPY, INR, THB, PHP, CNY, HKD, KRW, AUD, NZD, CAD, CHF, EUR, GBP and the rest of the ECB list | yes, by date |
| ExchangeRate-API | VND, TWD, AED, BND, KHR, MMK, LKR, BDT, PKR, NPR and ~130 more | today only |

A currency the ECB does not publish is priced at the day's rate, and the report
says so in its footnote rather than implying a historical rate.

## What was wrong

Both providers round to a fixed number of decimal places, not to significant
figures. A currency worth a small fraction of a Singapore dollar therefore came
back with almost no precision, and the error landed on exactly the currencies
that were asked for.

| Rate, 18 Sep 2026 | As published | Asked the other way and inverted | A real bill |
|---|---|---|---|
| IDR → SGD | 0.000072 (2 figures) | 0.0000717309 | 10,000,000 rupiah: **720.00 → 717.31**, out by SGD 2.69 |
| VND → SGD | 0.000049 (2 figures) | 0.0000490793 | 12,000,000 dong: **588.00 → 588.95**, out by SGD 0.95 |
| KRW → SGD | 0.00092 | 0.000921005 | 0.109% |
| JPY → SGD | 0.0081 | 0.00809717 | 0.035% |
| INR → SGD | 0.01333 | 0.0133337 | 0.028% |
| MYR → SGD | 0.3133 | 0.313303 | 0.001% |
| USD → SGD | 1.2784 | 1.278445 | 0.004% |

Below 0.1 the provider is now asked how many foreign units make one Singapore
dollar — 13,941.2 rupiah, six figures — and the answer is inverted. One extra
request per currency per day, then it is cached like any other rate.

## Priced end to end

Real bills through `rates.getRate` and the store's own rounding rule:

| | Amount | Rate | SGD | Source |
|---|---|---|---|---|
| Hotel, San Francisco | USD 240.00 | 1.2784 | 306.82 | ECB |
| Hotel, Kuala Lumpur | MYR 1,289.00 | 0.3133 | 403.84 | ECB |
| Hotel, Jakarta | IDR 10,500,000 | 0.0000717309 | 753.17 | ECB |
| Hotel, Ho Chi Minh City | VND 12,400,000 | 0.0000490793 | 608.58 | ExchangeRate-API |
| Hotel, Tokyo | JPY 148,500 | 0.00809717 | 1,202.43 | ECB |
| Hotel, Bangkok | THB 14,200.50 | 0.0383289 | 544.29 | ECB |
| Hotel, Manila | PHP 23,400.00 | 0.0203566 | 476.35 | ECB |
| Courtyard Pune, the real folio | INR 88,188.77 | 0.0133337 | 1,175.88 | ECB |

## What moved on the existing report

EXP-2026-0001 was rebuilt with the corrected rates. Nothing else changed.

| | Before | After |
|---|---|---|
| JW Marriott Mumbai | SGD 594.18 | SGD 594.23 |
| Courtyard Pune | SGD 1,182.60 | SGD 1,182.38 |
| Report total | SGD 1,776.78 | SGD 1,776.61 |

The one-cent gap the earlier note recorded on Pune, between the sum of the
rounded lines and the whole receipt converted at once, has gone: both are now
1,182.38.

Rates cached before this change keep the digits they were fetched with, so a
migration drops the provider rows once and lets them refetch. Manual rates are
left alone, and every rate already frozen on an expense line stays frozen, so
no report that has been submitted moves.

## Reading a receipt in these currencies

`detectCurrency` now recognises the symbols as well as the codes, tested in
`main/intake/document.test.js`: Rp 1.250.000 → IDR, 1.200.000 ₫ → VND,
฿4,500.00 → THB, ₱2,340.00 → PHP, ₩45,000 → KRW, ₹44,309.00 → INR,
NT$1,200 → TWD, HK$980.00 → HKD. A bare `$` still names nothing, because six
countries print it, and a bare `¥` is read as JPY although China prints it too.

Staff pick a currency by name in the claim screen and finance in the rates
page, from `main/intake/currencies.js` — 32 currencies with their names, served
by `GET /api/company`. It is a convenience, not a limit: any three-letter code
can still be typed, and the reader is not held to the list.
