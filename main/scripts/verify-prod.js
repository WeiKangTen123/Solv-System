const axios = require('axios');

// The label this script's own key carries, so it removes only what it made.
const TEST_LABEL = 'verify-prod test key';

async function testAll() {
  if (!process.env.VERIFY_PASSWORD) throw new Error('Set VERIFY_PASSWORD (and VERIFY_EMAIL if not the demo account)');
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4000';
  console.log(`Verifying production on ${baseUrl}...`);

  // 1. Check Solv server root
  const rootRes = await axios.get(baseUrl);
  console.log(`[PASS] Root endpoint HTTP ${rootRes.status}`);

  // 2. Login as demo user
  const loginRes = await axios.post(`${baseUrl}/api/auth/login`, {
    email: process.env.VERIFY_EMAIL || 'demo@example.com',
    password: process.env.VERIFY_PASSWORD
  });
  console.log(`[PASS] Demo login successful: ${loginRes.data.user.email} (${loginRes.data.user.role})`);
  const token = loginRes.data.token;
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 3. Clean up test keys a previous run left behind — only those, by their
  // label. It used to delete every personal key on the account it signed in
  // as, real ones included.
  const initialKeys = await axios.get(`${baseUrl}/api/users/me/gemini-keys`, { headers: authHeaders });
  for (const k of initialKeys.data.keys.filter(k => k.label === TEST_LABEL)) {
    await axios.delete(`${baseUrl}/api/users/me/gemini-keys/${k.id}`, { headers: authHeaders });
  }
  console.log(`[PASS] Leftover test keys cleared; ${initialKeys.data.keys.filter(k => k.label !== TEST_LABEL).length} other key(s) untouched`);

  // 4. Test key validation endpoint with mock/test key
  try {
    await axios.post(
      `${baseUrl}/api/users/me/gemini-keys/test`,
      { apiKey: 'AIzaSyFakeKeyForTesting123456789' },
      { headers: authHeaders }
    );
    console.log('[WARN] Mock key test unexpectedly passed');
  } catch (err) {
    console.log(`[PASS] Mock key test rejected as expected: ${err.response?.data?.error || err.message}`);
  }

  // 5. Add a test key
  const addRes = await axios.post(
    `${baseUrl}/api/users/me/gemini-keys`,
    { apiKey: 'AIzaSyTestKeyEncryptedStorage987654321', label: TEST_LABEL },
    { headers: authHeaders }
  );
  const createdId = Number(addRes.data.id);
  console.log(`[PASS] POST /api/users/me/gemini-keys created key ID: ${createdId}`);

  // 6. Verify key is masked
  const verifyKeysRes = await axios.get(`${baseUrl}/api/users/me/gemini-keys`, { headers: authHeaders });
  const savedKey = verifyKeysRes.data.keys.find(k => k.id === createdId);
  if (!savedKey || !savedKey.keyMasked.includes('••••')) {
    throw new Error('Key was not masked properly in output: ' + JSON.stringify(savedKey));
  }
  console.log(`[PASS] Key masked properly: ${savedKey.keyMasked} (label: ${savedKey.label})`);

  // 7. Delete the test key
  await axios.delete(`${baseUrl}/api/users/me/gemini-keys/${createdId}`, { headers: authHeaders });
  console.log(`[PASS] DELETE /api/users/me/gemini-keys/${createdId} returned success`);

  console.log('\n=== ALL PRODUCTION VERIFICATIONS PASSED ===');
}

testAll().catch(err => {
  console.error('[FAIL] Production verification error:', err.response?.data || err.message);
  process.exit(1);
});
