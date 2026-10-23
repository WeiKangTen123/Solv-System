import { fmtDateRange, fmtDay, fmtMoney } from '../../utils/format';
import { ALLOWANCE_LABEL, allowanceOf, allowanceWords, countryName } from '../../utils/allowances';

// Where the receipt would be, for a claim that has none: a per diem or a
// mileage claim (main/reports/allowances.js). It says what the claim is and
// how it was worked out, in place of a picture there is nothing to load.
// Such a claim went in already checked, from the company's own rates.
//
// Props:
//   expense    the per diem or mileage expense.
//   base       the company's currency.
//   caseDates  optional { from, to }: a per diem is for the trip's days.
//   compact    the phone's version, beside the fields rather than over them.
const MARK = { per_diem: '◑', mileage: '⇢' };

export default function AllowanceCard({ expense: e, base, caseDates, compact = false }) {
  const kind = allowanceOf(e);
  if (!kind) return null;
  const label = ALLOWANCE_LABEL[kind];
  const words = allowanceWords(e);
  const other = e.currency && base && e.currency !== base;
  const rows = kind === 'per_diem'
    ? [
      ['Country', countryName(e.country) || e.country || '—'],
      ['Days', caseDates && caseDates.from && caseDates.to ? fmtDateRange(caseDates.from, caseDates.to) : fmtDay(e.receiptDate, { withYear: true })],
      ['Worked out', words || '—'],
    ]
    : [
      ['Date', fmtDay(e.receiptDate, { withYear: true })],
      ['Worked out', words || '—'],
      ...(e.purpose ? [['Purpose', e.purpose]] : []),
    ];

  return (
    <section className={`al-card${compact ? ' is-compact' : ''}`} aria-label={`${label}: no receipt`}>
      <div className="al-card-head">
        <span className="al-card-mark" aria-hidden="true">{MARK[kind]}</span>
        <div>
          <div className="al-card-kind">{label}</div>
          <div className="al-card-no">No receipt: worked out from your company&rsquo;s {kind === 'per_diem' ? 'per-diem rate' : 'rate per km'}.</div>
        </div>
      </div>
      <dl className="al-card-facts">
        {rows.map(([k, v]) => (
          <div key={k} className="al-card-fact"><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        <div className="al-card-fact is-total">
          <dt>Amount</dt>
          <dd className="cs-num">
            {fmtMoney(e.total, e.currency)}
            {other && <span className="al-card-base">{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : `${base} rate to come`}</span>}
          </dd>
        </div>
      </dl>
      {!compact && (
        <p className="al-card-foot">
          Added already checked: there is no paper to check it against. To change it, add it again from the case page
          {kind === 'per_diem' ? ' (a new per diem replaces this one)' : ' and delete this one'}.
        </p>
      )}
    </section>
  );
}
