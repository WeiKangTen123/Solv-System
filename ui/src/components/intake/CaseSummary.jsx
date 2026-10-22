import { fmtMoney } from '../../utils/format';
import { unpricedText } from '../../utils/caseTotals';
import { hasAmount } from './intake-logic';

// "So far": how many receipts, what they come to in the company's currency,
// by category and by the currencies they were paid in. A total that leaves
// receipts out says which and why, as the case page does (utils/caseTotals.js):
// a receipt still being read has no amount yet, and is said as such rather
// than as one "without an amount".
//
// Props:
//   intake  the /reports/:id/intake answer (its totals and files).
//   base    the company's currency.
export default function CaseSummary({ intake, base }) {
  const t = intake && intake.totals;
  if (!t || !t.expenseCount) return null;
  const all = (intake.files || []).flatMap(f => f.expenses || []);
  const reading = all.filter(e => e.status === 'reading').length;
  // The reader's rows have no lines yet, so the server counts them under
  // noAmount; they are taken out of it and said apart.
  const rest = unpricedText({ ...t, noAmount: t.noAmount === undefined || t.noAmount === null ? t.noAmount : Math.max(0, t.noAmount - reading) });
  const missing = [reading ? `${reading} still being read` : '', rest].filter(Boolean).join(', ');

  const cats = Object.entries(t.byCategory || {}).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  const byCur = new Map();
  for (const e of all) {
    if (!e.currency || !hasAmount(e)) continue;
    const c = byCur.get(e.currency) || { n: 0, sum: 0 };
    byCur.set(e.currency, { n: c.n + 1, sum: c.sum + Number(e.total) });
  }
  const curs = [...byCur.entries()].sort((a, b) => b[1].n - a[1].n);

  return (
    <section className="card in-summary" aria-labelledby="in-summary-head">
      <h2 id="in-summary-head" className="section-label">So far</h2>
      <div className="in-sum-head">
        <span>{t.expenseCount} receipt{t.expenseCount === 1 ? '' : 's'}</span>
        <span className="in-sum-total">{fmtMoney(t.totalBase, base)}{missing ? ' *' : ''}</span>
      </div>
      {missing && <div className="in-sum-note">* Not counted yet: {missing}.</div>}
      {cats.length > 0 && (
        <dl className="in-sum-list">
          {cats.map(([name, n]) => (
            <div key={name} className="in-sum-item"><dt>{name}</dt><dd>{fmtMoney(n, base)}</dd></div>
          ))}
        </dl>
      )}
      {curs.length > 0 && (
        <>
          <div className="in-sum-sub">Paid in</div>
          <dl className="in-sum-list">
            {curs.map(([cur, c]) => (
              <div key={cur} className="in-sum-item"><dt>{cur} <span className="ui-count">×{c.n}</span></dt><dd>{fmtMoney(c.sum, cur)}</dd></div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
