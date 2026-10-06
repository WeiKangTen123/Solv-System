const db = require('../db');
const users = require('../store/users');

// The password comes from DEMO_PASSWORD, never from this file: the repository
// is public, and a password written here is a password for anyone.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function main() {
  if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 8) {
    console.error('Set DEMO_PASSWORD (at least 8 characters) to seed the demo user.');
    process.exit(1);
  }
  const company = db.prepare('SELECT id, name FROM companies LIMIT 1').get();
  if (!company) {
    console.error('No company found in database.');
    process.exit(1);
  }
  console.log('Company found:', company.name, `(${company.id})`);

  // Clean up any temporary e2e test users
  db.prepare('DELETE FROM users WHERE email LIKE ?').run('tester_e2e_%');

  const demoEmail = 'demo@example.com';
  const existing = users.findByEmail(demoEmail);

  if (existing) {
    console.log(`User ${demoEmail} exists. Updating password...`);
    await users.setPassword(existing.id, DEMO_PASSWORD);
    users.updateUser(existing.id, { role: 'user' });
    console.log(`Updated ${demoEmail} password (role: user)`);
  } else {
    console.log(`Creating user ${demoEmail}...`);
    const created = await users.createUser({
      email: demoEmail,
      password: DEMO_PASSWORD,
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
