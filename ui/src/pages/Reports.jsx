import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useViewMode } from '../context/ViewModeContext';
import { PageHeader, FilterChips, SearchInput, EmptyState, Skeleton, KindBadge, Pagination } from '../components/ui';
import CaseStatus from '../components/cases/CaseStatus';
import Poll from '../components/cases/Poll';
import {
  CHIPS, SORTS, PAGE_SIZE, readFilters, defaultChip, listQuery, withFilter, receiptsWords, rowFacts, rowAction, caseHref,
} from '../components/cases/case-logic';
import { KINDS, KIND_LABEL } from '../utils/kinds';
import { fmtDateRange, fmtMoney } from '../utils/format';
import { unpricedCount, unpricedText } from '../utils/caseTotals';
import { useOnChanged } from '../utils/useOnChanged';

// The cases: one row each, with where it stands and the one thing to do next
// on it. A case is a bundle of receipts claimed as one thing: a draft while
// the New case page is putting it together, open while receipts go in and
// get checked, claimed once its owner has put it through. The list is the
// person's own; an admin can also see everyone's, or one person's.
//
// Every filter is in the address (case-logic.js readFilters), and the server
// does the filtering and the paging: GET /reports?…&limit=20&offset=.
export default function Reports() {
  const [params] = useSearchParams();
  // "+ New case" used to open a form here as ?new=1. The form is the New case
  // page now; old links and bookmarks land on it.
  if (params.get('new') === '1') return <Navigate to="/reports/new" replace />;
  return <CasesList />;
}

const EMPTY = {
  open: ['No open cases', 'A case is open from the moment it is created until you mark it claimed.'],
  ready: ['Nothing ready to claim', 'A case is ready once every receipt in it is checked and has an amount and a rate.'],
  claimed: ['Nothing claimed yet', 'Cases marked claimed show here, with whether they have gone to Xero.'],
  draft: ['No drafts', 'A draft is made when receipts are dropped on New case, and stays until the case is created or discarded.'],
  all: ['No cases yet', 'Start with New case: drop the receipts in, and the AI fills in the details from them.'],
};

function CasesList() {
  const { user } = useAuth();
  const { isMobile } = useViewMode();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const base = user?.baseCurrency || 'SGD';
  const me = user?.id;
  const canAll = user?.role === 'admin';
  const f = readFilters(params);
  const wide = canAll && f.scope === 'all';

  // The counts belong to a scope (and a claimant): one person's must not
  // choose the default chip for another's.
  const countsKey = wide ? `all:${f.owner}` : 'mine';
  const [counts, setCounts] = useState(null);       // { key, value }
  const known = counts && counts.key === countsKey ? counts.value : null;
  const chip = f.chip || defaultChip(known);
  const query = listQuery(f, chip, { canAll });

  // Each answer remembers the query it was for, so a page for one filter is
  // never drawn under another's chips while the new one is on its way.
  const [res, setRes] = useState(null);             // { query, reports, total }
  const [failed, setFailed] = useState(null);       // { query, message }
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await api.get(`/reports?${query}`);
      if (n !== seq.current) return;
      setRes({ query, reports: d.reports || [], total: d.total || 0 });
      setCounts({ key: countsKey, value: d.counts || null });
      setFailed(null);
    } catch (err) {
      if (n === seq.current) setFailed({ query, message: err.message });
    }
  }, [query, countsKey]);
  useEffect(() => { load(); }, [load]);
  // A change from the assistant shows straight away.
  useOnChanged(load);
  const shown = res && res.query === query ? res : null;
  const error = failed && failed.query === query ? failed.message : null;
  // A row whose receipts are being read moves on its own: "3 reading"
  // becomes "3 to check" without a reload.
  const pollEvery = shown && shown.reports.some(r => r.reading > 0) ? 4000 : 60000;

  // The admin's claimant filter needs the people (GET /users is an admin's).
  const [people, setPeople] = useState(null);
  useEffect(() => {
    if (!wide || people) return;
    api.get('/users').then(d => setPeople(d.users || [])).catch(() => setPeople([]));
  }, [wide, people]);

  // A search replaces the address rather than adding to it: every pause in
  // typing would otherwise be one more press of Back. Chips, kind, sort and
  // pages are steps of their own.
  const change = useCallback((patch, { replace = false } = {}) => {
    setParams(prev => withFilter(prev, patch), { replace });
  }, [setParams]);

  // Past the end (the last case on the last page went, or a link named a page
  // that is not there any more): the last page there is.
  useEffect(() => {
    if (!shown || shown.reports.length || !shown.total || f.page <= 1) return;
    change({ page: Math.ceil(shown.total / PAGE_SIZE) }, { replace: true });
  }, [shown, f.page, change]);

  const narrowed = !!(f.q || f.kind);
  const owner = wide && f.owner && people ? people.find(p => p.id === f.owner) : null;
  const rows = shown ? shown.reports : [];
  const starred = rows.some(r => !unpriced(r) && unpricedCount(r));

  const newCase = <Link className="btn btn-primary" to="/reports/new">+ New case</Link>;
  const chips = CHIPS.map(c => ({ ...c, count: known ? known[c.id] : undefined }));

  let body;
  if (!shown && error) {
    body = (
      <div className="alert alert-error cs-error" role="alert">
        <span className="alert-icon">✕</span>
        <span>The cases could not be loaded: {error}</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={load}>Try again</button>
      </div>
    );
  } else if (!shown) {
    body = <Skeleton rows={6} height={44} label="Loading the cases" />;
  } else if (!rows.length) {
    const under = chip === 'all' ? '' : ` under ${(CHIPS.find(c => c.id === chip) || {}).label}`;
    const [title, words] = narrowed
      ? ['Nothing matches', `No ${f.kind ? `${KIND_LABEL[f.kind]} ` : ''}case${under}${f.q ? ` matches “${f.q}”` : ''}.`]
      : EMPTY[chip] || EMPTY.all;
    body = (
      <EmptyState compact title={title}
                  action={narrowed
                    ? <button type="button" className="btn btn-outline" onClick={() => change({ q: '', kind: '' })}>{f.kind ? 'Clear the filters' : 'Clear the search'}</button>
                    : !wide && newCase}>
        {wide && !narrowed ? `${owner ? `${owner.name || owner.email} has` : 'Nobody has'} none here.` : words}
      </EmptyState>
    );
  } else {
    body = (
      <>
        {error && <div className="alert alert-warning cs-error" role="status">Could not refresh: {error}</div>}
        {isMobile
          ? <CaseCards rows={rows} me={me} wide={wide} base={base} navigate={navigate} />
          : <CaseTable rows={rows} me={me} wide={wide} base={base} navigate={navigate} />}
        {/* The star said nothing about itself. */}
        {starred && <div className="cs-foot">* Short of the full amount: some receipts have no amount or exchange rate yet. Open the case to see which.</div>}
        <Pagination total={shown.total} limit={PAGE_SIZE} offset={(f.page - 1) * PAGE_SIZE} label="Pages of cases"
                    onChange={offset => change({ page: Math.floor(offset / PAGE_SIZE) + 1 })} />
      </>
    );
  }

  return (
    <div className="cs-list-page">
      <Poll key={pollEvery} fn={load} every={pollEvery} />
      <PageHeader title="Cases"
                  subtitle="A case is a bundle of receipts claimed as one thing. Open while receipts go in, claimed once you have put it through."
                  actions={newCase} />

      <div className="card cs-list">
        <div className="cs-filters">
          <div className="cs-filter-row">
            <div className="cs-search">
              <SearchInput value={f.q} onChange={q => change({ q }, { replace: true })}
                           placeholder="Search title, number, merchant…" label="Search cases" />
            </div>
            <label className="cs-select">
              <span>Kind</span>
              <select className="form-input" value={f.kind} onChange={e => change({ kind: e.target.value })}>
                <option value="">All</option>
                {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="cs-select">
              <span>Sort</span>
              <select className="form-input" value={f.sort} onChange={e => change({ sort: e.target.value })}>
                {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <FilterChips options={chips} value={chip} onChange={id => change({ chip: id })} label="Cases by status" />
          {canAll && (
            <div className="cs-filter-row cs-admin-row">
              <FilterChips options={[{ id: 'mine', label: 'Mine' }, { id: 'all', label: 'Everyone' }]} value={f.scope}
                           onChange={s => change({ scope: s })} label="Whose cases" />
              {wide && (
                <label className="cs-select">
                  <span>Claimant</span>
                  <select className="form-input" value={f.owner} onChange={e => change({ owner: e.target.value })}>
                    <option value="">Everyone</option>
                    {(people || []).map(p => <option key={p.id} value={p.id}>{p.name || p.email}{p.removed ? ' (removed)' : ''}</option>)}
                    {/* A link naming a person not in the list yet still shows who is picked. */}
                    {f.owner && people && !owner && <option value={f.owner}>Someone else</option>}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
        <div className="cs-list-body" aria-busy={!shown}>{body}</div>
      </div>
    </div>
  );
}

// "15" and, under it, "2 to check".
function Receipts({ r }) {
  const { count, toCheck } = rowFacts(r);
  const words = receiptsWords(r);
  return (
    <>
      <span className="cs-num">{count}</span>
      {words && <div className={`cs-sub${toCheck ? ' is-warn' : ''}`}>{words}</div>}
    </>
  );
}

// Nothing in it, or nothing in it priced yet (a draft whose receipts are
// still being read): "0.00 *" would read as a case that costs nothing.
const unpriced = r => !r.expenseCount || (!Number(r.totalBase) && unpricedCount(r) >= r.expenseCount);

function Amount({ r }) {
  if (unpriced(r)) return <span className="cs-none" title={r.expenseCount ? 'Nothing priced yet' : undefined}>—</span>;
  const short = unpricedCount(r);
  return (
    <span className={`cs-num${short ? ' is-warn' : ''}`} title={short ? `Not counted: ${unpricedText(r)}` : undefined}>
      {fmtMoney(r.totalBase, '')}{short ? ' *' : ''}
    </span>
  );
}

// The number, and where a trip went.
const subline = r => [r.number || 'Draft', r.kind === 'trip' && r.destination].filter(Boolean).join(' · ');
const titleOf = r => r.title || (r.status === 'draft' ? 'Untitled draft' : 'Untitled');

function Action({ r, me }) {
  const a = rowAction(r, me);
  if (!a) return null;
  return (
    <Link className="btn btn-outline btn-sm cs-act" to={a.to}>
      {a.label}<span className="sr-only">: {titleOf(r)}</span> <span aria-hidden="true">→</span>
    </Link>
  );
}

// The whole row opens the case; the title is its link for the keyboard, and
// the next-step button keeps its own click.
const opens = (navigate, to) => e => {
  if (e.target.closest('a, button, input, select, label')) return;
  navigate(to);
};

function CaseTable({ rows, me, wide, base, navigate }) {
  return (
    <div className="cs-table-wrap">
      <table className="data-table cs-table">
        <thead>
          <tr>
            <th>Case</th>
            {wide && <th>Claimant</th>}
            <th>Dates</th>
            <th className="cs-right">Receipts</th>
            <th className="cs-right">{base}</th>
            <th>Status</th>
            <th><span className="sr-only">Next step</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const to = caseHref(r, me);
            return (
              <tr key={r.id} className="cs-row" onClick={opens(navigate, to)}>
                <td className="cs-case">
                  <div className="cs-case-head">
                    <KindBadge kind={r.kind} />
                    <Link className="cs-case-title" to={to}>{titleOf(r)}</Link>
                  </div>
                  <div className="cs-sub cs-mono">{subline(r)}</div>
                </td>
                {wide && <td className="cs-owner">{r.ownerName || r.ownerEmail}</td>}
                <td className="cs-nowrap">{fmtDateRange(r.periodFrom, r.periodTo)}</td>
                <td className="cs-right"><Receipts r={r} /></td>
                <td className="cs-right"><Amount r={r} /></td>
                <td>
                  <CaseStatus status={r.status} ready={r.ready} />
                  {r.xeroInvoiceId && <div className="cs-sub">in Xero</div>}
                </td>
                <td className="cs-right"><Action r={r} me={me} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// On a phone a row is a card: seven columns do not fit a hand.
function CaseCards({ rows, me, wide, base, navigate }) {
  return (
    <ul className="cs-cards">
      {rows.map(r => {
        const to = caseHref(r, me);
        const words = receiptsWords(r);
        const { toCheck } = rowFacts(r);
        return (
          <li key={r.id} className="cs-card" onClick={opens(navigate, to)}>
            <div className="cs-card-top">
              <KindBadge kind={r.kind} />
              <CaseStatus status={r.status} ready={r.ready} />
            </div>
            <Link className="cs-case-title" to={to}>{titleOf(r)}</Link>
            <div className="cs-sub">
              {[subline(r), r.periodFrom || r.periodTo ? fmtDateRange(r.periodFrom, r.periodTo) : ''].filter(Boolean).join(' · ')}
            </div>
            {wide && <div className="cs-sub">{r.ownerName || r.ownerEmail}</div>}
            <div className="cs-card-figs">
              <span>
                {r.expenseCount} receipt{r.expenseCount === 1 ? '' : 's'}
                {words && <span className={toCheck ? 'is-warn' : undefined}> · {words}</span>}
              </span>
              <span>{!unpriced(r) && <span className="cs-cur">{base} </span>}<Amount r={r} /></span>
            </div>
            {r.xeroInvoiceId && <div className="cs-sub">In Xero</div>}
            <Action r={r} me={me} />
          </li>
        );
      })}
    </ul>
  );
}
