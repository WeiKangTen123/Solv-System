const bcrypt = require('bcryptjs');
const db = require('../db');
const users = require('../store/users');

async function main() {
  const company = db.prepare('SELECT id, name FROM companies LIMIT 1').get();
  if (!company) {
    console.error('No company found in database.');
    process.exit(1);
  }
  console.log('Company found:', company.name, `(${company.id})`);

  const demoEmail = 'demo@example.com';
  const existing = users.findByEmail(demoEmail);

  if (existing) {
    console.log(`User ${demoEmail} exists. Updating password...`);
    await users.setPassword(existing.id, '***REMOVED***');
    users.updateUser(existing.id, { role: 'user' });
    console.log(`Updated ${demoEmail} password to ***REMOVED*** (role: user)`);
  } else {
    console.log(`Creating user ${demoEmail}...`);
    const created = await users.createUser({
      email: demoEmail,
      password: '***REMOVED***',
      role: 'user',
      companyId: company.id,
    });
    console.log(`Created user ${created.email} (${created.id}) with role: ${created.role}`);
  }

  const all = users.getAllUsers(company.id);
  console.log('Current users in company:');
  for (const u of all) {
    console.log(` - ${u.email} [role: ${u.role}] (receipts: ${u.receiptCount}, cases: ${u.claimedCaseCount}/${u.caseCount}, claimed: ${u.claimedCents / 100})`);
  }
}

main().catch(err => {
  console.error('Failed to seed demo user:', err);
  process.exit(1);
});
