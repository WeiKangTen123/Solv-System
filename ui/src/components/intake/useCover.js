import { useCallback, useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';

// The case's cover while the AI and the person both write it.
//
// The AI fills a draft's cover as reads land (reports/cover-auto.js), and the
// intake poll brings its latest values. The person may type over any of them,
// and a field they typed is theirs: it is saved on its own (PATCH, 600 ms
// after the last key), the server moves it to coverAi.user, and the AI never
// writes it again. Only what the person changed is ever sent, so a field they
// left alone stays the AI's to fill.
//
// A poll's values land in a field only when the person is not in it, has
// nothing unsaved in it, and the poll was asked for after the field's last
// save: an answer that left before the save would put the old value back.
//
// Before the draft exists nothing is saved; what was typed is handed to
// whoever makes the case (`typed()`), and `adopt()` is told what went with it.
export const COVER_FIELDS = ['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'purpose', 'advances'];
const EMPTY = { kind: '', title: '', periodFrom: '', periodTo: '', destination: '', purpose: '', advances: '' };
const SAVE_AFTER_MS = 600;

// The server's value as the form holds it: text, '' for nothing.
function toForm(field, v) {
  if (v === null || v === undefined) return '';
  if (field === 'advances') return Number(v) ? String(v) : '';
  return String(v);
}
// The form's value as the server takes it. '' clears a field; a kind is
// never cleared, only chosen.
function toBody(values, fields) {
  const out = {};
  for (const f of fields) {
    const v = values[f];
    if (f === 'kind' && !v) continue;
    out[f] = f === 'advances' && v !== '' ? Number(v) : v;
  }
  return out;
}

export function useCover(caseId) {
  const [values, setValues] = useState(EMPTY);
  const [coverAi, setCoverAi] = useState({ auto: [], user: [] });
  const [save, setSave] = useState({ state: 'idle', error: '' });   // idle | saving | saved | error
  const r = useRef(null);
  if (!r.current) r.current = { values: EMPTY, typed: new Set(), dirty: new Set(), sending: new Set(), savedAt: {}, focused: null, timer: null, inflight: null, caseId: null };
  const s = r.current;
  s.caseId = caseId;

  const show = () => setValues(s.values);

  // Sends what is unsaved. Resolves to '' when everything is saved (or there
  // was nothing to save), else to the reason it was not; never rejects, so a
  // save started by a timer or by leaving a field cannot become an unhandled
  // rejection. The fields that failed stay unsaved, to go with the next try.
  //
  // A save already on its way is waited for first, even with nothing new to
  // send: pressing Done blurs the field, whose save is then in flight, and
  // Done used to find nothing unsaved and close before that save failed. One
  // that failed is the answer, not tried again at once: what it carried waits
  // for the next change or the next Done.
  const send = useCallback(async () => {
    clearTimeout(s.timer);
    s.timer = null;
    if (!s.caseId) return '';
    if (s.inflight) { const failed = await s.inflight; return failed || send(); }
    if (!s.dirty.size) return '';
    const id = s.caseId;
    const fields = [...s.dirty];
    const sent = { ...s.values };
    s.dirty.clear();
    fields.forEach(f => s.sending.add(f));
    setSave({ state: 'saving', error: '' });
    s.inflight = api.patch(`/reports/${id}`, toBody(sent, fields))
      .then(d => {
        const at = Date.now();
        fields.forEach(f => { s.savedAt[f] = at; });
        if (d && d.report && d.report.coverAi) setCoverAi(d.report.coverAi);
        setSave({ state: 'saved', error: '' });
        return '';
      })
      .catch(err => {
        // Kept to send again with the next change, unless it has changed
        // since and is in `dirty` already.
        fields.forEach(f => s.dirty.add(f));
        const failed = err.message || 'Not saved';
        setSave({ state: 'error', error: failed });
        return failed;
      })
      .finally(() => {
        fields.forEach(f => s.sending.delete(f));
        s.inflight = null;
      });
    return s.inflight;
  }, [s]);

  // Saves now, for a caller that goes on only once it is saved: "Done" on the
  // case's details, "Save draft". Throws when the save failed, so the form
  // stays open with the error rather than closing over what was not kept.
  const flush = useCallback(async () => {
    const failed = await send();
    if (failed) throw new Error(failed);
  }, [send]);

  const schedule = useCallback(() => {
    clearTimeout(s.timer);
    if (s.caseId) s.timer = setTimeout(send, SAVE_AFTER_MS);
  }, [s, send]);

  // The person changed one or more fields.
  const change = useCallback(patch => {
    s.values = { ...s.values, ...patch };
    for (const f of Object.keys(patch)) { s.typed.add(f); s.dirty.add(f); }
    show();
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, schedule]);

  const focus = useCallback(f => { s.focused = f; }, [s]);
  // Leaving a field saves it now rather than in 600 ms.
  const blur = useCallback(f => { if (s.focused === f) s.focused = null; if (s.dirty.size) send(); }, [s, send]);

  // A poll's cover (or a freshly loaded case), asked for at `at` (ms).
  const fromServer = useCallback((cover, ai, at = Date.now()) => {
    if (!cover) return;
    const next = { ...s.values };
    let moved = false;
    for (const f of COVER_FIELDS) {
      if (s.focused === f || s.dirty.has(f) || s.sending.has(f) || (s.savedAt[f] && at <= s.savedAt[f])) continue;
      const v = toForm(f, cover[f]);
      if (v !== next[f]) { next[f] = v; moved = true; }
    }
    if (moved) { s.values = next; show(); }
    if (ai) setCoverAi(ai);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);

  // The fields the person typed, as the server takes them: what a new case
  // (draft or not) is made with.
  const typed = useCallback(() => toBody(s.values, [...s.typed]), [s]);
  // What has not reached the server yet, for "Create case", which saves it
  // with the same call.
  const unsaved = useCallback(() => toBody(s.values, [...new Set([...s.dirty, ...s.sending])]), [s]);
  const anyTyped = useCallback(() => [...s.typed].some(f => s.values[f] !== ''), [s]);

  // The draft was made with `sent` (what typed() gave): those fields are
  // saved, unless they have changed since, which are sent now.
  const adopt = useCallback((id, sent, report) => {
    s.caseId = id;
    const at = Date.now();
    for (const f of Object.keys(sent || {})) {
      if (String(toBody(s.values, [f])[f]) === String(sent[f])) { s.dirty.delete(f); s.savedAt[f] = at; }
    }
    if (report && report.coverAi) setCoverAi(report.coverAi);
    if (s.dirty.size) schedule();
  }, [s, schedule]);

  // Nothing more is sent: the case is being thrown away or created.
  const cancel = useCallback(() => { clearTimeout(s.timer); s.timer = null; s.dirty.clear(); }, [s]);

  // A change typed in the last 600 ms still goes when the page closes.
  useEffect(() => () => { if (s.dirty.size && s.caseId) send(); }, [s, send]);

  // caseId: the case being written, or null before a draft exists. The
  // purpose's suggestions (CoverForm) are asked of it.
  return { values, coverAi, save, change, focus, blur, fromServer, typed, unsaved, anyTyped, adopt, cancel, flush, typedFields: s.typed, caseId };
}
