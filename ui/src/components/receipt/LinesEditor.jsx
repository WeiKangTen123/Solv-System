import { fmtMoney } from '../../utils/format';
import { cents } from './fields';

// A receipt's split into claim lines: one per category on the claim, adding
// up to the total to the cent before the receipt can be checked.
//
// Props:
//   lines          [{ category, description, amount, onBehalfOf }] as typed.
//   currency       the receipt's currency, for the sums.
//   total          the receipt's total as typed.
//   categories     the company's categories.
//   disabled       read-only.
//   onLine         fn(index, key, value): one line's box changed.
//   onEdit         fn(fn(lines) => lines): lines added or removed.
//   collapseSingle a receipt with one line (or none) shows a summary and a
//                  Split button instead of the editor: its category is then a
//                  field of the receipt (the review page). Without it every
//                  line is always a row (the receipt's own page).
//   category       the receipt's category box, which the first line takes
//                  when a one-line receipt is split.
//   flags          the receipt's flags about its lines (field 'lines').
//   invalid        the last refusal was about the lines.
//   card           draw as a card of its own (default) or as a section.
export default function LinesEditor({ lines, currency, total, categories = [], disabled, onLine, onEdit, collapseSingle = false, category = '', flags = [], invalid = false, card = true }) {
  const totalCents = cents(total);
  const linesCents = lines.reduce((s, l) => s + cents(l.amount), 0);
  const reconciled = lines.length > 0 && totalCents === linesCents;
  const blank = amount => ({ category: '', description: '', amount, onBehalfOf: '' });
  const rest = () => Math.max(0, (totalCents - linesCents) / 100).toFixed(2);
  const sum = (
    <span className={`rcpt-lines-sum ${reconciled ? 'is-ok' : 'is-off'}`}>
      lines {fmtMoney(linesCents / 100, currency)} {reconciled ? '✓' : `≠ total ${fmtMoney(totalCents / 100, currency)}`}
    </span>
  );
  const flagRows = flags.length > 0 && (
    <ul className="rcpt-field-flags">
      {flags.map((f, i) => (
        <li key={`${f.code}-${i}`} className={`rcpt-field-flag is-${f.level === 'red' ? 'red' : 'yellow'}`}>
          <span className="rcpt-field-flag-mark" aria-hidden="true">{f.level === 'red' ? '!' : '?'}</span>
          <span><span className="sr-only">{f.level === 'red' ? 'Must fix: ' : 'Have a look: '}</span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
  const titleClass = card ? 'card-title' : 'rcpt-section-title';

  if (collapseSingle && lines.length <= 1) {
    // One line is the receipt: its amount follows the total and its category
    // is the category box above, so there is nothing here to type. Split
    // makes two, the first carrying what is typed above.
    const split = () => onEdit(ls => (ls.length
      ? [{ ...ls[0], category: category || ls[0].category }, blank(rest())]
      : [{ category, description: '', amount: Number(total) > 0 ? Number(total).toFixed(2) : '', onBehalfOf: '' }, blank('')]));
    return (
      <div className={`${card ? 'card ' : ''}rcpt-lines is-collapsed${invalid ? ' is-invalid' : ''}`}>
        <div className="rcpt-lines-head">
          <div className={titleClass}>Lines ({lines.length})</div>
          <button type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={split}
                  title="Split it across categories: a hotel bill's room, meals and laundry" aria-label="Split into several lines">+ Split</button>
        </div>
        <div className="rcpt-lines-note">
          {lines.length ? <>One line for the whole receipt. {sum}</> : 'No line yet. One is made from the total when you save.'}
        </div>
        {flagRows}
      </div>
    );
  }

  return (
    <div className={`${card ? 'card ' : ''}rcpt-lines${invalid ? ' is-invalid' : ''}`}>
      <div className={titleClass}>Lines{collapseSingle ? ` (${lines.length})` : ''}</div>
      <div className={card ? 'card-subtitle' : 'rcpt-lines-note'}>One line per category on the claim. They must add up to the total{currency ? ` in ${currency}` : ''}.</div>
      {flagRows}
      {lines.map((l, i) => (
        <div key={i} className="expense-line">
          <select className="form-input" value={l.category} disabled={disabled} onChange={e => onLine(i, 'category', e.target.value)} aria-label={`Line ${i + 1} category`}>
            <option value="">Category…</option>
            {l.category && !categories.includes(l.category) && <option value={l.category}>{l.category}</option>}
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className="form-input" value={l.description} placeholder="Rooms, 3 nights" disabled={disabled} onChange={e => onLine(i, 'description', e.target.value)} aria-label={`Line ${i + 1} description`} />
          <input className="form-input" type="number" step="0.01" value={l.amount} disabled={disabled} onChange={e => onLine(i, 'amount', e.target.value)} style={{ textAlign: 'right' }} aria-label={`Line ${i + 1} amount`} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => onEdit(ls => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`} title="Remove line">✕</button>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={!!l.onBehalfOf} disabled={disabled} onChange={e => onLine(i, 'onBehalfOf', e.target.checked ? (l.onBehalfOf || ' ') : '')} /> paid on behalf of
            </label>
            {/* ' ' marks "ticked, no name yet". The value shown used to be trimmed,
                which ate each space as it was typed: "Jane Tan" became "JaneTan". */}
            {!!l.onBehalfOf && <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, maxWidth: 220 }} value={l.onBehalfOf === ' ' ? '' : l.onBehalfOf} disabled={disabled} placeholder="Colleague's name" aria-label={`Line ${i + 1} paid on behalf of`} onChange={e => onLine(i, 'onBehalfOf', e.target.value || ' ')} />}
          </div>
        </div>
      ))}
      <div className="rcpt-lines-foot">
        <button type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={() => onEdit(ls => [...ls, blank(rest())])}>+ Line</button>
        {sum}
      </div>
    </div>
  );
}
