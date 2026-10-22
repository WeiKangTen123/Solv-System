import { FIELD_DEFS, aiDiffers, aiValue, aiShown, flagsOn, sameValue } from './fields';
import { fmtDateRange } from '../../utils/format';

// The boxes for a receipt's details, two to a row. Beside each box: what the
// server noticed about that field (receipts/flags.js, by `field`), and, where
// the saved value no longer says what the reader read, "AI read: X" with a
// button to put the reader's value back.
//
// Props:
//   fields      keys of FIELD_DEFS, in order (PAGE_FIELDS, REVIEW_FIELDS).
//   form        the values typed (useReceiptForm's form).
//   onChange    fn(key, value).
//   expense     the receipt as saved: its flags and what the reader read.
//   disabled    every box read-only.
//   categories  the company's categories, for the category box.
//   currencies  [{ code, name }] offered for the currency box.
//   invalid     keys the server's last refusal named; their boxes are marked.
//   caseDates   optional { from, to } of the case, said in the "outside the
//               case's dates" flag.
//   idPrefix    prefix for the boxes' ids (`${idPrefix}-merchant`), so a flag
//               or a refusal elsewhere on the page can take focus to one.
//   columns     2 (default) or 1.
export default function ReceiptFields({ fields, form, onChange, expense, disabled, categories = [], currencies = [], invalid = [], caseDates, idPrefix = 'f', columns = 2 }) {
  const listId = `${idPrefix}-currency-options`;
  const flags = expense ? expense.flags : [];
  return (
    <div className="rcpt-fields" style={{ gridTemplateColumns: columns === 1 ? '1fr' : '1fr 1fr' }}>
      {/* Offered, not enforced: any three-letter code still works, because the
          rate providers cover far more currencies than anyone would list. */}
      <datalist id={listId}>
        {currencies.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </datalist>
      {fields.map(k => {
        const def = FIELD_DEFS[k];
        const id = `${idPrefix}-${k}`;
        const mine = flagsOn(flags, k);
        const red = mine.some(f => f.level === 'red') || invalid.includes(k);
        const notes = mine.length ? `${id}-flags` : undefined;
        const read = aiDiffers(expense, k) ? aiValue(expense, k) : undefined;
        const value = form[k] ?? '';
        const box = def.type === 'select' ? (
          <select id={id} className="form-input" value={value} disabled={disabled} aria-invalid={red || undefined} aria-describedby={notes}
                  onChange={e => onChange(k, e.target.value)}>
            <option value="">Category…</option>
            {/* One the list no longer has (renamed since) still shows as itself. */}
            {value && !categories.includes(value) && <option value={value}>{value}</option>}
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <input id={id} className="form-input" type={def.type} step={def.type === 'number' ? '0.01' : undefined} value={value}
                 disabled={disabled} aria-invalid={red || undefined} aria-describedby={notes}
                 list={k === 'currency' ? listId : undefined} placeholder={def.placeholder || ''}
                 onChange={e => onChange(k, k === 'currency' ? e.target.value.toUpperCase().slice(0, 3) : e.target.value)} />
        );
        return (
          <div className={`form-group rcpt-field${red ? ' is-invalid' : ''}`} key={k} style={{ gridColumn: def.wide || columns === 1 ? '1 / -1' : 'auto' }}>
            <label className="form-label" htmlFor={id}>{def.label}</label>
            {box}
            {mine.length > 0 && (
              <ul className="rcpt-field-flags" id={notes}>
                {mine.map((f, i) => (
                  <li key={`${f.code}-${i}`} className={`rcpt-field-flag is-${f.level === 'red' ? 'red' : 'yellow'}`}>
                    <span className="rcpt-field-flag-mark" aria-hidden="true">{f.level === 'red' ? '!' : '?'}</span>
                    <span>
                      <span className="sr-only">{f.level === 'red' ? 'Must fix: ' : 'Have a look: '}</span>
                      {f.code === 'outside-case' && caseDates && (caseDates.from || caseDates.to)
                        ? `${f.text.replace(/\.$/, '')} (${fmtDateRange(caseDates.from, caseDates.to)}).`
                        : f.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {read !== undefined && (
              <div className="rcpt-ai" title="What the reader first read off the receipt">
                AI read: <span className="rcpt-ai-value">{aiShown(k, read)}</span>
                {!disabled && !sameValue(k, read, value) && (
                  <button type="button" className="rcpt-ai-use" onClick={() => onChange(k, k === 'total' || k === 'tax' ? String(read) : read)}
                          aria-label={`Use what the reader read for ${def.label.toLowerCase()}: ${aiShown(k, read)}`}>use</button>
                )}
              </div>
            )}
            {k === 'currency' && (
              <div className="rcpt-hint">{currencies.find(c => c.code === value)?.name || 'Pick one, or type any three-letter code'}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
