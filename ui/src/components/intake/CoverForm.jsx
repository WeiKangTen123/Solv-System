import { useId } from 'react';
import { KINDS, KIND_GLYPH, KIND_HINT, KIND_LABEL } from '../../utils/kinds';
import { fmtDateRange } from '../../utils/format';

// The case's details beside its receipts: Trip / Month / Other, a title, the
// dates (a whole month for a Month), where (a Trip only), why, and any
// advance. A field the AI filled from the receipts carries "✦ AI" until the
// person types in it; from then on it is theirs. Where the AI would now say
// something else about a field the person owns, a small "AI suggests" line
// offers it, and one click takes it.
//
// Props:
//   cover      useCover()'s return: values, coverAi, save, change, focus, blur.
//   suggestion the AI's current cover from the intake poll, or null.
//   base       the company's currency, for the advance.
//   disabled   nothing can be typed (the page is busy creating the case).
//   aiPicksKind  a new draft: until the AI or the person has chosen a kind,
//              none is shown as chosen. The draft's stored default (Other)
//              looked like a choice somebody had made.
const AI_TIP = 'Filled from your receipts; type to change it';

function AiMark() {
  return (
    <span className="in-ai" title={AI_TIP}>
      <span aria-hidden="true">✦ AI</span>
      <span className="sr-only">, filled by the AI from your receipts</span>
    </span>
  );
}

// "2026-09" → the first and last day of that month.
function wholeMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return null;
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { periodFrom: `${m[1]}-${m[2]}-01`, periodTo: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

function Suggest({ text, onUse }) {
  return (
    <div className="in-suggest">
      <span>AI suggests: {text}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onUse}>Use<span className="sr-only"> the suggestion {text}</span></button>
    </div>
  );
}

export default function CoverForm({ cover, suggestion, base, disabled = false, aiPicksKind = false }) {
  const uid = useId().replace(/:/g, '');
  const id = f => `${uid}-${f}`;
  const v = cover.values;
  const ai = new Set(cover.coverAi.auto || []);
  const mine = new Set([...(cover.coverAi.user || []), ...cover.typedFields]);
  // The marker goes once the person has typed in the field, before the
  // server has said so.
  const isAi = f => ai.has(f) && !cover.typedFields.has(f);
  const sug = suggestion || {};
  // A suggestion only for a field the person owns and the AI would fill
  // differently; one the AI owns already shows the AI's value.
  const differs = f => mine.has(f) && sug[f] && String(sug[f]) !== String(v[f] || '');
  const field = f => ({
    id: id(f), disabled, value: v[f],
    onFocus: () => cover.focus(f), onBlur: () => cover.blur(f),
    onChange: e => cover.change({ [f]: e.target.value }),
  });
  const kind = aiPicksKind && !ai.has('kind') && !mine.has('kind') ? '' : v.kind;
  const month = kind === 'period';
  const backwards = v.periodFrom && v.periodTo && v.periodFrom > v.periodTo;
  const notWhole = month && v.periodFrom && (() => { const w = wholeMonth(v.periodFrom.slice(0, 7)); return !w || w.periodFrom !== v.periodFrom || w.periodTo !== v.periodTo; })();

  return (
    <form className="in-cover" onSubmit={e => e.preventDefault()} aria-labelledby={id('head')}>
      <div className="in-cover-head">
        <h2 id={id('head')} className="section-label">Case details</h2>
        <span className="in-cover-legend"><AiMark /> filled from your receipts</span>
      </div>

      <fieldset className="in-kinds" disabled={disabled}>
        <legend className="form-label">Kind {isAi('kind') && <AiMark />}</legend>
        <div className="in-kind-row">
          {KINDS.map(k => (
            <label key={k} className={`in-kind${kind === k ? ' is-on' : ''}`}>
              <input type="radio" name={id('kind')} value={k} checked={kind === k}
                     onFocus={() => cover.focus('kind')} onBlur={() => cover.blur('kind')}
                     onChange={() => cover.change({ kind: k })} />
              <span className="in-kind-glyph" aria-hidden="true">{KIND_GLYPH[k]}</span>
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>
        <div className="in-field-hint">{kind ? KIND_HINT[kind] : 'The AI picks one from your receipts; choose one to decide yourself.'}</div>
        {differs('kind') && <Suggest text={KIND_LABEL[sug.kind] || sug.kind} onUse={() => cover.change({ kind: sug.kind })} />}
      </fieldset>

      <div className="form-group">
        <label className="form-label" htmlFor={id('title')}>Title {isAi('title') && <AiMark />}</label>
        <input className="form-input" placeholder="e.g. India trip, Sep 2026" maxLength={200} {...field('title')} />
        {differs('title') && <Suggest text={sug.title} onUse={() => cover.change({ title: sug.title })} />}
      </div>

      {month ? (
        <div className="form-group">
          <label className="form-label" htmlFor={id('month')}>Month {(isAi('periodFrom') || isAi('periodTo')) && <AiMark />}</label>
          <input id={id('month')} className="form-input" type="month" disabled={disabled} value={(v.periodFrom || '').slice(0, 7)}
                 onFocus={() => cover.focus('periodFrom')} onBlur={() => cover.blur('periodFrom')}
                 onChange={e => { const w = wholeMonth(e.target.value); if (w) cover.change(w); }} />
          {notWhole && <div className="in-field-hint">Now {fmtDateRange(v.periodFrom, v.periodTo)}. Pick the month to make it the whole month.</div>}
        </div>
      ) : (
        <div className="in-dates">
          <div className="form-group">
            <label className="form-label" htmlFor={id('periodFrom')}>From {isAi('periodFrom') && <AiMark />}</label>
            <input className="form-input" type="date" {...field('periodFrom')} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('periodTo')}>To {isAi('periodTo') && <AiMark />}</label>
            <input className="form-input" type="date" {...field('periodTo')} />
          </div>
        </div>
      )}
      {backwards && <div className="in-field-warn" role="status">From is after To.</div>}
      {(differs('periodFrom') || differs('periodTo')) && (
        <Suggest text={fmtDateRange(sug.periodFrom, sug.periodTo)} onUse={() => cover.change({ periodFrom: sug.periodFrom || '', periodTo: sug.periodTo || '' })} />
      )}

      {kind === 'trip' && (
        <div className="form-group">
          <label className="form-label" htmlFor={id('destination')}>Where {isAi('destination') && <AiMark />}</label>
          <input className="form-input" placeholder="e.g. Mumbai, Pune, India" maxLength={120} {...field('destination')} />
          {differs('destination') && <Suggest text={sug.destination} onUse={() => cover.change({ destination: sug.destination })} />}
        </div>
      )}

      <div className="in-dates">
        <div className="form-group">
          <label className="form-label" htmlFor={id('purpose')}>Purpose</label>
          <input className="form-input" placeholder="e.g. Client site visits" maxLength={500} {...field('purpose')} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={id('advances')}>Advance {base}</label>
          <input className="form-input in-money" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" {...field('advances')} />
        </div>
      </div>

      <div className={`in-save is-${cover.save.state}`} role="status">
        {cover.save.state === 'saving' ? 'Saving…'
          : cover.save.state === 'saved' ? 'Saved'
          : cover.save.state === 'error' ? `Not saved: ${cover.save.error}` : ''}
      </div>
    </form>
  );
}
