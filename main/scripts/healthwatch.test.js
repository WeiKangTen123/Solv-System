// The health watch: a miss is counted, the second in a row is reported once,
// and the recovery is reported once.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../utils/notify', () => ({ notifyError: jest.fn().mockResolvedValue({ sent: true }) }));

describe('scripts/healthwatch', () => {
  let server, answer, notify, watch;
  beforeEach(async () => {
    jest.resetModules();
    process.env.LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-hw-'));
    // A daily backup taken an hour ago, so these tests are about the health
    // check alone; the late-backup alert has its own test.
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-hw-data-'));
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'backups'));
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'backups', `app-${new Date(Date.now() - 3600000).toISOString().replace(/[:.]/g, '-')}.db`), '');
    answer = { status: 200, body: { status: 'healthy' } };
    server = http.createServer((req, res) => { res.writeHead(answer.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answer.body)); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PORT = String(server.address().port);
    notify = require('../utils/notify'); notify.notifyError.mockClear();
    watch = require('./healthwatch');
  });
  afterEach(async () => { await new Promise(r => server.close(r)); delete process.env.PORT; delete process.env.LOGS_DIR; delete process.env.DATA_DIR; });

  test('a healthy answer is no problem; a 500 or an unhealthy body is', async () => {
    expect(await watch.check()).toBeNull();
    answer = { status: 500, body: { error: 'x' } };
    expect(await watch.check()).toMatch(/500/);
  });

  test('two misses in a row are reported once, and the recovery once', async () => {
    answer = { status: 503, body: {} };
    await watch.main();
    expect(notify.notifyError).not.toHaveBeenCalled();
    await watch.main();
    await watch.main();
    expect(notify.notifyError).toHaveBeenCalledTimes(1);
    expect(notify.notifyError.mock.calls[0][0].context).toMatch(/failed 2 times/);
    answer = { status: 200, body: { status: 'healthy' } };
    await watch.main();
    await watch.main();
    expect(notify.notifyError).toHaveBeenCalledTimes(2);
    expect(notify.notifyError.mock.calls[1][0].context).toMatch(/answers again/);
  });

  // The daily backup's cron line was removed by another app's deploy and no
  // backup was taken for three weeks. Now a late one is said, once a day.
  test('a daily backup more than 36 hours old is reported once a day, and the alert clears when one is taken', async () => {
    const dir = path.join(process.env.DATA_DIR, 'backups');
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    const old = path.join(dir, 'app-2026-10-01T19-00-00-000Z.db');
    fs.writeFileSync(old, '');
    const twoDaysAgo = new Date(Date.now() - 48 * 3600000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    await watch.main();
    await watch.main();
    expect(notify.notifyError).toHaveBeenCalledTimes(1);
    expect(notify.notifyError.mock.calls[0][0]).toMatchObject({ context: 'The daily backup is late', error: expect.stringMatching(/app-2026-10-01.*48 hours old.*backup-daily\.js/) });
    fs.writeFileSync(path.join(dir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`), '');
    await watch.main();
    expect(notify.notifyError).toHaveBeenCalledTimes(1);
    const { checkBackup } = watch;
    expect(await checkBackup({ backupAlertedOn: '2026-10-20' }, notify.notifyError)).toMatchObject({ backupAlertedOn: null });
  });
});
