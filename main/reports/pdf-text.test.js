const fs = require('fs');
const { runs, plain, FONTS, _fontFor } = require('./pdf-text');

describe('reports/pdf-text', () => {
  test('Latin, accents and Vietnamese stay one plain string in the body font', () => {
    expect(runs('Café – ‘ok’ ‡ € 12 · Phở Hòa')).toBe('Café – ‘ok’ ‡ € 12 · Phở Hòa');
    expect(runs(null)).toBe('');
  });

  test('Chinese and Japanese go to the Chinese font, run by run, between the Latin around them', () => {
    expect(runs('Ya Kun 亚坤 Kaya')).toEqual(['Ya Kun ', { text: '亚坤', font: 'NotoSansSC' }, ' Kaya']);
    expect(runs('鼎泰豐')).toEqual([{ text: '鼎泰豐', font: 'NotoSansSC' }]);
    expect(runs('ラーメン')).toEqual([{ text: 'ラーメン', font: 'NotoSansSC' }]);
  });

  test('what neither font draws is "?", one per character, never an empty box', () => {
    expect(runs('Lunch 🍜 ok')).toBe('Lunch ? ok');
    expect(plain('สมชาย Somchai')).toBe('????? Somchai');
    expect(_fontFor('\n'.codePointAt(0))).toBe('L');
  });

  test('the font files are in the repository, with their licences', () => {
    for (const fam of Object.values(FONTS)) for (const file of Object.values(fam)) expect(fs.existsSync(file)).toBe(true);
    const dir = require('path').dirname(FONTS.NotoSans.normal);
    expect(fs.readFileSync(`${dir}/OFL-NotoSans.txt`, 'utf8')).toMatch(/SIL Open Font License/);
    expect(fs.readFileSync(`${dir}/OFL-NotoSansSC.txt`, 'utf8')).toMatch(/SIL Open Font License/);
  });
});
