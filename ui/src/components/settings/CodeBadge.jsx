// A currency's code in a small box. Not a flag: Windows draws flag emoji as
// two letters in boxes, and the euro has no country.
export default function CodeBadge({ code, size = 'md' }) {
  const big = size === 'lg';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: big ? 46 : 40, height: big ? 26 : 22,
      padding: '0 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)',
      fontFamily: 'var(--font-mono)', fontSize: big ? 12.5 : 11.5, fontWeight: 600, letterSpacing: '.04em', color: 'var(--text-primary)',
    }}>{code}</span>
  );
}
