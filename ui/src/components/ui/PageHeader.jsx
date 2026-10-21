import { Link } from 'react-router-dom';

// The top of a page: an optional way back, the title, a line under it, and
// the page's own buttons on the right. Every page drew this by hand as an
// inline-flex .page-header, each with slightly different alignment and gaps;
// this is that markup once, so the pages built in the redesign line up.
//
// Props:
//   title     the h1; text or nodes (a StatusBadge or KindBadge can sit in it).
//   subtitle  optional line under the title.
//   actions   optional buttons, links or a Menu, laid out in a row that wraps
//             under the title on a narrow screen.
//   back      optional { to, label }: a link above the title, "← label". It
//             names where it goes ("← C-0012", "← My receipts"), because
//             "Back" says nothing about where back is.
export default function PageHeader({ title, subtitle, actions, back }) {
  return (
    <div className="page-header ui-page-header">
      <div className="ui-page-header-text">
        {back && (
          <Link className="ui-page-back" to={back.to}>
            <span aria-hidden="true">←</span> {back.label}
          </Link>
        )}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="ui-page-header-actions">{actions}</div>}
    </div>
  );
}
