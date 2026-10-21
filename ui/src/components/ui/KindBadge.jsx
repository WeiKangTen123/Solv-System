import { KIND_GLYPH, KIND_HINT, kindLabel } from '../../utils/kinds';

// What kind of case this is, as a small outlined tag: "↗ Trip", "◫ Month",
// "◇ Other". Outlined and colourless on purpose: a kind is not a status, and
// colour on this screen always means one. Hovering it says what the kind is
// for. Labels, hints and glyphs come from utils/kinds.js.
//
// Props:
//   kind  'trip' | 'period' | 'case' (the database's words).
export default function KindBadge({ kind }) {
  return (
    <span className="badge ui-kind" title={KIND_HINT[kind]}>
      <span className="ui-kind-glyph" aria-hidden="true">{KIND_GLYPH[kind] || KIND_GLYPH.case}</span>
      {kindLabel(kind)}
    </span>
  );
}
