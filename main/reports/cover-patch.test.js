const { coverPatch } = require('./cover-patch');

// The cover rules the case routes and the assistant's details card share.
describe('reports/cover-patch', () => {
  test('only cover fields pass, trimmed and cut to length; an empty string clears', () => {
    expect(coverPatch({ title: '  India trip  ', purpose: '', nights: '3.6', number: 'EXP-1', status: 'claimed', userId: 'x' }))
      .toEqual({ title: 'India trip', purpose: null, nights: 4 });
    expect(coverPatch({ notes: 'x'.repeat(3000) }).notes).toHaveLength(2000);
    expect(coverPatch({ title: '   ' })).toEqual({ title: null });
    expect(coverPatch(null)).toEqual({});
    expect(coverPatch({ nights: -2 })).toEqual({ nights: null });
  });

  test('words must be text, dates real, the kind one of three, an advance sane', () => {
    expect(() => coverPatch({ title: { a: 1 } })).toThrow('Title must be text');
    expect(() => coverPatch({ periodFrom: '2026-02-30' })).toThrow(/From must be a real date/);
    expect(() => coverPatch({ periodTo: 'soon' })).toThrow(/To must be a real date/);
    expect(coverPatch({ periodFrom: '2030-01-01' })).toEqual({ periodFrom: '2030-01-01' });   // a trip being planned
    expect(() => coverPatch({ kind: 'holiday' })).toThrow('kind must be trip, period or case');
    expect(coverPatch({ kind: 'case' })).toEqual({ kind: 'case' });
    expect(() => coverPatch({ advances: '1e400' })).toThrow(/Advances must be an amount/);
    expect(() => coverPatch({ advances: -1 })).toThrow(/Advances/);
    expect(coverPatch({ advances: 250.5 })).toEqual({ advances: 250.5 });
  });
});
