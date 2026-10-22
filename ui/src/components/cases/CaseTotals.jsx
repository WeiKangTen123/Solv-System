import { fmtMoney } from '../../utils/format';
import { unpricedCount, unpricedText } from '../../utils/caseTotals';

// What the case comes to: the total in the company's currency, the advance
// taken off it, what is left to pay, and the total by category. A total that
// leaves receipts out says which and why (utils/caseTotals.js), and receipts
// still to check are said too: the figure can still move until they are.
//
// Props:
//   report  the case (GET /reports/:id): `totals`, `advances`.
//   facts   caseFacts(report), for the receipts still being read.
//   base    the company's currency.
export default function CaseTotals({ report, facts, base }) {
  const t = report.totals || {};
  const advances = Number(report.advances) || 0;
  const cats = Object.entries(t.byCategory || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  // The ones being read are said as such, not as "without an amount".
  const reading = facts ? facts.reading : 0;
  const rest = unpricedText({ ...t, noAmount: t.noAmount === undefined || t.noAmount === null ? t.noAmount : Math.max(0, t.noAmount - reading) });
  const missing = [reading ? `${reading} still being read` : '', rest].filter(Boolean).join(', ');
  const short = unpricedCount(t) > 0;
  const unchecked = Math.max(0, (Number(t.unreviewed) || 0) - reading);

  return (
    <section className="card cs-totals" aria-labelledby="cs-totals-head">
      <div className="cs-totals-head">
        <h2 id="cs-totals-head" className="section-label">Total {base}</h2>
        <span className="cs-totals-figure">{fmtMoney(t.totalBase, '')}{short ? ' *' : ''}</span>
      </div>
      {advances > 0 && (
        <dl className="cs-totals-list">
          <div className="cs-totals-item"><dt>Advance</dt><dd>− {fmtMoney(advances, '')}</dd></div>
          <div className="cs-totals-item is-strong"><dt>To pay</dt><dd>{fmtMoney(t.reimbursement, '')}</dd></div>
        </dl>
      )}
      {cats.length > 0 && (
        <>
          <div className="cs-totals-sub">By category</div>
          <dl className="cs-totals-list">
            {cats.map(([c, v]) => <div key={c} className="cs-totals-item"><dt>{c}</dt><dd>{fmtMoney(v, '')}</dd></div>)}
          </dl>
        </>
      )}
      {(short || unchecked > 0) && (
        <div className="cs-totals-note">
          {short && <div>* Not in the total yet: {missing}.</div>}
          {unchecked > 0 && <div>{unchecked} not checked yet.</div>}
        </div>
      )}
    </section>
  );
}
