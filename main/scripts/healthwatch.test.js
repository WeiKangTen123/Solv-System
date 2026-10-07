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
    answer = { status: 200, body: { status: 'healthy' } };
    server = http.createServer((req, res) => { res.writeHead(answer.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answer.body)); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PORT = String(server.address().port);
    notify = require('../utils/notify'); notify.notifyError.mockClear();
    watch = require('./healthwatch');
  });
  afterEach(async () => { await new Promise(r => server.close(r)); delete process.env.PORT; delete process.env.LOGS_DIR; });

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
});
