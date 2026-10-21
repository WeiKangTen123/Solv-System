import { useId, useRef } from 'react';

// A row of tabs that switch what the page shows below them: Draft / Open /
// Ready / Claimed on the Cases list, the sections of Settings. It is a real
// ARIA tablist, so a screen reader says "tab, 2 of 4, selected" and the
// keyboard works the way it does everywhere else: Tab lands on the chosen
// tab only, Left and Right move between tabs (and wrap), Home and End jump to
// the ends. Moving selects, because every panel here draws at once.
//
// Props:
//   tabs      [{ id, label, count? }]. `label` may be nodes; `count` is shown
//             as a muted figure after it and read as "Open, 3".
//   value     the selected tab's id.
//   onChange  fn(id), called only when a different tab is chosen.
//   label     optional aria-label for the row ("Cases by status").
//   idBase    optional prefix for the ids. Give one when the page labels its
//             panel: <div {...tabPanelProps(idBase, value)}> makes the panel
//             the one each tab's aria-controls points at.
//   variant   'line' (default; underlined, scrolls sideways on a phone) or
//             'pills' (filled buttons that wrap; what Settings has always had).
export function tabIds(base, id) {
  return { tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` };
}

export function tabPanelProps(base, id) {
  const ids = tabIds(base, id);
  return { role: 'tabpanel', id: ids.panel, 'aria-labelledby': ids.tab };
}

export default function Tabs({ tabs, value, onChange, label, idBase, variant = 'line' }) {
  const auto = useId().replace(/:/g, '');
  const base = idBase || `tabs-${auto}`;
  const refs = useRef([]);
  // With nothing selected the first tab takes the Tab key, or the row could
  // not be reached from the keyboard at all.
  const chosen = tabs.findIndex(t => t.id === value);
  const reachable = chosen === -1 ? 0 : chosen;

  function onKey(e, i) {
    const n = tabs.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowLeft' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1;
    if (to === -1) return;
    e.preventDefault();
    refs.current[to]?.focus();
    if (tabs[to].id !== value) onChange?.(tabs[to].id);
  }

  return (
    <div role="tablist" aria-label={label} className={`ui-tabs ui-tabs-${variant}`}>
      {tabs.map((t, i) => {
        const on = t.id === value;
        const ids = tabIds(base, t.id);
        return (
          <button key={t.id} ref={el => { refs.current[i] = el; }} type="button" role="tab"
                  id={ids.tab} aria-selected={on} aria-controls={ids.panel} tabIndex={i === reachable ? 0 : -1}
                  className={`ui-tab${on ? ' is-active' : ''}`}
                  onClick={() => { if (!on) onChange?.(t.id); }}
                  onKeyDown={e => onKey(e, i)}>
            <span className="ui-tab-label">{t.label}</span>
            {t.count != null && <span className="ui-count"><span className="sr-only">, </span>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
