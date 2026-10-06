const fs   = require('fs');
const os   = require('os');
const path = require('path');

// The PDF workers open strangers' files: they get none of the server's
// secrets, and what an interrupted read leaves in the temp folder is swept.
describe('pdf/workers', () => {
  const HOUR = 60 * 60 * 1000;
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    jest.restoreAllMocks();
  });

  test('a worker is given what Node needs and none of the server\'s secrets', () => {
    process.env.JWT_SECRET = 'jwt-secret-for-the-test';
    process.env.ENCRYPTION_KEY = 'encryption-key-for-the-test';
    process.env.NODE_ENV = 'test';
    const env = require('./workers').childEnv();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/for-the-test/);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.NODE_ENV).toBe('test');
    if (process.platform === 'win32') expect(env.SystemRoot).toBeTruthy();
  });

  test('both workers are started with that environment, not the server\'s', async () => {
    process.env.JWT_SECRET = 'jwt-secret-for-the-test';
    jest.resetModules();
    const cp = require('child_process');
    const spy = jest.spyOn(cp, 'execFile').mockImplementation((file, args, opts, cb) => { cb(new Error('stopped by the test'), '', ''); });
    const { renderPdfPages } = require('./render');
    const { extractText } = require('./text-extract');
    expect(await renderPdfPages(Buffer.from('%PDF'))).toBeNull();
    await expect(extractText(Buffer.from('%PDF'))).rejects.toThrow(/stopped by the test/);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [, , opts] of spy.mock.calls) {
      expect(opts.env).toBeDefined();
      expect(opts.env.JWT_SECRET).toBeUndefined();
    }
  });

  test('sweepStaleTemp removes our folders older than an hour, and nothing else', () => {
    const { sweepStaleTemp } = require('./workers');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
    const make = (name, ageMs, { dir = true } = {}) => {
      const p = path.join(base, name);
      if (dir) { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'in.pdf'), '%PDF'); } else fs.writeFileSync(p, 'x');
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(p, t, t);
      return p;
    };
    try {
      const oldRender = make('solv-render-aaaaaa', 2 * HOUR);
      const oldText   = make('solv-text-bbbbbb', 2 * HOUR);
      const running   = make('solv-render-cccccc', 60 * 1000);          // a read under way now
      const notOurs   = make('someone-else-dddddd', 2 * HOUR);
      const aFile     = make('solv-render-file', 2 * HOUR, { dir: false });
      expect(sweepStaleTemp({ dir: base })).toBe(2);
      expect(fs.existsSync(oldRender)).toBe(false);
      expect(fs.existsSync(oldText)).toBe(false);
      for (const p of [running, notOurs, aFile]) expect(fs.existsSync(p)).toBe(true);
      // A shorter age can be asked for; a folder that is not there is no error.
      expect(sweepStaleTemp({ dir: base, olderThanMs: 1000 })).toBe(1);
      expect(sweepStaleTemp({ dir: path.join(base, 'missing') })).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('the folders a read makes carry the names the sweep looks for', () => {
    const { tempDir, PREFIX } = require('./workers');
    for (const kind of ['render', 'text']) {
      const dir = tempDir(kind);
      try {
        expect(path.basename(dir).startsWith(PREFIX[kind])).toBe(true);
        expect(path.dirname(dir)).toBe(os.tmpdir());
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
