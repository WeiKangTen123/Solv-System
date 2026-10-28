import { useEffect, useId, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
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
//   purposeOpen  the purpose's suggestions start open: "Suggest" pressed on
//              the case's details before the form was.
//
// The purpose is never filled in by the AI. "Suggest" beside it offers a
// plain account of the receipts and the person's own earlier purposes; a
// pick fills the field, which then saves and edits like anything typed.
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

// The purpose's choices, asked of the server when "Suggest" is pressed and
// not before (GET /reports/:id/cover-suggestions): the draft built by rules
// from the receipts, and the person's own last three purposes. Nothing is
// saved until one is picked.
function PurposeChoices({ id, caseId, onPick, onClose }) {
  const [got, setGot] = useState({ loading: true, error: '', draft: null, past: [] });
  useEffect(() => {
    let alive = true;
    api.get(`/reports/${caseId}/cover-suggestions`)
      .then(d => { if (alive) setGot({ loading: false, error: '', draft: d.purposeDraft || null, past: d.pastPurposes || [] }); })
      .catch(err => { if (alive) setGot({ loading: false, error: err.message || 'The suggestions could not be loaded.', draft: null, past: [] }); });
    return () => { alive = false; };
  }, [caseId]);
  const n = (got.draft ? 1 : 0) + got.past.length;
  const choice = text => (
    <li key={text}>
      <button type="button" className="in-purpose-choice" onClick={() => onPick(text)}>
        <span className="sr-only">Use </span>{text}
      </button>
    </li>
  );
  return (
    <div id={id} className="in-purpose-choices" role="group" aria-label="Suggested purposes"
         onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="in-purpose-status" role="status">
        {got.loading ? 'Looking at your receipts…'
          : got.error ? ''
          : n ? `${n} suggestion${n === 1 ? '' : 's'}: pick one to fill the purpose, then edit it as you like.`
          : 'Nothing to suggest yet. Once a receipt here is read, its categories, towns and dates make a draft.'}
      </div>
      {got.error && <div className="in-field-warn" role="alert">{got.error}</div>}
      {got.draft && (
        <>
          <div className="in-purpose-head" id={`${id}-draft`}>From your receipts</div>
          <ul className="in-purpose-list" aria-labelledby={`${id}-draft`}>{choice(got.draft)}</ul>
        </>
      )}
      {got.past.length > 0 && (
        <>
          <div className="in-purpose-head" id={`${id}-past`}>Your earlier purposes</div>
          <ul className="in-purpose-list" aria-labelledby={`${id}-past`}>{got.past.map(choice)}</ul>
        </>
      )}
      <div className="in-purpose-foot">
        <span className="in-field-hint">Says what the receipts show, never why: add the reason yourself.</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export default function CoverForm({ cover, suggestion, base, disabled = false, aiPicksKind = false, purposeOpen = false }) {
  const uid = useId().replace(/:/g, '');
  const id = f => `${uid}-${f}`;
  const [choices, setChoices] = useState(!!purposeOpen);
  const [picked, setPicked] = useState('');
  const suggestRef = useRef(null);
  const canSuggest = !!cover.caseId && !disabled;
  function pick(text) {
    cover.change({ purpose: text });
    setChoices(false);
    setPicked('Purpose filled in. Edit it as you like; it saves as you type.');
    // Back to the field, so what was picked can be edited straight away.
    requestAnimationFrame(() => document.getElementById(id('purpose'))?.focus());
  }
  function closeChoices() {
    setChoices(false);
    suggestRef.current?.focus();
  }
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
          <div className="in-label-row">
            <label className="form-label" htmlFor={id('purpose')}>Purpose</label>
            {canSuggest && (
              <button type="button" ref={suggestRef} className="btn btn-ghost btn-sm in-suggest-btn" aria-expanded={choices} aria-controls={id('choices')}
                      onClick={() => { setPicked(''); setChoices(o => !o); }}
                      onKeyDown={e => { if (e.key === 'Escape' && choices) { e.preventDefault(); setChoices(false); } }}>
                <span aria-hidden="true">✦ </span>Suggest<span className="sr-only"> a purpose</span>
              </button>
            )}
          </div>
          <input className="form-input" placeholder="e.g. Client site visits" maxLength={500} {...field('purpose')} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={id('advances')}>Advance {base}</label>
          <input className="form-input in-money" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" {...field('advances')} />
        </div>
      </div>
      {choices && canSuggest && <PurposeChoices id={id('choices')} caseId={cover.caseId} onPick={pick} onClose={closeChoices} />}
      <div className="sr-only" role="status">{picked}</div>

      <div className={`in-save is-${cover.save.state}`} role="status">
        {cover.save.state === 'saving' ? 'Saving…'
          : cover.save.state === 'saved' ? 'Saved'
          : cover.save.state === 'error' ? `Not saved: ${cover.save.error}` : ''}
      </div>
    </form>
  );
}
