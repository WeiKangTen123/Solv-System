// Where a case is on its way: Receipts → Check → Claim → Xero. Each step is
// done (a tick, in the settled green), current (filled ink, and
// aria-current="step") or still to come (an outline). A hint under a step
// says what is left there ("3 to check").
//
// On a phone only the current step keeps its words, with "Step 2 of 4" above
// them; the others shrink to their dots, so four steps fit one line instead
// of wrapping into a column nobody reads. A screen reader still hears every
// step's name.
//
// Props:
//   steps  [{ id, label, state: 'done' | 'current' | 'todo', hint? }], in order.
//   label  aria-label for the list (default "Progress").
const DONE = ' (done)';

export default function Stepper({ steps, label = 'Progress' }) {
  const n = steps.length;
  return (
    <ol className="ui-stepper" aria-label={label}>
      {steps.map((s, i) => {
        const state = s.state === 'done' || s.state === 'current' ? s.state : 'todo';
        return (
          <li key={s.id} className={`ui-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="ui-step-dot" aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
            <span className="ui-step-text">
              {state === 'current' && <span className="ui-step-of" aria-hidden="true">Step {i + 1} of {n}</span>}
              <span className="ui-step-label">{s.label}{state === 'done' && <span className="sr-only">{DONE}</span>}</span>
              {s.hint && <span className="ui-step-hint">{s.hint}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
