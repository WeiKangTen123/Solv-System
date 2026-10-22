import { useEffect, useId, useRef, useState } from 'react';
import { KindBadge } from '../ui';
import CoverForm from '../intake/CoverForm';
import { fmtDateRange, fmtMoney } from '../../utils/format';

// The case's cover: what it is, its title, dates, where (a trip), why, the
// advance and any notes. Read as a finished document until the owner presses
// Edit; then it is the New case page's form (CoverForm, saving as it is
// typed, with the AI's markers), so a case is described by one set of rules
// whether it is a draft or open. The kind can still change while the case is
// open. Nights and notes are not on that form (a draft has no use for them),
// so they sit under it and save the same way.
//
// Props:
//   report      the case (GET /reports/:id), with `coverAi`.
//   cover       useCover(caseId) from the page, fed every load of the case.
//   suggestion  the AI's current cover from the intake panel, or null.
//   canEdit     the owner, and the case is open.
//   isOwner     the owner (a claimed case says how to change it).
//   base        the company's currency.
//   editing, onEdit(bool)  the page holds whether the form is open.
const AI_TIP = 'Filled from your receipts';

function AiMark() {
  return (
    <span className="in-ai" title={AI_TIP}>
      <span aria-hidden="true">✦ AI</span>
      <span className="sr-only">, filled by the AI from your receipts</span>
    </span>
  );
}

function Fact({ label, ai, wide, children }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className={`cs-fact${wide ? ' is-wide' : ''}`}>
      <dt>{label} {ai && <AiMark />}</dt>
      <dd className={empty ? 'cs-none' : undefined}>{empty ? '—' : children}</dd>
    </div>
  );
}

export default function CaseDetails({ report: r, cover, suggestion, canEdit, isOwner, base, editing, onEdit }) {
  const auto = new Set((r.coverAi && r.coverAi.auto) || []);
  const trip = r.kind === 'trip';

  if (editing && canEdit) {
    return (
      <section className="card cs-details is-editing">
        <CoverForm cover={cover} suggestion={suggestion} base={base} />
        <Extras report={r} cover={cover} trip={cover.values.kind === 'trip'} nightsAi={auto.has('nights')} />
        <div className="cs-details-foot">
          <button type="button" className="btn btn-primary btn-sm" onClick={async () => { await cover.flush(); onEdit(false); }}>Done</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card cs-details" aria-labelledby="cs-details-head">
      <div className="cs-details-head">
        <h2 id="cs-details-head" className="section-label">Case details</h2>
        {canEdit && <button type="button" className="btn btn-outline btn-sm" onClick={() => onEdit(true)}>Edit</button>}
      </div>
      <dl className="cs-facts">
        <Fact label="Kind" ai={auto.has('kind')}><KindBadge kind={r.kind} /></Fact>
        <Fact label="Number">{r.number}</Fact>
        <Fact label="Title" ai={auto.has('title')} wide>{r.title}</Fact>
        <Fact label="Dates" ai={auto.has('periodFrom') || auto.has('periodTo')}>
          {r.periodFrom || r.periodTo ? fmtDateRange(r.periodFrom, r.periodTo) : null}
        </Fact>
        {trip && <Fact label="Where" ai={auto.has('destination')}>{r.destination}</Fact>}
        {trip && <Fact label="Nights" ai={auto.has('nights')}>{r.nights === null || r.nights === undefined ? null : String(r.nights)}</Fact>}
        <Fact label="Purpose" wide>{r.purpose}</Fact>
        <Fact label="Advance">{Number(r.advances) > 0 ? fmtMoney(r.advances, base) : null}</Fact>
        <Fact label="Notes" wide>{r.notes}</Fact>
      </dl>
      {!canEdit && isOwner && r.status === 'claimed' && !r.xeroInvoiceId && (
        <div className="cs-sub cs-details-note">A claimed case is locked. Reopen it (under ⋯ at the top) to change its details.</div>
      )}
    </section>
  );
}

// Nights (a trip) and notes, saved through the same useCover as the form
// above, so one "Saving… / Saved" speaks for all of it. useCover keeps only
// the form's own fields in step with the server, so these two keep theirs
// here: the server's value until the person types in the field.
function Extras({ report, cover, trip, nightsAi }) {
  const uid = useId().replace(/:/g, '');
  const typed = useRef(new Set());
  const fromReport = () => ({ nights: report.nights === null || report.nights === undefined ? '' : String(report.nights), notes: report.notes || '' });
  const [vals, setVals] = useState(fromReport);
  useEffect(() => {
    const now = fromReport();
    setVals(v => ({ nights: typed.current.has('nights') ? v.nights : now.nights, notes: typed.current.has('notes') ? v.notes : now.notes }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.nights, report.notes]);
  const set = (k, v) => { typed.current.add(k); setVals(x => ({ ...x, [k]: v })); cover.change({ [k]: v }); };
  const field = k => ({ id: `${uid}-${k}`, value: vals[k], onFocus: () => cover.focus(k), onBlur: () => cover.blur(k), onChange: e => set(k, e.target.value) });

  return (
    <div className="cs-extras">
      {trip && (
        <div className="form-group cs-nights">
          <label className="form-label" htmlFor={`${uid}-nights`}>Nights {nightsAi && !typed.current.has('nights') && <AiMark />}</label>
          <input className="form-input in-money" type="number" inputMode="numeric" min="0" step="1" {...field('nights')} />
        </div>
      )}
      <div className="form-group">
        <label className="form-label" htmlFor={`${uid}-notes`}>Notes</label>
        <textarea className="form-input" rows={3} maxLength={2000} placeholder="Anything finance should know" {...field('notes')} />
      </div>
    </div>
  );
}
