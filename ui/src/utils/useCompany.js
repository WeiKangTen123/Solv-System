import { api } from '../api/client';

// The company's settings, categories and currencies, fetched once a minute at
// most and shared. Every page that showed a category list fetched /company
// on its own, on every visit.
const TTL_MS = 60_000;
let cache = null, at = 0, pending = null;

export function getCompany({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - at < TTL_MS) return Promise.resolve(cache);
  if (!pending) {
    pending = api.get('/company')
      .then(d => { cache = d; at = Date.now(); return d; })
      .finally(() => { pending = null; });
  }
  return pending;
}
// After the company's settings change, the next read goes to the server.
export function forgetCompany() { cache = null; at = 0; }
