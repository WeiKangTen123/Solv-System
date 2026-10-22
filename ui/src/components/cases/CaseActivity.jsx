import { EmptyState } from '../ui';
import { fmtRate } from '../../utils/format';
import { formatDateTime } from '../../utils/formatDate';
import { fxSourceName } from '../../utils/fxSources';

// What happened to the case, newest first, and the exchange rates its
// receipts were priced at: the two things a finance reader asks after.
//
// Props:
//   report  the case (GET /reports/:id): `events`, and `expenses` with lines.
//   base    the company's currency.
//   tz      the person's timezone, for the times.

// The words the store records (store/reports.js addEvent), said as a person
// would; anything newer shows as it was recorded.
const SAID = { created: 'Created', opened: 'Created from a draft', claimed: 'Marked claimed', reopened: 'Reopened', edited: 'Edited', checked: 'Checked', posted: 'Posted to Xero' };
const said = a => SAID[a] || (a ? a[0].toUpperCase() + a.slice(1) : '');

export default function CaseActivity({ report, base, tz }) {
  const events = [...(report.events || [])].reverse();
  // One row per distinct rate, not per line: twelve taxis in rupees on one
  // day are one rate.
  const rates = [...new Map((report.expenses || []).flatMap(e => e.lines || [])
    .filter(l => l.fxRate && l.fxSource !== 'base')
    .map(l => [`${l.currency}|${l.fxRate}|${l.fxRateDate}|${l.fxSource}`, l])).values()];

  return (
    <div className="cs-activity">
      <section className="card">
        <h2 className="section-label">History</h2>
        {!events.length ? <EmptyState compact title="Nothing recorded yet" /> : (
          <ol className="cs-events">
            {events.map(ev => (
              <li key={ev.id} className="cs-event">
                <div className="cs-event-what">
                  <strong>{said(ev.action)}</strong>{ev.note ? <> — {ev.note}</> : null}
                  {ev.actorName && <span className="cs-sub"> · {ev.actorName}</span>}
                </div>
                <time className="cs-event-when" dateTime={ev.at}>{formatDateTime(ev.at, tz)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <h2 className="section-label">Rates used</h2>
        {!rates.length ? (
          <div className="cs-sub">Every receipt so far is in {base}, or not priced yet.</div>
        ) : (
          <ul className="cs-rates">
            {rates.map(l => (
              <li key={`${l.currency}${l.fxRate}${l.fxRateDate}${l.fxSource}`}>
                {l.currency} → {base} <strong className="cs-num">{fmtRate(l.fxRate)}</strong>{' '}
                <span className="cs-sub">· {l.fxSource === 'manual' ? 'entered' : fxSourceName(l.fxSource)} {l.fxRateDate}{l.fxOverrideBy ? ` by ${l.fxOverrideBy}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
