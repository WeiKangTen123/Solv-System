const META = {
  reading: ['Reading…', 'badge-blue'], 'review-needed': ['Needs review', 'badge-yellow'], reviewed: ['Reviewed', 'badge-green'],
  duplicate: ['Duplicate', 'badge-red'], rejected: ['Rejected', 'badge-red'],
  draft: ['Draft', 'badge-gray'], submitted: ['Submitted', 'badge-blue'], approved: ['Approved', 'badge-green'], paid: ['Paid', 'badge-teal'], posted: ['Posted to Xero', 'badge-green'],
};
export default function StatusBadge({ status }) {
  const [label, cls] = META[status] || [status || '—', 'badge-gray'];
  return <span className={`badge ${cls}`}>{label}</span>;
}
