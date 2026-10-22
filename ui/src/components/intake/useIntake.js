import { useCallback, useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api, streamGet } from '../../api/client';
import { useVisiblePolling } from '../../utils/useVisiblePolling';

// How far the case's files have got on the server (main/reports/intake-view.js).
//
// While the tab is looked at, the server says so itself: GET
// /reports/:id/intake/stream sends the intake at once and again whenever it
// changes (main/routes/intake-stream.js). The page used to ask every two
// seconds instead, and asking is still what it falls back to (GET
// /reports/:id/intake, at the pace `every()` gives: intake-logic.js
// pollEvery) whenever the stream fails, ends early, or has said nothing
// within FIRST_EVENT_MS — a proxy that holds the events back looks like that.
// The stream is tried again after 30 s, then 60 s, doubling to 5 minutes.
// The server ends every stream after a quarter of an hour, saying so, and
// that one is opened again at once.
//
// Returns { data, error, at, refresh }. `at` is when the answer in `data` was
// asked for, so a caller can tell an answer that left before its own save
// from one that left after it; an event is counted as asked LAG_MS before it
// arrived, since the server worked it out a moment before. An answer the
// same as the last keeps the same `data`, so nothing redraws for one that
// brought nothing new. An answer for a case the page has since left is
// dropped. refresh() asks at once, stream or not.
const FIRST_EVENT_MS = 8000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
const LAG_MS = 1000;
// A planned end sooner than this after opening is a fault, not the quarter
// of an hour: reopening at once would go round and round.
const MIN_LIFE_MS = 30_000;
// The poll's timer while the stream is up: it fires and does nothing.
const QUIET_MS = 60_000;

export function useIntake(caseId, every) {
  const [state, setState] = useState({ data: null, error: null, at: 0 });
  // Only so a change redraws, and the poll's pace is asked again.
  const [, setMode] = useState('stream');
  const idRef = useRef(caseId);
  idRef.current = caseId;
  const last = useRef('');
  // 'stream' while the stream is wanted (opening, open, or the tab hidden);
  // 'poll' while it is down and the poll stands in. `heardAt` is when the
  // stream last said something.
  const live = useRef({ mode: 'stream', heardAt: 0 });

  const take = useCallback((id, d, at) => {
    if (idRef.current !== id) return;
    const sig = JSON.stringify(d);
    const same = sig === last.current;
    last.current = sig;
    setState(st => (same && !st.error ? st : { data: same ? st.data : d, error: null, at }));
  }, []);

  const load = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    const at = Date.now();
    try {
      const d = await api.get(`/reports/${id}/intake`);
      // The stream spoke after this was asked: what it said is at least as
      // new, and an older answer must not paint over it. (One the server
      // worked out a moment sooner is put right by its next check.)
      if (live.current.heardAt > at) return;
      take(id, d, at);
    } catch (err) {
      if (idRef.current === id) setState(st => ({ ...st, error: err }));
    }
  }, [take]);

  useEffect(() => {
    last.current = '';
    setState({ data: null, error: null, at: 0 });
    const s = { mode: 'stream', heardAt: 0 };
    live.current = s;
    setMode('stream');
    if (!caseId) return undefined;

    let gone = false;
    let ctrl = null;      // the stream open now
    let retry = null;     // the wait before trying it again
    let fails = 0;
    const switchTo = mode => { s.mode = mode; setMode(mode); };

    function fallBack() {
      switchTo('poll');
      load();
      const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)];
      fails++;
      retry = setTimeout(() => { retry = null; switchTo('stream'); open(); }, wait);
    }

    async function open() {
      if (gone || ctrl || document.hidden) return;
      const me = new AbortController();
      ctrl = me;
      const openedAt = Date.now();
      let heard = false;
      let ended = null;
      const firstWait = setTimeout(() => { me.why = 'silent'; me.abort(); }, FIRST_EVENT_MS);
      try {
        await streamGet(`/reports/${caseId}/intake/stream`, (d, name) => {
          if (name === 'intake') {
            if (!heard) { heard = true; clearTimeout(firstWait); }
            s.heardAt = Date.now();
            take(caseId, d, s.heardAt - LAG_MS);
          } else if (name === 'end') {
            ended = d && d.reason;
          }
        }, { signal: me.signal });
      } catch { /* told apart below */ }
      clearTimeout(firstWait);
      if (ctrl === me) ctrl = null;
      if (gone || me.why === 'hidden') return;
      if (ended === 'time' && heard && Date.now() - openedAt >= MIN_LIFE_MS) { fails = 0; open(); return; }
      fallBack();
    }

    // A hidden tab holds no stream and asks nothing; back on it, the stream
    // is tried first and the poll waits to see whether it works.
    function onVisibility() {
      if (!document.hidden) { open(); return; }
      if (retry) { clearTimeout(retry); retry = null; }
      if (ctrl) { ctrl.why = 'hidden'; ctrl.abort(); ctrl = null; }
      switchTo('stream');
    }

    if (document.hidden) load(); else open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (retry) clearTimeout(retry);
      if (ctrl) { ctrl.why = 'gone'; ctrl.abort(); }
    };
  }, [caseId, load, take]);

  const polling = () => live.current.mode === 'poll';
  useVisiblePolling(
    () => (polling() ? load() : undefined),
    () => (polling() ? (typeof every === 'function' ? every() : every) : QUIET_MS),
  );
  return { ...state, refresh: load };
}
