// What a list says when there is nothing in it. It should say why there is
// nothing and what to do next, so it takes a sentence or two and, usually, the
// one button that fixes it ("New case"). Built on the .empty-state rule that
// globals.css already had and nothing used.
//
// Only for an answer: while the list is still on its way, show a Skeleton.
// "No receipts yet" during a load tells everyone they have none.
//
// Props:
//   title     the short headline ("No cases yet").
//   children  optional explanation under it.
//   action    optional node, usually one .btn or Link.
//   compact   less padding, for an empty state inside a card or a panel.
export default function EmptyState({ title, children, action, compact = false }) {
  return (
    <div className={`empty-state ui-empty${compact ? ' ui-empty-compact' : ''}`}>
      {title && <div className="ui-empty-title">{title}</div>}
      {children && <div className="ui-empty-body">{children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
