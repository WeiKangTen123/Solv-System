// Express 4 does not catch a rejected async handler, and index.js exits the
// process on an unhandled rejection: one throw in an unwrapped async route
// restarted the server for everyone. Nine routes had slipped through, so the
// rule is checked rather than remembered.
const fs = require('fs');
const path = require('path');

test('every async route handler is wrapped in asyncHandler', () => {
  const bare = [];
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\brouter\.(get|post|put|patch|delete|all)\(/.test(line) && /async\s*\(req/.test(line) && !/asyncHandler\(\s*async/.test(line)) {
        bare.push(`${f}:${i + 1}`);
      }
    });
  }
  expect(bare).toEqual([]);
});
