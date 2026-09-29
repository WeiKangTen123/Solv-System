const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { gitHead, health } = require('./dashboard');

// The commit health reports has to be the one the RUNNING process started
// from, so it is read from the checkout at boot. These pin the reader against
// the shapes a .git directory takes; production reported a commit eight
// behind the code answering, because the environment variable it trusted
// instead survives a plain `pm2 restart`.
describe('routes/dashboard — the commit health reports', () => {
  const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-git-')); });
  const git = files => {
    for (const [p, body] of Object.entries(files)) {
      const f = path.join(root, '.git', p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
  };

  test('a branch whose ref is a loose file', () => {
    git({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${SHA}\n` });
    expect(gitHead(root)).toBe(SHA);
  });

  test('a branch whose ref has been packed', () => {
    git({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n` });
    expect(gitHead(root)).toBe(SHA);
  });

  test('a detached HEAD, which is what a rollback to a deploy tag leaves', () => {
    git({ HEAD: `${SHA}\n` });
    expect(gitHead(root)).toBe(SHA);
  });

  test('no checkout, or a ref that resolves to nothing, is null so the fallback is used rather than a guess', () => {
    expect(gitHead(root)).toBeNull();
    git({ HEAD: 'ref: refs/heads/main\n' });
    expect(gitHead(root)).toBeNull();
  });

  test('this repository reads as a commit', () => {
    expect(gitHead(path.join(__dirname, '..', '..'))).toMatch(/^[0-9a-f]{40}$/);
  });

  test('health answers healthy with a commit string', () => {
    const res = { json: jest.fn() };
    health({}, res);
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: 'healthy', commit: expect.stringMatching(/^[0-9a-f]{40}$|^unknown$/) });
  });
});
