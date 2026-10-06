// An API key as Settings shows it: its first and last four characters. The
// company and personal key lists each had their own, and they differed.
function maskKey(key) {
  const k = String(key || '');
  return k.length > 8 ? `${k.slice(0, 4)}••••••••${k.slice(-4)}` : '••••';
}

module.exports = { maskKey };
