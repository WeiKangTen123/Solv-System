// Both ways of connecting an org must ask Xero for the same accounting
// scopes. The lists had drifted: budgets were added to OAuth only, so a
// Custom Connection got insufficient_scope on the whole dashboard and a
// "reconnect" prompt that could not fix it.
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
const { SCOPES } = require('./xero-utils');
const connect = require('./connect');
const oauth   = require('./oauth');

test('one scope list, exactly what posting a claim needs; OAuth adds only offline_access', () => {
  expect(SCOPES.split(' ').sort()).toEqual(['accounting.attachments', 'accounting.contacts', 'accounting.invoices', 'accounting.settings.read']);
  expect(connect.SCOPES).toBe(SCOPES);
  expect(oauth.SCOPES).toBe(`offline_access ${SCOPES}`);
});
