const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../llm/gemini-client', () => ({ chatWithTools: jest.fn(), callGemini: jest.fn(), hasKeys: jest.fn(() => !!process.env.Gemini_API_KEY), forgetKeys: jest.fn() }));

describe('routes/assistant', () => {
  let app, users, llm, admin, emp, peer, tokens;
  beforeEach(async () => {
    jest.resetModules();
    process.env.ASSISTANT_PER_HOUR = '3';
    process.env.Gemini_API_KEY = 'test-key';
    require('../db/migrate').run();
    users = require('../store/users'); llm = require('../llm/gemini-client');
    llm.chatWithTools.mockResolvedValue({ role: 'assistant', content: 'Hello.' });
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    peer = await users.createUser({ email: 'p@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, peer].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/assistant', require('./assistant'));
  });
  afterAll(() => { delete process.env.ASSISTANT_PER_HOUR; delete process.env.Gemini_API_KEY; });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });

  test('a conversation is its owner\'s alone, admins included', async () => {
    const r = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'Hi' }).expect(200);
    const id = r.body.conversation.id;
    expect(r.body.message.content).toBe('Hello.');
    const mine = await request(serverFor(app)).get(`/api/assistant/conversations/${id}`).set(as(emp)).expect(200);
    expect(mine.body.messages.map(m => [m.role, m.content])).toEqual([['user', 'Hi'], ['assistant', 'Hello.']]);
    await request(serverFor(app)).get(`/api/assistant/conversations/${id}`).set(as(admin)).expect(404);
    await request(serverFor(app)).get(`/api/assistant/conversations/${id}`).set(as(peer)).expect(404);
    await request(serverFor(app)).post('/api/assistant/chat').set(as(peer)).send({ message: 'Hi', conversationId: id }).expect(404);
    await request(serverFor(app)).delete(`/api/assistant/conversations/${id}`).set(as(admin)).expect(404);
    expect((await request(serverFor(app)).get('/api/assistant/conversations').set(as(admin)).expect(200)).body.conversations).toEqual([]);
    await request(serverFor(app)).delete(`/api/assistant/conversations/${id}`).set(as(emp)).expect(200);
    await request(serverFor(app)).get('/api/assistant/conversations').expect(401);
  });

  test('questions are limited per person per hour, and deleting conversations does not reset it', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: `q${i}` }).expect(200);
      await request(serverFor(app)).delete(`/api/assistant/conversations/${r.body.conversation.id}`).set(as(emp)).expect(200);
    }
    const over = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'again' }).expect(429);
    expect(over.body).toMatchObject({ limit: 3, remaining: 0 });
    await request(serverFor(app)).post('/api/assistant/chat').set(as(peer)).send({ message: 'mine' }).expect(200);   // each person has their own
    const status = await request(serverFor(app)).get('/api/assistant/status').set(as(emp)).expect(200);
    expect(status.body).toMatchObject({ available: true, used: 3, remaining: 0 });
    // Users & Monitoring counts questions, never their content.
    const row = users.getAllUsers(admin.companyId).find(u => u.id === emp.id);
    expect(row.assistantQuestions30d).toBe(3);
  });

  test('bad input, a long message, and a failing model are answered plainly', async () => {
    await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({}).expect(400);
    await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: { $gt: '' } }).expect(400);
    await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'x'.repeat(4001) }).expect(400);
    llm.chatWithTools.mockRejectedValueOnce(Object.assign(new Error('quota'), { response: { status: 429 } }));
    const r = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'hi' }).expect(503);
    expect(r.body.error).toMatch(/out of quota/);
  });

  test('without an LLM key the assistant says how to get one', async () => {
    delete process.env.Gemini_API_KEY;
    const r = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'hi' }).expect(503);
    expect(r.body.error).toMatch(/LLM API Setup/);
    expect((await request(serverFor(app)).get('/api/assistant/status').set(as(emp)).expect(200)).body.available).toBe(false);
    process.env.Gemini_API_KEY = 'test-key';
  });

  test('a card is applied or dismissed only by the person it was made for', async () => {
    const store = require('../store/expenses');
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, status: 'review-needed', merchant: 'Grab', currency: 'SGD', total: 10, receiptDate: '2026-09-04', lines: [{ category: 'Meals', amount: 10 }] });
    llm.chatWithTools
      .mockResolvedValueOnce({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_receipt_changes', arguments: JSON.stringify({ id: e.id, changes: { purpose: 'Airport' }, reason: 'x' }) } }] })
      .mockResolvedValueOnce({ role: 'assistant', content: 'Proposed.' });
    const r = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'add a purpose' }).expect(200);
    const id = r.body.actions[0].id;
    await request(serverFor(app)).post(`/api/assistant/actions/${id}/apply`).set(as(admin)).expect(404);
    await request(serverFor(app)).post(`/api/assistant/actions/${id}/dismiss`).set(as(peer)).expect(404);
    const done = await request(serverFor(app)).post(`/api/assistant/actions/${id}/apply`).set(as(emp)).expect(200);
    expect(done.body.action.status).toBe('applied');
    expect(store.getExpense(e.id).purpose).toBe('Airport');
    await request(serverFor(app)).post(`/api/assistant/actions/${id}/dismiss`).set(as(emp)).expect(409);
  });

  test('a streamed answer arrives as events, ending with the stored message', async () => {
    llm.chatWithTools.mockImplementationOnce(async (uid, msgs, defs, opts) => { opts.onText && opts.onText('Hel'); opts.onText && opts.onText('lo.'); return { role: 'assistant', content: 'Hello.' }; });
    const r = await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'Hi', stream: true }).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const events = r.text.split('\n\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6)));
    expect(events.filter(e => e.type === 'delta').map(e => e.text).join('')).toBe('Hello.');
    expect(events.at(-1)).toMatchObject({ type: 'done', message: { content: 'Hello.' }, conversation: { id: expect.any(String) } });
  });

  test('a question the model could not answer is not counted against the hour', async () => {
    llm.chatWithTools.mockRejectedValueOnce(Object.assign(new Error('quota'), { response: { status: 429 } }));
    await request(serverFor(app)).post('/api/assistant/chat').set(as(emp)).send({ message: 'hi' }).expect(503);
    const status = await request(serverFor(app)).get('/api/assistant/status').set(as(emp)).expect(200);
    expect(status.body.used).toBe(0);
  });
});
