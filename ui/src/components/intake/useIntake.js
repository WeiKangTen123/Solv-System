import { useCallback, useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useVisiblePolling } from '../../utils/useVisiblePolling';

// How far the case's files have got on the server: GET /reports/:id/intake
// (main/reports/intake-view.js), asked again and again while the page is
// looked at. `every()` says how long until the next ask (intake-logic.js
// pollEvery: 2 s while anything is on its way or being read, up to 20 s when
// nothing is).
//
// Returns { data, error, at, refresh }. `at` is when the answer in `data` was
// asked for, so a caller can tell an answer that left before its own save
// from one that left after it. An answer the same as the last keeps the same
// `data`, so nothing redraws for a poll that brought nothing new. An answer
// for a case the page has since left is dropped.
export function useIntake(caseId, every) {
  const [state, setState] = useState({ data: null, error: null, at: 0 });
  const idRef = useRef(caseId);
  idRef.current = caseId;
  const last = useRef('');

  const load = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    const at = Date.now();
    try {
      const d = await api.get(`/reports/${id}/intake`);
      if (idRef.current !== id) return;
      const sig = JSON.stringify(d);
      const same = sig === last.current;
      last.current = sig;
      setState(st => (same && !st.error ? st : { data: same ? st.data : d, error: null, at }));
    } catch (err) {
      if (idRef.current === id) setState(st => ({ ...st, error: err }));
    }
  }, []);

  useEffect(() => {
    last.current = '';
    setState({ data: null, error: null, at: 0 });
    if (caseId) load();
  }, [caseId, load]);

  useVisiblePolling(load, every);
  return { ...state, refresh: load };
}
