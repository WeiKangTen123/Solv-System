const { withRetry } = require('./xero-utils');
const { CATEGORY_NAMES } = require('../intake/categories');
const logger = require('../utils/logger');

// Which Xero account a report line lands on, decided by its category against
// the org's OWN chart of accounts, read from Xero. Nothing is hard-coded:
// "429" is General Expenses in one org and something else in the next. No
// match means the company's default account, and failing that Xero's default.
const CATEGORY_HINTS = {
  'Air & Transport':    ['travel - local', 'local travel', 'travel - national', 'transport', 'airfare', 'taxi', 'fares', 'travel'],
  'Lodging':            ['accommodation', 'hotel', 'travel - overseas', 'overseas travel', 'travel - international', 'travel'],
  'Meals':              ['meals', 'staff welfare', 'welfare', 'refreshment', 'entertainment'],
  'Entertainment':      ['client entertainment', 'entertainment', 'hospitality'],
  'Phone':              ['telephone', 'mobile', 'telecom', 'phone', 'internet'],
  'Fuel/Mileage':       ['motor vehicle', 'fuel', 'mileage', 'vehicle', 'petrol', 'transport'],
  'Office Supplies':    ['office supplies', 'office expenses', 'stationery', 'printing & stationery', 'printing'],
  'Software/Utilities': ['software', 'subscriptions', 'it expenses', 'computer', 'utilities'],
  'Medical/Dental':     ['medical', 'dental', 'health'],
  'Other':              ['general expenses', 'sundry', 'miscellaneous', 'other expenses'],
};
for (const name of Object.keys(CATEGORY_HINTS)) {
  if (!CATEGORY_NAMES.includes(name)) throw new Error(`CATEGORY_HINTS names "${name}", which intake/categories.js does not list`);
}

// A claim is a cost: revenue, assets and liabilities are never the answer, and
// an archived account cannot be posted to.
const EXPENSE_TYPES = ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS', 'DEPRECIATN'];
function _usable(a) {
  const status = String(a.status || '').toUpperCase();
  const type   = String(a.type || '').toUpperCase();
  return a.code && (!status || status === 'ACTIVE') && (!type || EXPENSE_TYPES.includes(type));
}

function accountForCategory(category, accounts) {
  const hints = CATEGORY_HINTS[String(category || '').trim()];
  if (!hints || !Array.isArray(accounts) || !accounts.length) return null;
  const usable = accounts.filter(_usable).map(a => ({ code: String(a.code), name: String(a.name || '').toLowerCase() }));
  for (const hint of hints) {
    const exact = usable.find(a => a.name === hint);
    if (exact) return exact.code;
    const partial = usable.find(a => a.name.includes(hint));
    if (partial) return partial.code;
  }
  return null;
}

// The org's chart and tax rates, cached an hour per tenant: directory data that
// changes rarely and is billed on read.
const TTL_MS = 60 * 60 * 1000;
const _cache = new Map();
async function _directory(kind, companyId, tenantId, fetch, { force = false } = {}) {
  const key = `${kind}:${companyId}:${tenantId}`;
  const hit = _cache.get(key);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.value;
  const { AccountingApi } = require('xero-node');
  const token = await require('./token-cache').forCompany(companyId).getValidToken(tenantId);
  const api = new AccountingApi();
  api.accessToken = token;
  const value = await fetch(api);
  _cache.set(key, { at: Date.now(), value });
  return value;
}

async function getAccounts(companyId, tenantId, opts) {
  return _directory('accounts', companyId, tenantId, async api => {
    const res = await withRetry(() => api.getAccounts(tenantId, undefined, undefined, 'Code ASC'));
    const accounts = (res.body.accounts || []).map(a => ({ code: a.code, name: a.name, type: a.type, status: a.status, taxType: a.taxType }));
    logger.info('Xero chart of accounts loaded', { companyId, tenantId, count: accounts.length });
    return accounts;
  }, opts);
}

async function getTaxRates(companyId, tenantId, opts) {
  return _directory('taxrates', companyId, tenantId, async api => {
    const res = await withRetry(() => api.getTaxRates(tenantId));
    return (res.body.taxRates || []).map(r => ({ name: r.name, taxType: r.taxType, status: r.status, displayTaxRate: r.displayTaxRate, canApplyToExpenses: r.canApplyToExpenses }));
  }, opts);
}

module.exports = { accountForCategory, getAccounts, getTaxRates, CATEGORY_HINTS, _cache };
