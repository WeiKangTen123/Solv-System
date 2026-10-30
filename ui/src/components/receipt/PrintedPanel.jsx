import { useEffect, useState } from 'react';
import { fmtMoney } from '../../utils/format';
import { Menu } from '../ui';
import Modal from '../Modal';
import {
  KINDS, KIND_WORD, KIND_A, num, addsUp, rateGroups, rateText, rowWords, blankRow, isBlank, insertRow, removeRow, splitRow,
  insertAt, mainCategory, matchRead, differsFromRead, readBack, arrange, dependents, claimedParts,
} from '../../utils/printed';

// A receipt as printed: its items, then what the receipt adds or takes off
// (service charge, discounts, taxes with their names and rates, rounding), in
// the order it prints them, and the total paid. It stands in for the lines
// editor and the Total and Tax boxes whenever the receipt keeps a record
// (expense.printed); the claim lines are made from it by the server, and
// shown at the foot as "Claimed as".
//
// Figures are typed over in place and nothing is worked out from another:
// changing a rate never changes an amount. Where the rows do not come to the
// total (within the currency's step, utils/printed.js) one quiet line says
// so and offers the difference as a row; it does not stop the check.
//
// Two ways to draw it. Full: a table of boxes, for the receipt's own page.
// Compact (the case review's pane, a phone): one line per row, read-only,
// that opens a sheet with the row's boxes.
//
// Props:
//   printed           the record as typed (useReceiptForm's printed).
//   onChange          fn(fn(draft) => draft) (useReceiptForm's editPrinted).
//   read              what the reader read (expense.aiRead.printed), or null.
//   lines             the claim lines the server made (expense.lines).
//   currency          the receipt's currency.
//   categories        the company's categories.
//   fallbackCategory  the receipt's category, for a new row when no item has one.
//   disabled          read-only: the details are locked.
//   compact           the line-per-row variant.
//   card              its own card (default) or a section of a pane.
//   flags             the receipt's flags about its total, tax and lines.
//   invalid           the last refusal was about the total or the lines.
//   changed           the rows differ from what is saved, so "Claimed as" is
//                     the last save's.
//   idPrefix          for the boxes' ids.
export default function PrintedPanel({
  printed, onChange, read = null, lines = [], currency = '', categories = [], fallbackCategory = '',
  disabled = false, compact = false, card = true, flags = [], invalid = false, changed = false, idPrefix = 'pp',
}) {
  const [open, setOpen] = useState(() => new Set());        // folds shown row by row
  const [sheet, setSheet] = useState(null);                  // { i, fresh } in compact
  const rows = printed.rows;
  const cur = String(currency || '').toUpperCase();
  const money = n => fmtMoney(n, cur).replace(/^[A-Z]{3} /, '').replace(/^-/, '−');
  const groups = rateGroups(printed);
  const taxCol = groups.length >= 2;
  const lay = arrange(rows);
  const reads = matchRead(rows, read && read.rows);
  // The gap is said once the typing has stopped (half a second), so it is
  // not announced at every key; it goes as soon as the rows add up.
  const settled = useSettled(printed, 500);
  const live = addsUp(printed, cur);
  const sum = live.ok ? live : addsUp(settled, cur);
  const category = mainCategory(rows, fallbackCategory);

  // Each row named by its kind and its place among them, for the boxes'
  // labels: "Item 2 amount", "Tax 1 rate".
  const names = [];
  const count = {};
  rows.forEach((r, i) => { count[r.kind] = (count[r.kind] || 0) + 1; names[i] = `${KIND_WORD[r.kind] || 'Row'} ${count[r.kind]}`; });

  const edit = fn => { if (!disabled) onChange(fn); };
  const setRow = (i, k, v) => edit(p => ({
    ...p,
    // A worked-out tax typed over is the person's figure, not a worked one.
    rows: p.rows.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === 'amount' && r.worked ? { worked: false } : {}) } : r)),
  }));
  const setRows = fn => edit(p => ({ ...p, rows: fn(p.rows) }));
  const setTop = (k, v) => edit(p => ({ ...p, [k]: v }));
  function changeKind(i, kind) {
    // Nothing sits under a tax or a rounding, so what was under this row is
    // then for the whole receipt.
    const holds = kind === 'item' || kind === 'charge' || kind === 'discount';
    setRows(rs => rs.map((r, j) => {
      if (j !== i) return !holds && r.on === i ? { ...r, on: null } : r;
      const next = { ...r, kind };
      if (kind !== 'tax') { next.included = false; next.worked = false; }
      if (kind === 'rounding') next.rate = null;
      if (kind === 'item' && !next.category) next.category = category;
      return next;
    }));
  }
  function add(kind, extra = {}) {
    const at = insertAt(rows, kind);
    const row = blankRow(kind, { category: kind === 'item' || kind === 'charge' || kind === 'discount' ? category : null, ...extra });
    setRows(rs => insertRow(rs, at, row));
    if (compact) setSheet({ i: at, fresh: true });
    else window.setTimeout(() => document.getElementById(`${idPrefix}-label-${at}`)?.focus(), 0);
  }
  const remove = i => setRows(rs => removeRow(rs, i));
  // From the row's menu, whose button goes with the row: focus moves to the
  // name of the row that took its place, or the one before it.
  function removeFromMenu(i) {
    const left = rows.length - 1 - dependents(rows, i).length;
    remove(i);
    window.setTimeout(() => {
      const to = document.getElementById(`${idPrefix}-label-${Math.min(i, left - 1)}`) || document.getElementById(`${idPrefix}-total`);
      to?.focus();
    }, 0);
  }
  const toggleFold = key => setOpen(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // A row added from the sheet and left blank is taken back out.
  function closeSheet() {
    if (sheet && sheet.fresh && rows[sheet.i] && isBlank(rows[sheet.i])) remove(sheet.i);
    setSheet(null);
  }

  const kids = i => lay.subs.get(i) || [];
  const onWhat = r => (Number.isInteger(r.on) && rows[r.on] ? `on ${String(rows[r.on].label || '').trim() || names[r.on].toLowerCase()}` : '');
  const gapText = !sum.ok && `These come to ${money(sum.sum)}, ${money(Math.abs(sum.gap))} ${sum.gap > 0 ? 'under' : 'over'} the total.`;
  // The gap as a row: under the total, an item nobody itemised; over it, a
  // discount of the same.
  const addGap = () => {
    if (live.ok) return;
    if (live.gap > 0) add('item', { label: 'Not itemised', amount: live.gap.toFixed(2), qty: null });
    else add('discount', { label: 'Not itemised', amount: live.gap.toFixed(2) });
  };
  const readTotal = read && num(read.total) !== null && num(read.total) !== num(printed.total) ? num(read.total) : null;
  const readSub = read && num(read.subtotal) !== null && num(read.subtotal) !== num(printed.subtotal) ? num(read.subtotal) : null;
  const claimed = claimedParts(lines);
  const titleClass = card ? 'card-title' : 'rcpt-section-title';

  const aiLine = (i, label) => {
    const r = rows[i];
    const was = reads[i];
    if (!was || !differsFromRead(r, was)) return null;
    const words = rowWords(was, money);
    return (
      <div className="rcpt-ai pp-ai" title="What the reader first read off the receipt">
        AI read: <span className="rcpt-ai-value">{words}</span>
        {!disabled && (
          <button type="button" className="rcpt-ai-use" onClick={() => setRows(rs => rs.map((x, j) => (j === i ? readBack(x, was) : x)))}
                  aria-label={`Use what the reader read for ${label}: ${words}`}>use</button>
        )}
      </div>
    );
  };

  const flagRows = flags.length > 0 && (
    <ul className="rcpt-field-flags pp-flags">
      {flags.map((f, i) => (
        <li key={`${f.code}-${i}`} className={`rcpt-field-flag is-${f.level === 'red' ? 'red' : 'yellow'}`}>
          <span className="rcpt-field-flag-mark" aria-hidden="true">{f.level === 'red' ? '!' : '?'}</span>
          <span><span className="sr-only">{f.level === 'red' ? 'Must fix: ' : 'Have a look: '}</span>{f.text}</span>
        </li>
      ))}
    </ul>
  );

  // The line about the rows not adding up, said politely to a screen reader
  // once the typing has stopped.
  const gap = (
    <div className="pp-gap" aria-live="polite">
      {gapText && (
        <>
          <span>{gapText}</span>
          {!disabled && <button type="button" className="pp-link" onClick={addGap}>{sum.gap > 0 ? '+ add' : '+ take off'} {money(Math.abs(sum.gap))}</button>}
        </>
      )}
    </div>
  );

  const claimedLine = (
    <div className="pp-claimed">
      <span className="pp-claimed-word">Claimed as:</span>{' '}
      {claimed.length ? claimed.map((c, k) => (
        <span key={k} className="pp-claimed-part">{k > 0 && <span aria-hidden="true"> · </span>}{c.who ? `${c.who} ` : ''}{c.category} {money(c.amount)}</span>
      )) : <span>nothing yet</span>}
      {changed && <span className="pp-stale"> (as last saved; Save to see the new split)</span>}
    </div>
  );

  const head = (
    <div className="pp-head">
      <div className={titleClass}>As printed</div>
      {cur && <span className="pp-cur">{cur}</span>}
    </div>
  );
  const sub = <div className={card ? 'card-subtitle' : 'rcpt-lines-note'}>Every row as the receipt prints it. The claim lines are made from these.</div>;

  // ── Compact: a line per row, a sheet to change one ──
  if (compact) {
    const line = (i, depth = 0) => {
      const r = rows[i];
      const bits = [];
      if (r.kind === 'item') {
        if (num(r.qty) !== null && num(r.qty) !== 1) bits.push(`${+num(r.qty).toFixed(3)} ×`);
        if (!depth && r.category) bits.push(r.category);
        if (String(r.onBehalfOf || '').trim()) bits.push(`for ${String(r.onBehalfOf).trim()}`);
        if (taxCol && num(r.taxRate) !== null) bits.push(`tax ${rateText(r.taxRate)}`);
      } else {
        bits.push(r.kind === 'tax' ? (r.included ? 'Tax, included' : 'Tax, added') : (KIND_WORD[r.kind] || 'Row'));
        if (depth) bits.push(onWhat(r));
        if (r.worked) bits.push('worked out');
      }
      if (reads[i] && differsFromRead(r, reads[i])) bits.push('changed from what was read');
      const label = String(r.label || '').trim() || `New ${(KIND_WORD[r.kind] || 'row').toLowerCase()}`;
      const body = (
        <>
          <span className="pp-line-main">
            <span className="pp-line-label">{r.kind === 'tax' && r.included ? 'incl. ' : ''}{label}{r.kind !== 'item' && num(r.rate) !== null ? ` ${rateText(r.rate)}` : ''}</span>
            {bits.length > 0 && <span className="pp-line-sub">{bits.filter(Boolean).join(' · ')}</span>}
          </span>
          <span className="pp-line-amt">{money(num(r.amount) || 0)}</span>
        </>
      );
      return (
        <li key={i} className={`pp-line-item${depth ? ' is-sub' : ''}`}>
          {disabled ? <div className="pp-line">{body}</div> : (
            <button type="button" className="pp-line" onClick={() => setSheet({ i, fresh: false })} aria-label={`${label}, ${money(num(r.amount) || 0)}. Change it`}>{body}</button>
          )}
          {kids(i).length > 0 && <ul className="pp-lines">{kids(i).map(j => line(j, depth + 1))}</ul>}
        </li>
      );
    };
    const fold = f => {
      const isOpen = open.has(f.fold);
      const total = f.members.reduce((s, j) => s + (num(rows[j].amount) || 0), 0);
      const id = `${idPrefix}-fold-${f.fold.replace(/[^a-z0-9]/gi, '')}`;
      return (
        <li key={f.fold} className="pp-line-item">
          <button type="button" className="pp-line" aria-expanded={isOpen} aria-controls={isOpen ? id : undefined} onClick={() => toggleFold(f.fold)}>
            <span className="pp-line-main">
              <span className="pp-line-label">{f.included ? 'incl. ' : ''}{String(f.label || '').trim() || 'Tax'}{num(f.rate) !== null ? ` ${rateText(f.rate)}` : ''}</span>
              <span className="pp-line-sub">on {f.members.length} charges · {isOpen ? 'hide' : 'show each'}</span>
            </span>
            <span className="pp-line-amt">{money(total)}</span>
          </button>
          {isOpen && <ul className="pp-lines" id={id}>{f.members.map(j => line(j, 1))}</ul>}
        </li>
      );
    };
    const s = sheet && rows[sheet.i] ? sheet : null;
    return (
      <div className={`${card ? 'card ' : ''}pp is-compact${invalid ? ' is-invalid' : ''}`}>
        {head}
        <ul className="pp-lines" aria-label="Items">{lay.items.map(e => line(e.i))}</ul>
        {!disabled && <div className="pp-adds"><button type="button" className="btn btn-ghost btn-sm" onClick={() => add('item')}>+ item</button></div>}
        <div className="pp-foot">
          {printed.subtotal !== null && (
            <TopBox id={`${idPrefix}-subtotal`} label="Subtotal" value={printed.subtotal} disabled={disabled} onChange={v => setTop('subtotal', v)}
                    read={readSub} money={money} />
          )}
          <ul className="pp-lines" aria-label="Charges, discounts, taxes and rounding">
            {lay.foot.map(e => (e.fold ? fold(e) : line(e.i)))}
          </ul>
          <TopBox id={`${idPrefix}-total`} label="Total paid" value={printed.total} disabled={disabled} strong invalid={invalid}
                  onChange={v => setTop('total', v)} read={readTotal} money={money} />
          {lay.incl.length > 0 && <ul className="pp-lines is-incl" aria-label="Included in the prices">{lay.incl.map(e => (e.fold ? fold(e) : line(e.i)))}</ul>}
        </div>
        {!disabled && <Adds add={add} subtotal={printed.subtotal === null} onSubtotal={() => setTop('subtotal', '')} />}
        {gap}
        {flagRows}
        {claimedLine}
        {s && (
          <RowSheet i={s.i} rows={rows} name={names[s.i]} read={reads[s.i]} money={money} categories={categories} groups={taxCol ? groups : null}
                    onWhat={onWhat(rows[s.i])} idPrefix={idPrefix} setRow={setRow} changeKind={changeKind} onUseRead={was => setRows(rs => rs.map((x, j) => (j === s.i ? readBack(x, was) : x)))}
                    onRemove={() => { remove(s.i); setSheet(null); }} onClose={closeSheet} />
        )}
      </div>
    );
  }

  // ── Full: boxes in place ──
  const rateBox = (i, label) => (
    <span className="pp-rate">
      <input id={`${idPrefix}-rate-${i}`} className="form-input pp-in" type="number" step="any" value={rows[i].rate ?? ''} disabled={disabled}
             onChange={e => setRow(i, 'rate', e.target.value)} aria-label={`${label} rate, percent`} />
      <span className="pp-pct" aria-hidden="true">%</span>
    </span>
  );
  const amountBox = (i, label) => (
    <input id={`${idPrefix}-amount-${i}`} className="form-input pp-in pp-amt" type="number" step="any" value={rows[i].amount ?? ''} disabled={disabled}
           onChange={e => setRow(i, 'amount', e.target.value)} aria-label={`${label} amount`} />
  );
  const labelBox = (i, label, placeholder) => (
    <input id={`${idPrefix}-label-${i}`} className="form-input pp-in" value={rows[i].label ?? ''} disabled={disabled} placeholder={placeholder} title={rows[i].label || undefined}
           onChange={e => setRow(i, 'label', e.target.value)} aria-label={`${label} name`} />
  );
  const menu = (i, label) => {
    if (disabled) return <span />;
    const r = rows[i];
    const under = dependents(rows, i).length;
    const paid = !!r.onBehalfOf;
    const items = [
      ...KINDS.filter(k => k !== r.kind).map(k => ({ label: `Make it ${KIND_A[k]}`, onSelect: () => changeKind(i, k) })),
      ...(r.kind === 'tax' ? [{ label: r.included ? 'Added to the total' : 'Included in the prices', hint: r.included ? 'Now: already in the prices' : 'Now: added on top', onSelect: () => setRow(i, 'included', !r.included) }] : []),
      ...(r.kind === 'item' && !Number.isInteger(r.on) ? [{
        label: paid ? 'Paid by me' : 'Paid for someone else',
        onSelect: () => {
          setRow(i, 'onBehalfOf', paid ? '' : ' ');
          if (!paid) window.setTimeout(() => document.getElementById(`${idPrefix}-paid-${i}`)?.focus(), 0);
        },
      }] : []),
      { label: 'Split in two', onSelect: () => setRows(rs => splitRow(rs, i)) },
      { label: under ? `Remove, with the ${under} under it` : 'Remove', danger: true, onSelect: () => removeFromMenu(i) },
    ];
    return <Menu label={<><span aria-hidden="true">⋯</span><span className="sr-only">More for {label}</span></>} items={items} align="end" className="btn btn-ghost btn-sm pp-menu-btn" />;
  };

  const itemRow = i => {
    const r = rows[i];
    const label = names[i].toLowerCase();
    const paid = !!r.onBehalfOf;
    return (
      <div key={i} className={`pp-row is-item${paid ? ' has-paid' : ''}`}>
        {labelBox(i, names[i], 'What was bought')}
        <input className="form-input pp-in pp-num" type="number" step="any" min="0" value={r.qty ?? ''} disabled={disabled}
               onChange={e => setRow(i, 'qty', e.target.value)} aria-label={`${names[i]} quantity`} />
        {amountBox(i, names[i])}
        <select className="form-input pp-in" value={r.category || ''} disabled={disabled} onChange={e => setRow(i, 'category', e.target.value)} aria-label={`${names[i]} category`}>
          <option value="">Category…</option>
          {r.category && !categories.includes(r.category) && <option value={r.category}>{r.category}</option>}
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="pp-paid">
          <span className="pp-paid-word">for</span>
          {/* ' ' is "someone else, no name yet", as on the lines editor. */}
          <input id={`${idPrefix}-paid-${i}`} className="form-input pp-in" value={r.onBehalfOf === ' ' ? '' : (r.onBehalfOf || '')} disabled={disabled}
                 placeholder="" onChange={e => setRow(i, 'onBehalfOf', e.target.value || (paid ? ' ' : ''))} aria-label={`${names[i]} paid for (empty when it was yours)`} />
        </label>
        {taxCol && (
          <select className="form-input pp-in pp-taxsel" value={num(r.taxRate) ?? ''} disabled={disabled} title={groups.map(g => `${rateText(g.rate)}: ${g.labels.join(' + ')}`).join('\n')}
                  onChange={e => setRow(i, 'taxRate', e.target.value === '' ? null : e.target.value)} aria-label={`${names[i]} tax`}>
            {/* The receipt's rates in the order it prints them, then none. */}
            {groups.map(g => <option key={g.rate} value={g.rate}>{rateText(g.rate)}</option>)}
            {num(r.taxRate) !== null && !groups.some(g => g.rate === num(r.taxRate)) && <option value={num(r.taxRate)}>{rateText(r.taxRate)}</option>}
            <option value="">–</option>
          </select>
        )}
        {menu(i, label)}
        {aiLine(i, label)}
      </div>
    );
  };
  // A row that is not an item: in the foot, under the total (included), or
  // under the row it is printed on (`note` says which).
  const otherRow = (i, { cls = '', note = '' } = {}) => {
    const r = rows[i];
    const label = names[i].toLowerCase();
    return (
      <div key={i} className={`pp-row is-${r.kind}${cls}`}>
        <span className="pp-labelcell">
          {r.kind === 'tax' && r.included && <span className="pp-incl-word">incl.</span>}
          {labelBox(i, names[i], KIND_WORD[r.kind])}
        </span>
        {r.kind === 'item'
          ? <input className="form-input pp-in pp-num" type="number" step="any" value={r.qty ?? ''} disabled={disabled} onChange={e => setRow(i, 'qty', e.target.value)} aria-label={`${names[i]} quantity`} />
          : r.kind === 'rounding' ? <span /> : rateBox(i, names[i])}
        {amountBox(i, names[i])}
        <span className="pp-fill">{[note, r.worked ? 'worked out' : ''].filter(Boolean).join(' · ')}</span>
        {menu(i, label)}
        {aiLine(i, label)}
      </div>
    );
  };
  const withSubs = (i, draw) => [draw(i), ...kids(i).flatMap(j => withSubs(j, k => otherRow(k, { cls: ' is-sub', note: onWhat(rows[k]) })))];
  const foldRow = f => {
    const isOpen = open.has(f.fold);
    const total = f.members.reduce((s, j) => s + (num(rows[j].amount) || 0), 0);
    const id = `${idPrefix}-fold-${f.fold.replace(/[^a-z0-9]/gi, '')}`;
    const name = `${String(f.label || '').trim() || 'Tax'}${num(f.rate) !== null ? ` ${rateText(f.rate)}` : ''}`;
    return [
      <div key={f.fold} className={`pp-row is-fold${f.included ? ' is-incl' : ''}`}>
        <span className="pp-fold-label">{f.included ? 'incl. ' : ''}{String(f.label || '').trim() || 'Tax'}</span>
        <span className="pp-fold-rate">{rateText(f.rate)}</span>
        <span className="pp-fold-amt">{money(total)}</span>
        <span className="pp-fill">
          <button type="button" className="pp-link" aria-expanded={isOpen} aria-controls={isOpen ? id : undefined} onClick={() => toggleFold(f.fold)}>
            on {f.members.length} charges <span aria-hidden="true">{isOpen ? '▴' : '▾'}</span><span className="sr-only">, {isOpen ? 'hide' : 'show'} each {name}</span>
          </button>
        </span>
        <span />
      </div>,
      isOpen && <div key={`${f.fold}-each`} id={id} className="pp-fold-each">{f.members.map(j => otherRow(j, { cls: ' is-sub', note: onWhat(rows[j]) }))}</div>,
    ];
  };

  return (
    <div className={`${card ? 'card ' : ''}pp is-full${taxCol ? ' has-tax' : ''}${invalid ? ' is-invalid' : ''}`}>
      {head}
      {sub}
      <div className="pp-table" role="group" aria-label="The receipt as printed">
        <div className="pp-row pp-colhead" aria-hidden="true">
          <span>Item</span><span>Qty</span><span className="pp-r">Amount</span><span>Category</span>
          <span className="pp-paid-head" title="Empty when it was yours; a colleague's name for a cost paid on their behalf">Paid for</span>
          {taxCol && <span title="Which of the receipt's taxes the item was charged">Tax</span>}
          <span />
        </div>
        {lay.items.flatMap(e => withSubs(e.i, itemRow))}
        {!disabled && <div className="pp-adds is-items"><button type="button" className="btn btn-ghost btn-sm" onClick={() => add('item')}>+ item</button></div>}
        <div className="pp-foot">
          {printed.subtotal !== null && (
            <div className="pp-row is-sum">
              <label className="pp-sum-label" htmlFor={`${idPrefix}-subtotal`}>Subtotal</label>
              <input id={`${idPrefix}-subtotal`} className="form-input pp-in pp-amt" type="number" step="any" value={printed.subtotal ?? ''} disabled={disabled}
                     onChange={e => setTop('subtotal', e.target.value)} />
              <span className="pp-fill" />
              {disabled ? <span /> : (
                <button type="button" className="btn btn-ghost btn-sm pp-menu-btn" onClick={() => setTop('subtotal', null)} title="The receipt prints no subtotal" aria-label="Remove the subtotal: the receipt prints none">✕</button>
              )}
              {readSub !== null && <span className="pp-ai is-top"><ReadTop value={readSub} money={money} disabled={disabled} what="subtotal" onUse={() => setTop('subtotal', String(readSub))} /></span>}
            </div>
          )}
          {lay.foot.flatMap(e => (e.fold ? foldRow(e) : withSubs(e.i, otherRow)))}
        </div>
        <div className={`pp-row is-total${invalid ? ' is-invalid' : ''}`}>
          <label className="pp-sum-label" htmlFor={`${idPrefix}-total`}>Total paid</label>
          <input id={`${idPrefix}-total`} className="form-input pp-in pp-amt" type="number" step="any" value={printed.total ?? ''} disabled={disabled}
                 aria-invalid={invalid || undefined} onChange={e => setTop('total', e.target.value)} />
          <span className="pp-fill" />
          <span />
          {readTotal !== null && <span className="pp-ai is-top"><ReadTop value={readTotal} money={money} disabled={disabled} what="total" onUse={() => setTop('total', String(readTotal))} /></span>}
        </div>
        {lay.incl.length > 0 && (
          <div className="pp-incl">{lay.incl.flatMap(e => (e.fold ? foldRow(e) : withSubs(e.i, k => otherRow(k, { cls: ' is-incl' }))))}</div>
        )}
      </div>
      {!disabled && <Adds add={add} subtotal={printed.subtotal === null} onSubtotal={() => setTop('subtotal', '')} />}
      {gap}
      {flagRows}
      {claimedLine}
    </div>
  );
}

// The same value after it has stopped changing for `ms`: the gap line is
// worked out from it, so it is not said again at every key.
function useSettled(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Adds({ add, subtotal, onSubtotal }) {
  return (
    <div className="pp-adds" role="group" aria-label="Add a row">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => add('tax')}>+ tax</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => add('charge')}>+ charge</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => add('discount')}>+ discount</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => add('rounding')}>+ rounding</button>
      {subtotal && <button type="button" className="btn btn-ghost btn-sm" onClick={onSubtotal}>+ subtotal</button>}
    </div>
  );
}

function ReadTop({ value, money, disabled, what, onUse }) {
  return (
    <span className="rcpt-ai pp-ai-top" title="What the reader first read off the receipt">
      AI read: <span className="rcpt-ai-value">{money(value)}</span>
      {!disabled && <button type="button" className="rcpt-ai-use" onClick={onUse} aria-label={`Use what the reader read for the ${what}: ${money(value)}`}>use</button>}
    </span>
  );
}

// A subtotal or the total in the compact variant: one box each, typed into
// in place rather than through a sheet.
function TopBox({ id, label, value, disabled, onChange, read, money, strong = false, invalid = false }) {
  return (
    <div className={`pp-top${strong ? ' is-total' : ''}${invalid ? ' is-invalid' : ''}`}>
      <label className="pp-top-label" htmlFor={id}>{label}</label>
      <input id={id} className="form-input pp-in pp-amt" type="number" step="any" value={value ?? ''} disabled={disabled}
             aria-invalid={invalid || undefined} onChange={e => onChange(e.target.value)} />
      {read !== null && <ReadTop value={read} money={money} disabled={disabled} what={label.toLowerCase()} onUse={() => onChange(String(read))} />}
    </div>
  );
}

// One row's boxes, in a sheet over the page (compact). What is typed goes
// straight onto the row; Done closes it.
function RowSheet({ i, rows, name, read, money, categories, groups, onWhat, idPrefix, setRow, changeKind, onUseRead, onRemove, onClose }) {
  const r = rows[i];
  const id = k => `${idPrefix}-sheet-${k}`;
  const item = r.kind === 'item';
  const sub = Number.isInteger(r.on);
  const differs = read && differsFromRead(r, read);
  const under = dependents(rows, i).length;
  return (
    <Modal onClose={onClose} sheet labelledBy={id('title')} maxWidth={420}>
      {/* Enter in a box is Done, as it is Check on the page behind. */}
      <div className="pp-sheet" onKeyDown={e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') { e.preventDefault(); onClose(); } }}>
        <h2 className="pp-sheet-title" id={id('title')}>{String(r.label || '').trim() || `New ${(KIND_WORD[r.kind] || 'row').toLowerCase()}`}</h2>
        {sub && onWhat && <div className="rcpt-hint pp-sheet-on">Printed {onWhat}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor={id('kind')}>Type</label>
          <select id={id('kind')} className="form-input" value={r.kind} onChange={e => changeKind(i, e.target.value)}>
            {KINDS.map(k => <option key={k} value={k}>{KIND_WORD[k]}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={id('label')}>Name</label>
          <input id={id('label')} className="form-input" value={r.label ?? ''} placeholder={item ? 'What was bought' : KIND_WORD[r.kind]} onChange={e => setRow(i, 'label', e.target.value)} />
        </div>
        <div className="pp-sheet-pair">
          {item ? (
            <div className="form-group">
              <label className="form-label" htmlFor={id('qty')}>Quantity</label>
              <input id={id('qty')} className="form-input" type="number" step="any" min="0" value={r.qty ?? ''} onChange={e => setRow(i, 'qty', e.target.value)} />
            </div>
          ) : r.kind !== 'rounding' && (
            <div className="form-group">
              <label className="form-label" htmlFor={id('rate')}>Rate, %</label>
              <input id={id('rate')} className="form-input" type="number" step="any" value={r.rate ?? ''} placeholder="None printed" onChange={e => setRow(i, 'rate', e.target.value)} />
            </div>
          )}
          <div className="form-group">
            <label className="form-label" htmlFor={id('amount')}>Amount</label>
            <input id={id('amount')} className="form-input" type="number" step="any" value={r.amount ?? ''} onChange={e => setRow(i, 'amount', e.target.value)} />
          </div>
        </div>
        {item && !sub && (
          <div className="form-group">
            <label className="form-label" htmlFor={id('category')}>Category</label>
            <select id={id('category')} className="form-input" value={r.category || ''} onChange={e => setRow(i, 'category', e.target.value)}>
              <option value="">Category…</option>
              {r.category && !categories.includes(r.category) && <option value={r.category}>{r.category}</option>}
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
        {item && !sub && (
          <div className="form-group">
            <label className="form-label" htmlFor={id('paid')}>Paid for</label>
            <input id={id('paid')} className="form-input" value={String(r.onBehalfOf || '').trim() ? r.onBehalfOf : ''} placeholder="Empty when it was yours"
                   onChange={e => setRow(i, 'onBehalfOf', e.target.value)} />
          </div>
        )}
        {item && groups && (
          <div className="form-group">
            <label className="form-label" htmlFor={id('tax')}>Tax</label>
            <select id={id('tax')} className="form-input" value={num(r.taxRate) ?? ''} onChange={e => setRow(i, 'taxRate', e.target.value === '' ? null : e.target.value)}>
              {groups.map(g => <option key={g.rate} value={g.rate}>{rateText(g.rate)} ({g.labels.join(' + ')})</option>)}
              {num(r.taxRate) !== null && !groups.some(g => g.rate === num(r.taxRate)) && <option value={num(r.taxRate)}>{rateText(r.taxRate)}</option>}
              <option value="">Not shown on the receipt</option>
            </select>
          </div>
        )}
        {r.kind === 'tax' && (
          <fieldset className="pp-sheet-incl">
            <legend className="form-label">On the receipt</legend>
            <label><input type="radio" name={id('incl')} checked={!r.included} onChange={() => setRow(i, 'included', false)} /> Added to the total</label>
            <label><input type="radio" name={id('incl')} checked={!!r.included} onChange={() => setRow(i, 'included', true)} /> Included in the prices</label>
            {r.worked && <div className="rcpt-hint">Worked out: the receipt says the price includes it but prints no amount.</div>}
          </fieldset>
        )}
        {differs && (
          <div className="rcpt-ai pp-sheet-ai" title="What the reader first read off the receipt">
            AI read: <span className="rcpt-ai-value">{rowWords(read, money)}</span>
            <button type="button" className="rcpt-ai-use" onClick={() => onUseRead(read)} aria-label={`Use what the reader read for ${name.toLowerCase()}: ${rowWords(read, money)}`}>use</button>
          </div>
        )}
        <div className="pp-sheet-actions">
          <button type="button" className="btn btn-outline pp-sheet-remove" onClick={onRemove}>{under ? `Remove, with the ${under} under it` : 'Remove'}</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
