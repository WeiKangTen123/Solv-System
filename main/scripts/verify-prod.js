const axios = require('axios');

async function testAll() {
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4000';
  console.log(`Verifying production on ${baseUrl}...`);

  // 1. Check Solv server root
  const rootRes = await axios.get(baseUrl);
  console.log(`[PASS] Root endpoint HTTP ${rootRes.status}`);

  // 2. Login as demo user
  const loginRes = await axios.post(`${baseUrl}/api/auth/login`, {
    email: 'demo@example.com',
    password: '***REMOVED***'
  });
  console.log(`[PASS] Demo login successful: ${loginRes.data.user.email} (${loginRes.data.user.role})`);
  const token = loginRes.data.token;
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 3. GET /api/users/me/gemini-keys
  const keysRes = await axios.get(`${baseUrl}/api/users/me/gemini-keys`, { headers: authHeaders });
  console.log(`[PASS] GET /api/users/me/gemini-keys returned ${keysRes.data.keys.length} keys`);

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
    { apiKey: 'AIzaSyTestKeyEncryptedStorage987654321', label: 'Test Production Key' },
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
  const delRes = await axios.delete(`${baseUrl}/api/users/me/gemini-keys/${createdId}`, { headers: authHeaders });
  console.log(`[PASS] DELETE /api/users/me/gemini-keys/${createdId} returned success`);

  // 8. Verify other running apps (ZERO TOUCH constraint)
  const xeroRes = await axios.get('http://127.0.0.1:3000');
  console.log(`[PASS] xero-invoice-app (port 3000) HTTP ${xeroRes.status} untouched`);

  const carlinkRes = await axios.get('http://127.0.0.1:8080');
  console.log(`[PASS] carlink (port 8080) HTTP ${carlinkRes.status} untouched`);

  console.log('\n=== ALL PRODUCTION VERIFICATIONS PASSED ===');
}

testAll().catch(err => {
  console.error('[FAIL] Production verification error:', err.response?.data || err.message);
  process.exit(1);
});
