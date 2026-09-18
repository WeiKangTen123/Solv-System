const META = {
  reading: ['Reading…', 'badge-blue'], 'review-needed': ['Needs review', 'badge-yellow'], reviewed: ['Reviewed', 'badge-green'],
  duplicate: ['Duplicate', 'badge-red'], rejected: ['Rejected', 'badge-red'],
};
export default function StatusBadge({ status }) {
  const [label, cls] = META[status] || [status || '—', 'badge-gray'];
  return <span className={`badge ${cls}`}>{label}</span>;
}
