const { notifyError } = require('./notify');

describe('notifying a failure', () => {
  const realFetch = global.fetch;
  let seen;
  beforeEach(() => {
    seen = [];
    global.fetch = jest.fn(async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; });
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.DEPLOY_NAME;
    delete process.env.DEPLOY_SHA;
  });
  afterEach(() => { global.fetch = realFetch; });

  test('does nothing at all when no webhook is configured', async () => {
    const r = await notifyError({ context: 'FATAL CRASH', error: 'boom' });
    expect(r.sent).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('ignores a webhook that is not an https URL', async () => {
    process.env.SLACK_WEBHOOK_URL = 'http://insecure.example/hook';
    expect((await notifyError({ context: 'x', error: 'y' })).sent).toBe(false);
    process.env.SLACK_WEBHOOK_URL = 'not a url';
    expect((await notifyError({ context: 'x', error: 'y' })).sent).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('posts the context, the error and which deployment it was', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/abc';
    process.env.DEPLOY_NAME = 'solv-prod';
    process.env.DEPLOY_SHA = 'abcdef1234567890';
    const r = await notifyError({ context: 'FATAL CRASH — process exiting', error: 'TypeError: nope' });
    expect(r.sent).toBe(true);
    expect(seen[0].url).toBe('https://hooks.slack.test/abc');
    expect(seen[0].body.text).toContain('FATAL CRASH — process exiting');
    expect(seen[0].body.text).toContain('TypeError: nope');
    expect(seen[0].body.text).toContain('solv-prod');
    expect(seen[0].body.text).toContain('commit abcdef1');       // short sha, not the whole thing
    expect(seen[0].body.text).not.toContain('abcdef1234567890');
  });

  test('truncates a long stack rather than posting the whole thing', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/abc';
    await notifyError({ context: 'x', error: 'E'.repeat(5000) });
    expect(seen[0].body.text.length).toBeLessThan(1800);
  });

  // The caller is a process on its way out. An alert that throws loses the
  // message it was sent to deliver and takes the exit path with it.
  test('never throws when Slack is unreachable or refuses', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/abc';
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(notifyError({ context: 'x', error: 'y' })).resolves.toEqual({ sent: false, reason: 'ECONNREFUSED' });
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    await expect(notifyError({ context: 'x', error: 'y' })).resolves.toEqual({ sent: false, reason: 'Slack answered 404' });
  });
});
