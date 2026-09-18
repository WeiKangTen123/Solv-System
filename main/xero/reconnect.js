// Empty token cache but credentials on file (a restart, say): reconnect by
// whichever method the company last used.
async function reconnectXero(companyId) {
  const { getCompanyConfig } = require('../utils/users');
  const type = getCompanyConfig(companyId).XERO_CONNECTION_TYPE;
  return type === 'oauth' ? require('./oauth').reconnect(companyId) : require('./connect').autoConnect(companyId);
}
module.exports = { reconnectXero };
