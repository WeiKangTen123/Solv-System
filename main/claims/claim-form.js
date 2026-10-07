const ExcelJS = require('exceljs');
const yauzl   = require('yauzl');
const logger  = require('../utils/logger');
const { num, currencyCode, detectCurrency, CURRENCY_CODES } = require('../intake/document');

// Reads a company expense-claim spreadsheet into rows.
//
// Shaped around the real form this was built against — BLACKSTAR's "EXPENSES
// CLAIM FORM" — but deliberately by HEADER NAME rather than column letter, so a
// form with columns in a different order, or an extra one inserted, still reads.
// Hard-coding B for date would break the first time somebody adds a column.
//
// The claimant fills date, description, currency, amount and exchange rate. In
// the real file every CATEGORY column was left empty, which is the gap the AI
// exists to fill — so the categories are read if present and not required.

// Excel stores dates as days since 1899-12-30 (the epoch is shifted by the
// 1900 leap-year bug Excel deliberately preserves).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// Everything below one of these is the form's footer, not a claim line. Only
// at the START of a cell: the footer's own cells begin "Total", "Claimant:",
// "I declared...", while "Petrol at Total Energies" is a claim line, and used
// to end the form there and drop every row after it.
const FOOTER_MARKERS = /^((grand |sub-?)?total|claimant|signed|i declared|all supporting receipts|for finance purpose|accounts? code)\b/i;

function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  // The whole part is the day and the fraction is the time of day. Rounding
  // took 6pm on the 26th (46079.75) to the 27th.
  const d = new Date(EXCEL_EPOCH_MS + Math.floor(n) * 86400000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// A cell may arrive as a number, a string, a Date, or exceljs's rich-text or
// formula shapes. Everything funnels through here.
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value.richText) return value.richText.map(t => t.text).join('').trim();
  if (value.text) return String(value.text).trim();
  if (value.result !== undefined) return cellText(value.result);
  return String(value).trim();
}

// A date typed as text rather than entered as a date is written day first, as
// in Singapore: "26/02/2026", "26-2-26", "26.02.2026". One that is not a real
// day ("31/02/2026") is no date at all.
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/;
function dmyToISO(text) {
  const m = DMY.exec(String(text || ''));
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function cellDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return excelSerialToISO(value);
  const text = cellText(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(text)) return excelSerialToISO(text);
  return dmyToISO(text);
}

// A figure, through the one cleaner the rest of the app uses: symbols and
// thousands separators go, and a cell with no digit in it is missing rather
// than a real zero, which would let a claim line with no amount match a
// receipt.
function cellNumber(value) {
  return num(typeof value === 'number' ? value : cellText(value));
}

// The currency a cell or a heading names: "SGD", "sgd", "S$", "RM", or
// "Amount (SGD)". A code is taken as written and a symbol is read the way a
// receipt's is. detectCurrency knows "RM" and "Rp" only in front of a figure,
// as they are printed, so the bare symbol is given one. Null when it names no
// currency, so the receipt's own is used: "S$" and "RM" used to be stored as
// the currency itself.
function currencyOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // "US$" holds "S$", which detectCurrency takes for Singapore dollars.
  if (/\bUS\$/i.test(t)) return 'USD';
  const code = currencyCode(t);
  if (code) return code;
  const named = t.toUpperCase().split(/[^A-Z]+/).find(w => CURRENCY_CODES.includes(w));
  return named || detectCurrency(`${t} 1`);
}

// Header matching is loose on purpose: real forms wrap headings onto two lines
// ("LOCAL TRAVEL COST\n(SGD)") and vary in case and punctuation.
function normaliseHeader(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[()]/g, '').trim().toUpperCase();
}

// Each field is known by a pattern rather than one exact heading, because real
// forms say "Amount (S$)", "Amount Claimed" and "Receipt Date". Only "AMOUNT"
// itself used to count: "Amount (SGD)" was taken for the converted figure, so
// every line came through with no amount, and "Amount Claimed" became a
// category. Tried in this order; a heading goes to the first field it names.
const FIELD_HEADERS = [
  ['no',           /^(NO\.?|S\/N|SN|ITEM( NO\.?)?|#)$/],
  ['date',         /\bDATE\b/],
  ['description',  /\b(DESCRIPTION|PARTICULARS|DETAILS)\b/],
  ['currency',     /^(CURRENCY|CCY)\b/],
  ['exchangeRate', /\bRATE\b/],
  ['baseAmount',   /^(SGD|BASE|LOCAL) AMOUNT\b/],
  ['amount',       /^((TOTAL|CLAIM(ED)?) )?(AMOUNT|AMT\.?)\b/],
];

// Columns that are not a kind of spending: they hold a number or an id (a
// receipt number, the GST, a row total) or free text. Taken for categories, a
// numeric receipt number "ticked" every line, so no line was left for the
// model to categorise, and a text column would be offered to it as a category
// it might choose.
const NOT_A_CATEGORY = /\b(NO|NUMBER|REF|REFERENCE|RECEIPT|INVOICE|ID|GST|VAT|TAX|TOTAL|SUBTOTAL|BALANCE|REMARKS?|NOTES?|COMMENTS?|PURPOSE|PROJECT|CLIENT|CUSTOMER|VENDOR|MERCHANT|SUPPLIER|PAYEE|NAME|PAYMENT|PAID|TIME|CODE|ACCOUNTS?|APPROV\w*|SIGN\w*)\b/;

// The field a heading names, given the ones already found: 'seen' for a field
// named a second time, null for anything else. A second amount column beside
// the claimed one is the converted figure.
function fieldOf(norm, cols) {
  const hit = norm && FIELD_HEADERS.find(([, re]) => re.test(norm));
  if (!hit) return null;
  const field = hit[0];
  if (cols[field] === undefined) return field;
  if (field === 'amount' && cols.baseAmount === undefined) return 'baseAmount';
  return 'seen';
}

// Whether a row carries on the header above it rather than starting the claim
// lines: text only, with no figure or date anywhere, and nothing of its own in
// the description column, which a claim line always has (a cell merged down
// from the heading does not count as its own).
function continuesHeader(row, cols) {
  let text = false;
  let figure = false;
  row.eachCell({ includeEmpty: false }, cell => {
    const v = cell.value;
    const shown = v && typeof v === 'object' && 'result' in v ? v.result : v;
    if (typeof shown === 'number' || shown instanceof Date) figure = true;
    else if (cellText(v)) text = true;
  });
  if (figure || !text) return false;
  const own = col => {
    if (!col) return '';
    const cell = row.getCell(col);
    return cell.isMerged && cell.master !== cell ? '' : cellText(cell.value);
  };
  return !own(cols.description) && !cellDate(own(cols.date)) && cellNumber(own(cols.amount ?? cols.baseAmount)) === null;
}

// Finds the header: the first row carrying at least three known field
// headings. Forms carry a title, a company name and a claim period above it, so
// the header is never row 1.
//
// A header can run over two or three rows: a group heading merged across
// several columns ("CATEGORY") with the categories themselves beneath it. A
// merged cell reads as the heading it belongs to, so the categories came out
// as "CATEGORY", "CATEGORY"..., and the row beneath was read as a claim line,
// or, where a sub-heading said "TOTAL", as the end of the form, which then had
// no rows at all. The rows that carry on the header are found so they can be
// skipped, and each column takes its label from the lowest of them that names it.
function locateHeader(sheet, minHits = 3) {
  let top = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (top || rowNumber > 30) return;
    const cols = {};
    const named = new Set();
    let hits = 0;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const field = fieldOf(normaliseHeader(cellText(cell.value)), cols);
      if (!field) return;
      named.add(colNumber);
      if (field !== 'seen') { cols[field] = colNumber; hits++; }
    });
    if (hits >= minHits) top = { rowNumber, cols, named };
  });
  if (!top) return null;
  const { rowNumber, cols, named } = top;

  let lastRow = rowNumber;
  while (lastRow < rowNumber + 2 && continuesHeader(sheet.getRow(lastRow + 1), cols)) lastRow++;

  const labels = new Map();
  for (let r = lastRow; r >= rowNumber; r--) {
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const label = cellText(cell.value).replace(/\s+/g, ' ').trim();
      if (label && !labels.has(col)) labels.set(col, label);
    });
  }
  const categories = [...labels]
    .filter(([col, label]) => {
      if (named.has(col)) return false;
      const norm = normaliseHeader(label);
      return !FIELD_HEADERS.some(([, re]) => re.test(norm)) && !NOT_A_CATEGORY.test(norm);
    })
    .sort((a, b) => a[0] - b[0])
    .map(([col, label]) => ({ col, label }));

  return { rowNumber, lastRow, cols, categories };
}

// A spreadsheet is a zip of XML, and the library opens all of it in memory.
// An 18 MB upload that compresses well can unpack to gigabytes. The sizes the
// zip's directory declares are only what the file says about itself, and the
// library never checks them, so every entry is inflated here first, as a
// stream that keeps nothing, and the real bytes are counted: past the limit it
// stops at once. yauzl also holds each entry to its declared size, so one
// that lies is refused a few kilobytes past what it declared rather than
// inflated to the end. A real claim form is a few hundred kilobytes.
const MAX_UNPACKED_BYTES = 30 * 1024 * 1024;
function unpackedSize(buffer) {
  return new Promise(resolve => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return resolve(null);
      let total = 0;
      let settled = false;
      const settle = value => {
        if (settled) return;
        settled = true;
        zip.close();
        resolve(value);
      };
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return settle(null);
          stream.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_UNPACKED_BYTES) { stream.destroy(); settle(total); }
          });
          // Destroyed as well, or the inflater behind the stream that failed
          // could carry on with nobody reading it.
          stream.on('error', () => { stream.destroy(); settle(null); });
          stream.on('end', () => { if (!settled) zip.readEntry(); });
        });
      });
      zip.on('end', () => settle(total));
      zip.on('error', () => settle(null));
      zip.readEntry();
    });
  });
}

// Returns { rows, categories, title, error }. Never throws: a form that cannot
// be read must degrade to "no rows" so the receipts alone can still be imported.
async function parseClaimForm(buffer) {
  const empty = { rows: [], categories: [], title: null, error: null };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ...empty, error: 'empty file' };
  const size = await unpackedSize(buffer);
  if (size === null) return { ...empty, error: 'not a readable spreadsheet' };
  if (size > MAX_UNPACKED_BYTES) return { ...empty, error: 'the spreadsheet unpacks to far more than a claim form does' };

  let workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
  } catch (err) {
    logger.warn('Claim form could not be opened', { error: err.message });
    return { ...empty, error: 'not a readable spreadsheet' };
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return { ...empty, error: 'no sheets' };

  const header = locateHeader(sheet);
  if (!header) return { ...empty, error: 'no header row found' };

  // A form with no amount column but a converted one ("SGD AMOUNT") is claimed
  // in that: it is read as the amount, in the currency its heading names,
  // ahead of the currency column, which then describes some other figure.
  const cols = { ...header.cols, amount: header.cols.amount ?? header.cols.baseAmount };
  const fromBase = header.cols.amount === undefined && cols.amount !== undefined;
  const headingCurrency = cols.amount ? currencyOf(cellText(sheet.getRow(header.rowNumber).getCell(cols.amount).value)) : null;

  const title = cellText(sheet.getRow(1).getCell(1).value) || null;
  const rows = [];
  let reachedFooter = false;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= header.lastRow || reachedFooter) return;
    const get = field => (cols[field] ? row.getCell(cols[field]).value : null);

    // Real forms end with a totals line, a declaration and a signature block,
    // then a finance-only section. Reading past that turns "I declared the
    // expense claimed above..." into a claim line. Stop at the first marker,
    // on a row that is not itself a claim line.
    const wholeRow = [];
    row.eachCell({ includeEmpty: false }, cell => wholeRow.push(cellText(cell.value)));
    const isLine = !!cellDate(get('date')) || /^\d+(\.0)?$/.test(cellText(get('no')));
    if (!isLine && wholeRow.some(text => FOOTER_MARKERS.test(text))) { reachedFooter = true; return; }

    const amount = cellNumber(get('amount'));
    const description = cellText(get('description'));
    // Blank template lines: the real form carried nine filled rows and dozens of
    // pre-formatted empties, which arrive as amount 0 rather than null because
    // the cell is formatted. Neither an amount nor a description means empty.
    if (!description && (amount === null || amount === 0)) return;

    const ticked = header.categories
      .map(c => ({ label: c.label, value: cellNumber(row.getCell(c.col).value) }))
      .filter(c => c.value !== null && c.value !== 0);
    const typed = currencyOf(cellText(get('currency')));

    rows.push({
      rowNumber,
      no:           cellText(get('no')).replace(/\.0$/, '') || String(rows.length + 1),
      date:         cellDate(get('date')),
      description,
      currency:     fromBase ? (headingCurrency || typed) : (typed || headingCurrency),
      amount,
      exchangeRate: cellNumber(get('exchangeRate')),
      baseAmount:   cellNumber(get('baseAmount')),
      // Empty in the real form — the gap the AI is meant to fill.
      category:     ticked.length === 1 ? ticked[0].label : null,
      categoryAmbiguous: ticked.length > 1,
    });
  });

  const categories = header.categories.map(c => c.label);
  // A header and nothing under it is a form that was read and said nothing,
  // which a person should hear about rather than find out from an empty claim.
  if (!rows.length) return { rows, categories, title, error: 'no claim lines were found under the header' };
  return { rows, categories, title, error: null };
}

module.exports = { MAX_UNPACKED_BYTES, parseClaimForm, locateHeader, excelSerialToISO, cellText, cellDate, cellNumber, currencyOf, normaliseHeader };
