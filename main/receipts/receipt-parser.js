const logger = require('../utils/logger');
const { imagePart } = require('./image-prep');
const { firstReceipt, readSomething, area, overlapFraction } = require('./parse-result');
const { callGemini } = require('../llm/gemini-client');
const { parseLlmJson } = require('../llm/llm-json');

// Reads a photographed receipt.
//
// The existing invoice parser is text-only: pdf-parse pulls a text layer out of
// a PDF and sends TEXT to Gemini. A photographed receipt has no text layer, so
// that path cannot see it at all. This sends the IMAGE instead.
//
// No new dependency is needed. gemini-client posts to Google's
// OpenAI-compatibility endpoint, which accepts an image_url content part
// carrying a base64 data URI, and _callOnce passes `messages` through
// unchanged — so model rotation, key rotation and quota handling are inherited.
//
// Nothing here reaches Xero.

const { CATEGORIES, canonicalCategory } = require('../intake/categories');

const SYSTEM_PROMPT = `You read photographed shop receipts and return ONLY valid JSON. No explanation, no markdown.

An image may contain MORE THAN ONE receipt (several laid on a desk). Return a JSON
object: { "receipts": [ ... ] } with one entry per DISTINCT receipt. One receipt in
the photo means one entry. Never split a single long receipt into several entries.

For each receipt also return:
- box_2d: the 2D bounding box of that receipt as [ymin, xmin, ymax, xmax], each
  normalised 0-1000 with [0,0] at the top-left of the image. Cover the whole
  receipt and nothing else. Omit it if you cannot locate the receipt confidently.

Per receipt, extract:
- merchant: the shop or business that was PAID (not the customer, not the payment network, not the bank)
- datePrinted: the purchase date exactly as printed (e.g. "10/09/2026", "03.10.2026", "2026年10月15日"), null if none.
- dateOrder: the order the printed date is in: "DMY", "MDY" or "YMD"; null if the month is written as a word or you cannot tell.
  The United States prints the month first (10/09/2026 is 9 October); Singapore, Malaysia, India, Indonesia, the UK,
  Europe and Australia print the day first (10/09/2026 is 10 September); Japan, China and Korea the year first.
- date: YYYY-MM-DD of the purchase, read in that order (null if unreadable)
- time: HH:MM in 24-hour format if printed on the receipt (e.g. "12:01", "16:37", "21:09"), null if not printed.
- currency: 3-letter ISO code read from the receipt (SGD, USD, MYR, GBP, EUR, AUD...), never a symbol. "S$" or PayNow implies SGD; "RM" implies MYR; "Rp" IDR; "RMB" CNY; "£" GBP; "€" EUR. If only a bare "$" appears with no other signal, return null rather than guessing.
- total: the FINAL amount paid, as a plain number. No symbols, no thousands separators. A tip or gratuity is part of
  the amount charged: when a GRAND TOTAL, AMOUNT PAID or card line is larger than the line marked "Total" because a tip
  was added, the total is that larger amount. A refund or return prints a negative total: return it negative.
- tax: the government's tax as a plain number (GST, CGST/SGST/IGST, VAT, SST, PPN, PB1, MwSt, HST/PST, IVA, TVA, a US
  sales tax, 消費税), only if the receipt states it. Never a service charge, a tip, or a city, tourism or hotel levy.
  When the tax is already inside the prices ("GST 9% included", "enth. MwSt", "内消費税"), still give its amount.
  null if not shown. 0 if the receipt says no tax applies.
- subTotal: the pre-tax amount as a plain number, only if explicitly printed. null otherwise.
- invoiceNumber: the invoice, bill, folio or receipt number printed on the document (e.g. "00/000-000001"), null if none.
- category: one of these exact names, judged from what was bought and when:
${CATEGORIES.map(c => `    "${c.name}": ${c.scope}`).join('\n')}
  When nothing on the receipt settles it, use "Other".
- description: WHAT was bought and WHERE, from what is printed, max 200 characters.
  Format: "[Category] <what was bought> @ <Merchant> (<HH:MM>)". For a ride, put
  "<pickup> to <dropoff>" in place of what was bought when both are printed,
  e.g. "[Air & Transport] Orchard Rd to Changi Airport @ Grab (08:08)".
  "[Meals] Lunch for 2 @ Dong Seoul Supply (12:01)" is right.
  "Client lunch to discuss the project" is wrong, because the receipt does not say so.
  Do not invent a business purpose, a client, a meeting or a reason — the claimant
  adds that when they review. Do not add a place that is not printed.
- city: the city the money was spent in, as printed on the receipt (the merchant's
  address, the hotel's location, a ride's pickup), e.g. "Mumbai", "Kuala Lumpur".
  null when no city is printed. Never guess one from a chain's name.
- country: the ISO 3166-1 alpha-2 code of the country the money was spent in
  (SG, MY, IN, ID, TH, AU, GB, US...), ONLY when the receipt prints it or makes it
  plain: the address names the country or a city in it, the phone number has the
  country's code (+65 SG, +60 MY, +91 IN), or the tax is named for it (a Singapore
  GST registration number with a UEN means SG; CGST, SGST, IGST or a GSTIN means
  IN; SST means MY). null otherwise. A currency alone does not settle the country.
- docType: what kind of document this is, exactly one of:
    "hotel": a hotel or serviced-apartment bill, folio or booking receipt
    "flight": an air ticket, airline receipt or boarding pass
    "ride": a taxi, ride-hailing (Grab, Gojek, Uber), train, bus or ferry fare
    "meal": a restaurant, café, bar or food-delivery receipt
    "fuel": a petrol or charging station receipt
    "parking": a car park or parking receipt
    "telco": a phone, mobile data or internet bill
    "other": anything else
- lineItems: array of each individual charge listed on the receipt with its price:
    [
      {
        "description": the item, dish or charge as printed. On a hotel folio copy the WHOLE description of the line, including the
          text printed under it (room number, check number, and any transfer such as "[NA Room] LIM WEI JIE #126=>Rahman #110"),
          even when that text continues at the top of the next page,
        "unitAmount": the price of ONE unit as a plain number (e.g. 1.60),
        "quantity": item quantity if shown (e.g. 1, 6), default 1,
        "lineTotal": the amount printed on that line (quantity × unit price, e.g. 9.60); same as unitAmount when quantity is 1. A discount, promotion or rounding down is NEGATIVE (e.g. -3.45),
        "discountRate": discount percent if shown, default 0,
        "category": one of the category names above, judged from what THIS line is for. A tax, GST/VAT, service-charge or fee line takes the category of the charge it belongs to (a room's GST is Lodging, a cafe's GST is Meals). On a hotel folio a room is Lodging whatever its rate is called ("Standard Retail", "Package", "BAR", "Corporate"),
        "onBehalfOf": when the line was transferred from, or paid for, ANOTHER guest or person, that person's name exactly as printed (e.g. "LIM WEI JIE #126 => Rahman #110" means the line is for LIM WEI JIE); a tax line under a transferred charge is for the same person; otherwise null
      }
    ]
  Include EVERY charge line: each item, service charge, tip, surcharge, levy, discount and rounding, and each tax that is
  ADDED to the prices, so the lines add up to the total. Do not list a tax that is already inside the prices (printed as
  "incl.", "included", "inkl.", "enth.", "内税"); give it as tax only. Never list a payment (cash handed over, change,
  the card), the subtotal or the total as a line.
- confidence: "high" if the total and merchant are clearly legible, "low" if the photo is blurred, cropped, or you are guessing any of them.

Rules:
- Never invent a value. Anything you cannot read is null.
- total is the amount actually charged, after discounts and including tax and any tip.
- If several totals appear (subtotal, tax, total, cash tendered, change), pick the amount CHARGED, never the cash tendered.
- A card slip or payment terminal stub belonging to a receipt beside it is NOT a separate receipt.
- If you are unsure whether something is a second receipt, return one entry rather than two.`;

// Number, date and currency cleaning are shared with every other intake path;
// see intake/document.js for why a value is dropped rather than coerced.
const _intake = require('../intake/document');
const _num     = _intake.num;
const _isoDate = _intake.isoDate;
function _time(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2];
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

const _currency = _intake.currencyCode;
// A hotel prints a transferred charge as "LIM WEI JIE #126=>Rahman Aisha #110":
// the person before the arrow is who the line is really for. Read from the
// description when the model left it out; when the model answered, keep the
// name and drop the room numbers and the arrow.
const TRANSFER_RE = /([A-Z][A-Za-z.'\- ]{2,60}?)\s*#\d+\s*=>/;
// "Accomodation Charges -[NA Room] Lim Wei Jie #1155=>Rahman Aisha #1159"
// → "Accomodation Charges -[NA Room]". Once the person is on the line the
// rest — two room numbers and an arrow — is noise on the printed report. A
// description that is nothing but the transfer is left as it was.
const TRANSFER_TAIL_RE = new RegExp(`\\s*-?\\s*${TRANSFER_RE.source}.*$`);
function _withoutTransfer(description) {
  const cleaned = String(description || '').replace(TRANSFER_TAIL_RE, '').trim();
  return cleaned || description;
}
// A folio's description runs over two or three printed lines, and the
// reader keeps the breaks: "... [pbhun211] TAN SUAN\nKUAN #126=>Khoo #110"
// named the guest "Kuan", and his meals went on a second person. A
// description is one line of text.
const _oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
function _onBehalf(li) {
  const printed = typeof li.description === 'string' ? TRANSFER_RE.exec(_oneLine(li.description)) : null;
  if (printed) return _titleCase(printed[1].trim().slice(0, 80));
  if (typeof li.onBehalfOf !== 'string' || !li.onBehalfOf.trim()) return null;
  const cleaned = li.onBehalfOf.split(/=>|#|\(/)[0].trim();
  return cleaned ? _titleCase(cleaned.slice(0, 80)) : null;
}

const lineKinds = require('./line-kinds');
const _cents = v => Math.round(Number(v || 0) * 100);
const _sum = items => items.reduce((s, li) => s + _cents(li.unitAmount), 0);

// A folio ends with the payment that settled it ("Manual MasterCard / Euro
// Card 88,188.77"). That is not a charge: kept, it doubles the sum of the
// lines. Payment lines go (line-kinds.js says which), and so do the subtotal
// and total printed as lines. A line equal to the total goes too, but only
// when the others already add up to it: a room of 200.00 beside "Service
// charge 0.00" on a bill of 200.00 was the bill, and used to be dropped as a
// restated total, leaving the bill with nothing but the 0.00.
function _dropPayments(lineItems, total) {
  const kept = lineItems.filter(li => !lineKinds.paymentLine(li.description) && !lineKinds.totalLine(li.description));
  if (total === null || kept.length < 2) return kept;
  const totalCents = _cents(total);
  const at = kept.findIndex(li => _cents(li.unitAmount) === totalCents);
  if (at < 0) return kept;
  const others = kept.filter((li, i) => i !== at);
  return _itemsAccountForTotal(others, total) ? others : kept;
}

// A tax already inside the prices, listed as a line as well ("GST 9% (incl.)"
// under a hawker's 13.80, "enth. MwSt 7%" under a Berlin hotel's 402.00),
// counts the tax twice: the lines came to more than was paid and the reader
// took the difference off the largest. When the other lines add up to the
// total without it, it leaves the lines; its amount is still the tax. Tax
// lines not marked as included go the same way when the lines add up only
// without them, since a tax that was added cannot do that.
function _dropIncludedTax(lineItems, total) {
  if (total === null || lineItems.length < 2) return lineItems;
  const t = _cents(total);
  const close = items => Math.abs(_sum(items) - t) <= Math.max(2, Math.round(t * 0.005));
  if (close(lineItems)) return lineItems;
  const kinds = lineItems.map(li => lineKinds.taxLine(li.description));
  const notIncluded = lineItems.filter((li, i) => !(kinds[i] && kinds[i].included));
  if (notIncluded.length && notIncluded.length < lineItems.length && close(notIncluded)) return notIncluded;
  const noTax = lineItems.filter((li, i) => !kinds[i]);
  if (noTax.length && noTax.length < lineItems.length && close(noTax)) return noTax;
  return lineItems;
}

// A tip written in under the printed "Total" is part of what was charged.
// When the lines hold a tip and come to the total read plus that tip, the
// total read was the one before the tip, and the amount charged is larger.
function _withTip(lineItems, total) {
  if (total === null) return total;
  const tip = lineItems.filter(li => lineKinds.tipLine(li.description) && li.unitAmount > 0).reduce((s, li) => s + _cents(li.unitAmount), 0);
  if (!tip) return total;
  const sum = _sum(lineItems), t = _cents(total);
  return Math.abs(sum - t) > 1 && Math.abs(sum - (t + tip)) <= 1 ? (t + tip) / 100 : total;
}

// A folio prints a transferred charge with the transfer under it, and the
// taxes on that charge under that, each with its own copy of the transfer.
// Except where a page ends between them: the Pune folio's CGST of 940.50 sits
// at the foot of page 1 and its transfer at the head of page 2, and the 940.50
// went on the wrong person. A tax line that names nobody belongs to the
// person of the charge it follows.
function _carryTransfers(items) {
  let charge = null;
  for (const li of items) {
    if (!lineKinds.taxLine(li.description)) { charge = li; continue; }
    if (!li.onBehalfOf && charge && charge.onBehalfOf) li.onBehalfOf = charge.onBehalfOf;
  }
}

// A hotel folio holds rooms, meals and the odd taxi or laundry. A line the
// reader put in Office Supplies, Software/Utilities or Medical/Dental is not
// that: the Pune folio's room rate is called "Standard Retail", and was read
// as a shop's. It takes the receipt's own category.
const NOT_ON_A_FOLIO = new Set(['Office Supplies', 'Software/Utilities', 'Medical/Dental']);

// ── Dates ───────────────────────────────────────────────────────────────────
//
// "10/09/2026" is 9 October in San Francisco and 10 September in Singapore.
// The model is asked for the date as printed and the order its country
// prints dates in; read in that order, the printed numbers settle the date
// whatever the model made of them. The United States prints the month first
// whatever the model says. Only the order is corrected: a printed date that
// is not the model's date with day and month swapped (a folio's arrival day
// against its bill date) leaves the model's date alone.
const MONTH_FIRST = new Set(['US']);
function _dateOrder(value) {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ['DMY', 'MDY', 'YMD'].includes(s) ? s : null;
}
function _printedParts(printed) {
  const m = String(printed || '').match(/(\d{1,4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/);
  return m ? [m[1], m[2], m[3]] : null;
}
function _date(parsed, country) {
  const read = _isoDate(parsed.date);
  const parts = _printedParts(parsed.datePrinted);
  if (!parts || parts[0].length === 4) return read;
  const order = MONTH_FIRST.has(country) ? 'MDY' : _dateOrder(parsed.dateOrder);
  if (order !== 'MDY' && order !== 'DMY') return read;
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  const [m, d] = order === 'MDY' ? [parts[0], parts[1]] : [parts[1], parts[0]];
  const printed = _isoDate(`${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  if (!printed || !read) return printed || read;
  const swapped = `${read.slice(0, 4)}-${read.slice(8, 10)}-${read.slice(5, 7)}`;
  return printed === read || printed === swapped ? printed : read;
}

// Where and what. A case is named and dated from these (a trip to Mumbai, a
// month of fuel), so a value the model made up would name it wrongly: an
// unknown kind of document, or a country that is not two letters, is nothing.
const DOC_TYPES = new Set(['hotel', 'flight', 'ride', 'meal', 'fuel', 'parking', 'telco', 'other']);
function _docType(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DOC_TYPES.has(s) ? s : null;
}
function _country(value) {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(s) ? s : null;
}
function _city(value) {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, 80) : null;
}

// Names are printed in whatever case the hotel's system uses; one colleague
// must group as one line whichever folio the charge came from.
function _titleCase(name) {
  return name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

// Indian and other tax lines are printed per charge. When the document's own
// tax figure is missing (or a "VAT 0.00" footer was read as the tax), the tax
// is the sum of the tax lines. Which lines are tax is line-kinds.js's call:
// a tax's own name at the start of the line, never a levy or "tax-free".
// A service charge is not one of them: it goes to the restaurant, not the
// government. Counted as tax, a Singapore bill of 100.00 food, 10.00 service
// and 9.90 GST went to Xero with 19.90 of tax.
function _taxFromLines(taxLines, total) {
  const cents = _sum(taxLines);
  if (cents <= 0) return null;
  if (total !== null && cents >= _cents(total)) return null;
  return cents / 100;
}

// Do the items, tax lines included, add up to the total? Within a unit or
// half a percent, which is the rounding a folio's per-charge taxes carry
// (the JW folio itemises to one rupee over). When they do, the itemisation
// is complete and can be held against the model's summary figures; when
// they do not, something is missing and nothing is inferred from them.
function _itemsAccountForTotal(lineItems, total) {
  if (total === null || lineItems.length < 2) return false;
  const sum = lineItems.reduce((s, li) => s + Math.round(Number(li.unitAmount || 0) * 100), 0);
  return Math.abs(sum - Math.round(total * 100)) <= Math.max(100, Math.round(total * 0.005));
}

// Normalises whatever the model returned into the shape the invoice store uses.
// Exported for testing: this is where a bad model response is made harmless.
function normalise(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const total = _num(parsed.total);
  const tax   = _num(parsed.tax);
  let   sub   = _num(parsed.subTotal);

  // Only a listed category survives; a reworded one is mapped back, an
  // invented one is dropped and never prefixed onto the description.
  const category = canonicalCategory(parsed.category);
  const docType  = _docType(parsed.docType);
  const country  = _country(parsed.country);
  const folio    = docType === 'hotel' || (!docType && category === 'Lodging');

  // One normaliser for every reader (intake/document.js): the stored amount is
  // the LINE total and a quantity rides in the text. Receipts carry no tax
  // percent per line, and the store's shape has none.
  const rawItems = (Array.isArray(parsed.lineItems) ? parsed.lineItems : [])
    .map(li => {
      const n = _intake.normaliseLineItem(li);
      if (!n) return null;
      const onBehalfOf = li ? _onBehalf(li) : null;
      let lineCategory = canonicalCategory(li && li.category);
      if (folio && NOT_ON_A_FOLIO.has(lineCategory)) lineCategory = category;
      const text = _oneLine(n.description);
      return {
        description:  (onBehalfOf ? _withoutTransfer(text) : text).slice(0, 200),
        unitAmount:   n.unitAmount,
        discountRate: n.discountRate,
        category:     lineCategory,
        onBehalfOf,
      };
    })
    .filter(Boolean);
  if (folio) _carryTransfers(rawItems);

  // A refund is not claimed here. A negative total is one, and so is a
  // receipt whose every charge is negative, whatever sign the total was
  // read with. A zero total tells the user nothing. Neither is an amount.
  const charges = rawItems.filter(li => li.unitAmount !== 0);
  const refund = (total !== null && total < 0) || (charges.length > 0 && charges.every(li => li.unitAmount < 0));
  let usableTotal = !refund && total !== null && total > 0 ? total : null;
  const kept = _dropPayments(rawItems, usableTotal);
  usableTotal = _withTip(kept, usableTotal);

  let desc = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 250) : null;
  if (desc && category && !desc.startsWith('[')) {
    desc = `[${category}] ${desc}`.slice(0, 250);
  }

  // Tax cannot exceed the total; if it does, one of the two was misread and
  // neither should be presented as fact.
  const taxLines = kept.filter(li => lineKinds.taxLine(li.description));
  const fromLines = _taxFromLines(taxLines, usableTotal);
  let taxOut = (tax !== null && tax > 0 && (usableTotal === null || tax <= usableTotal)) ? tax : (fromLines ?? (tax === 0 ? 0 : null));
  // The model's one tax figure against its own itemised tax lines. When the
  // items account for the whole total, every tax line is there, and a tax
  // figure that disagrees with their sum is the model summarising badly: the
  // same folio read twice gave 6760 and then 3717, against tax lines that
  // summed to 6760 both times. The itemised figures are read one at a time
  // off the page; the summary is the one to doubt. One tax line is not that
  // evidence: it is usually the very figure the model read, and a single
  // line misread as tax used to replace a right answer.
  if (fromLines !== null && taxOut !== null && taxLines.length >= 2 && _itemsAccountForTotal(kept, usableTotal) && Math.abs(fromLines - taxOut) > Math.max(1, fromLines * 0.01)) {
    taxOut = fromLines;
  }
  // A tax figure that is the tax lines plus the service charge printed beside
  // them is the service charge counted as tax: a Kuala Lumpur bill with SST
  // of 1.58 and a service charge of 2.39 was read as 3.97 of tax.
  const service = kept.filter(li => lineKinds.serviceLine(li.description) && li.unitAmount > 0).reduce((s, li) => s + _cents(li.unitAmount), 0);
  if (fromLines !== null && tax !== null && service > 0 && Math.abs(_cents(tax) - (_cents(fromLines) + service)) <= 1) taxOut = fromLines;
  const lineItems = _dropIncludedTax(kept, usableTotal);

  // Singapore receipts print "Sub Total 16.10 / GST 1.33" where the GST is
  // already inside the sub total. A subtotal equal to the total with a tax
  // beside it is that case: the pre-tax figure is total − tax. Worked out
  // from the tax as it finally stands, not the model's first figure: a tax
  // taken from the lines left the subtotal at the total.
  if (sub !== null && total !== null && taxOut !== null && taxOut > 0 && Math.abs(sub - total) < 0.005) {
    sub = Math.round((total - taxOut) * 100) / 100;
  }

  const pages = _pages(parsed.pages);
  const datePrinted = typeof parsed.datePrinted === 'string' && parsed.datePrinted.trim() ? parsed.datePrinted.trim().slice(0, 40) : null;
  const dateOrder = _dateOrder(parsed.dateOrder);
  return {
    merchant:    typeof parsed.merchant === 'string' && parsed.merchant.trim() ? parsed.merchant.trim().slice(0, 120) : null,
    invoiceNumber: typeof parsed.invoiceNumber === 'string' && parsed.invoiceNumber.trim() ? parsed.invoiceNumber.trim().slice(0, 60) : null,
    date:        _date(parsed, country),
    time:        _time(parsed.time),
    category,
    currency:    _currency(parsed.currency),
    total:       usableTotal,
    tax:         taxOut,
    subTotal:    sub !== null && sub >= 0 && (usableTotal === null || sub <= usableTotal) ? sub : null,
    description: desc,
    city:        _city(parsed.city),
    country,
    docType,
    lineItems,
    confidence:  parsed.confidence === 'high' ? 'high' : 'low',
    box:         _box(parsed.box_2d),
    // Only the pages of a scan are asked which pages they are on
    // (parseReceiptPages); nothing else carries the field.
    ...(pages ? { pages } : {}),
    // How the date was printed, for the read-time check of a date that reads
    // two ways (read-receipt.js), and a refund, which applyRead says is one.
    ...(datePrinted ? { datePrinted } : {}),
    ...(dateOrder ? { dateOrder } : {}),
    ...(refund ? { refund: true } : {}),
  };
}

// The page numbers a receipt is printed on, 1-based. Anything malformed
// becomes null, which stops that document from being split out.
function _pages(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const n = value.map(v => Number(v));
  if (n.some(p => !Number.isInteger(p) || p < 1)) return null;
  return [...new Set(n)].sort((a, b) => a - b);
}

// Normalises a whole response. Accepts both shapes: { receipts: [...] } and a
// bare single object, because a model asked for an array will still sometimes
// return one object and that must not be treated as a failure.
function normaliseMany(parsed) {
  const list = Array.isArray(parsed?.receipts) ? parsed.receipts
             : Array.isArray(parsed)           ? parsed
             : parsed && typeof parsed === 'object' ? [parsed]
             : [];
  const receipts = list.map(normalise).filter(Boolean);
  if (!receipts.length) {
    // "No receipt here", said as an empty list, is an answer: a blank page or a
    // photo of the desk. It used to be taken for a bad shape and asked again,
    // a second call to hear it twice. A list of unusable entries is still bad.
    const saidNone = !list.length && (Array.isArray(parsed) || Array.isArray(parsed?.receipts));
    return saidNone ? { receipts: [], split: false, reason: 'no receipt' } : null;
  }
  return { receipts, ...splittable(receipts) };
}

// A box is [ymin, xmin, ymax, xmax] normalised 0-1000. Anything malformed
// becomes null, which stops that receipt from being split out.
function _box(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const n = value.map(v => Number(v));
  if (n.some(v => !Number.isFinite(v) || v < 0 || v > 1000)) return null;
  const [ymin, xmin, ymax, xmax] = n;
  if (ymax <= ymin || xmax <= xmin) return null;
  return [ymin, xmin, ymax, xmax];
}

const _area = area;
const _overlapFraction = overlapFraction;

// The smallest slice of the frame a real receipt could plausibly occupy. Below
// this it is far more likely to be a stray box than a document.
const MIN_BOX_AREA = 0.02 * 1000 * 1000;   // 2% of the image
// Above this the model has almost certainly cut one receipt in half.
const MAX_BOX_OVERLAP = 0.25;

// Decides whether a multi-receipt read is trustworthy enough to split on
// WITHOUT asking. Auto-splitting is only safe when the evidence is unambiguous;
// anything doubtful falls back to a single record holding the whole image,
// because inventing a second receipt is worse than not splitting one.
//
// Exported and tested directly — this function is the whole safety argument.
function splittable(receipts) {
  if (!Array.isArray(receipts) || receipts.length < 2) return { split: false, reason: 'single' };

  const boxes = receipts.map(r => r.box);
  if (boxes.some(b => !b)) return { split: false, reason: 'a receipt has no usable box' };
  if (boxes.some(b => _area(b) < MIN_BOX_AREA)) return { split: false, reason: 'a box is too small to be a receipt' };

  // Every receipt needs SOMETHING identifying, or it is probably not a receipt.
  if (receipts.some(r => !r.merchant && r.total === null)) {
    return { split: false, reason: 'a detected receipt has neither a merchant nor a total' };
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (_overlapFraction(boxes[i], boxes[j]) > MAX_BOX_OVERLAP) {
        return { split: false, reason: 'boxes overlap, so one receipt may have been cut in half' };
      }
    }
  }
  return { split: true, reason: null };
}


// Reads a receipt image. Returns a normalised record, or null if it could not
// be read — never throws at the caller, because a parse failure must not lose
// the receipt. See routes/receipts.js.
async function parseReceiptImage(userId, buffer, mime, { maxAttempts = 2 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  return _readImage(userId, await imagePart(buffer, mime), maxAttempts);
}
// The same read, of an image already prepared for the model.
function _readImage(userId, part, maxAttempts = 2) {
  return _readWith(userId, [
    { type: 'text', text: 'Read this receipt and return the JSON described.' },
    part,
  ], maxAttempts);
}

// A PDF with a text layer is read from that text. Same prompt, same
// normaliser, no image: the model cannot place a box on text, so box_2d is
// simply absent and a text PDF is never split by region (pages do that).
const MAX_TEXT_CHARS = 20000;
async function parseReceiptText(userId, text, { maxAttempts = 2 } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return null;
  return _readWith(userId,
    `Read this receipt text (extracted from a PDF, so there is no image and no box_2d) and return the JSON described.\n\n${body.slice(0, MAX_TEXT_CHARS)}`,
    maxAttempts);
}

// The pages of a scanned PDF. Usually ONE document: a hotel folio, a
// multi-page invoice. Read together, so the total on the last page and the
// lines on the first belong to one receipt.
//
// Sometimes not: a scan of three taxi receipts, one to a page, used to come
// back as the first ride with the other two dropped without a word. Pages that
// are plainly separate documents now come back as one entry each, with the
// pages it is printed on, and are kept apart only on the evidence
// separateDocuments() asks for. Anything doubtful stays one document, and
// every entry the model gave is still in the answer for the caller to count.
//
// ONE page is different: it is read like a photo, and a scanned page can hold
// several receipts laid side by side. Whether that split is safe is
// splittable()'s call, exactly as for a photo.
async function parseReceiptPages(userId, pages, { maxAttempts = 2 } = {}) {
  const list = (pages || []).filter(p => p && Buffer.isBuffer(p.buffer) && p.buffer.length);
  if (!list.length) return null;
  if (list.length === 1) return parseReceiptImage(userId, list[0].buffer, list[0].mime, { maxAttempts });
  const content = [{ type: 'text', text:
    `These ${list.length} images are the PAGES of a scanned PDF, in order. Usually they are ONE document (a hotel folio, an invoice or a statement): ` +
    `then read them together as a single receipt and return { "receipts": [ one entry ] }: one merchant, one invoiceNumber, ` +
    `one total (the final amount charged, usually on the last page), one currency, EVERY line item from EVERY page, and no box_2d. ` +
    `Never return one entry per page of one document. ` +
    `Only when the pages are plainly SEPARATE documents, with a different merchant or a different receipt or invoice number, return one entry per document. ` +
    `Give every entry "pages": the page numbers it is printed on, e.g. [1] or [2, 3].` }];
  for (let i = 0; i < list.length; i++) {
    content.push({ type: 'text', text: `Page ${i + 1} of ${list.length}:` });
    content.push(await imagePart(list[i].buffer, list[i].mime));
  }
  const result = await _readWith(userId, content, maxAttempts, { maxTokens: PAGES_MAX_TOKENS });
  // Nothing read, nothing there, or the reader out of reach: said as it is.
  if (!result || !result.receipts.length) return result;
  // A box on one page of several places nothing.
  const receipts = result.receipts.map(r => ({ ...r, box: null }));
  if (receipts.length === 1) return { receipts, split: false, reason: 'pages of one document' };
  return { receipts, ...separateDocuments(receipts, list.length) };
}

// Are these entries from the pages of one scan separate documents? Only when
// each names pages that exist, no page is claimed twice, each has a merchant
// or a total, and every two differ in merchant or in receipt number — the
// same evidence sameDocument() (pdf/pages.js) takes for typed pages. Splitting
// one folio into two would invent a receipt; anything doubtful is one
// document. Exported and tested directly.
function separateDocuments(receipts, pageCount) {
  if (!Array.isArray(receipts) || receipts.length < 2) return { split: false, reason: 'single' };
  const pages = receipts.map(r => r.pages);
  if (pages.some(p => !p || p.some(n => n > pageCount))) return { split: false, reason: 'an entry does not say which pages it is on' };
  const all = pages.flat();
  if (new Set(all).size !== all.length) return { split: false, reason: 'two entries claim the same page' };
  if (receipts.some(r => !r.merchant && r.total === null)) return { split: false, reason: 'an entry has neither a merchant nor a total' };
  // "Grab" and "Grab Singapore" are one merchant; "Grab" and "Gojek" are two.
  // A number is another number unless it is the same one.
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const otherMerchant = (a, b) => !!(key(a) && key(b) && !key(a).includes(key(b)) && !key(b).includes(key(a)));
  const otherNumber = (a, b) => !!(key(a) && key(b) && key(a) !== key(b));
  for (let i = 0; i < receipts.length; i++) {
    for (let j = i + 1; j < receipts.length; j++) {
      const [a, b] = [receipts[i], receipts[j]];
      if (!otherMerchant(a.merchant, b.merchant) && !otherNumber(a.invoiceNumber, b.invoiceNumber)) {
        return { split: false, reason: 'two entries may be one document' };
      }
    }
  }
  return { split: true, reason: null };
}

// Output budgets. Every line item is sixty-odd tokens of JSON and a folio for
// a week runs to fifty of them; at the old 3,000 a forty-line stay was on the
// edge, and past it the reply was cut off, failed to parse, and the receipt
// landed blank. The model's own ceiling is far above these, and an unused
// budget costs nothing — only the tokens actually written are billed.
const READ_MAX_TOKENS  = 8000;
const PAGES_MAX_TOKENS = 12000;
const CEILING_TOKENS   = 32000;

// One attempt loop for both readers: a transient model error or an unusable
// shape earns a second try, then the receipt is left for the user. A reply
// cut off mid-JSON gets its second try with twice the room, since the same
// budget would be cut off in the same place.
//
// A read whose last attempt found every key and model cooling down or out of
// quota is not "could not read this receipt": the reader never saw it. It
// comes back as an empty read marked unavailable, so the receipt can say so
// and the person knows to press Re-read later rather than type it all.
async function _readWith(userId, userContent, maxAttempts, { maxTokens = READ_MAX_TOKENS } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContent },
  ];
  let budget = maxTokens;
  let unavailable = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    unavailable = false;
    try {
      const content = await callGemini(userId, messages, { temperature: 0, maxTokens: budget });
      const result  = normaliseMany(parseLlmJson(content));
      if (result) return result;
      logger.warn('Receipt parse returned an unusable shape', { userId, attempt });
    } catch (err) {
      if (err.truncated) budget = Math.min(budget * 2, CEILING_TOKENS);
      unavailable = _outOfReach(err);
      logger.warn('Receipt parse attempt failed', { userId, attempt, error: err.message, ...(err.truncated ? { nextMaxTokens: budget } : {}) });
      // Asking again cannot help when the request itself was refused, no key
      // is set, or every key and model is out of quota (the client has
      // already tried them all): it only spends another call.
      if (!err.truncated && _hopeless(err)) break;
    }
  }
  return unavailable ? { receipts: [], split: false, reason: 'the reader could not reach the AI service', unavailable: true } : null;
}
function _hopeless(err) {
  const status = err && err.response && err.response.status;
  return [400, 401, 403, 404, 429].includes(status) || /No Gemini API key/.test(String(err && err.message));
}
// What the client throws once every key and model has answered 429 (out of
// quota) or 503 (busy), or all of them are cooling down from having done so.
function _outOfReach(err) {
  const status = err && err.response && err.response.status;
  return status === 429 || status === 503;
}


// ── Reading several receipts in one call ────────────────────────────────────
//
// One call per receipt means a nine-receipt claim is nine round trips, each
// throttled to stay inside the per-minute quota — minutes of waiting for work
// the model could do together. Batching sends several images in one request.
//
// The risk is attribution: the model returning the right figures against the
// wrong image. So each image is numbered in the prompt, the reply must carry
// that number back, and a reply whose count does not match the batch is
// DISCARDED and the batch re-read one at a time. Faster when it works, exactly
// as accurate as before when it does not.
const BATCH_SIZE = 5;

function _batchPrompt(count) {
  return `You are reading ${count} SEPARATE receipts. They are unrelated to each other.

Return ONLY a JSON array with exactly ${count} entries, one per image, in the order given:
[{"index": 1, "count": 1, "merchant": ..., "datePrinted": ..., "dateOrder": ..., "date": ..., "time": ..., "category": ..., "currency": ..., "total": ..., "tax": ..., "subTotal": ..., "city": ..., "country": ..., "docType": ..., "description": ..., "lineItems": [...], "confidence": ...}]

"index" is the image's position, starting at 1. Every image must appear exactly once.
"count" is how many separate receipts you can see in that image, usually 1. When it is more than 1, still give that image one entry.
Apply the field rules and corporate description formatting from the system prompt to each receipt independently — never carry a figure from one receipt to another.`;
}

// Reads a batch of images already prepared for the model (imagePart). Returns
// an array the same length, with null where a receipt could not be read, or
// null overall if the reply cannot be trusted.
async function _readBatch(userId, parts) {
  const content = [{ type: 'text', text: _batchPrompt(parts.length) }];
  for (let i = 0; i < parts.length; i++) {
    content.push({ type: 'text', text: `Receipt ${i + 1}:` });
    content.push(parts[i]);
  }

  const raw = await callGemini(userId, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ], { temperature: 0, maxTokens: Math.max(READ_MAX_TOKENS, 1500 * parts.length) });

  const parsed = parseLlmJson(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.receipts) ? parsed.receipts : null);
  // A reply that does not account for every image cannot be attributed safely.
  if (!list || list.length !== parts.length) return null;
  // Nor can one whose indexes are not each image exactly once. [1,2,2,4,5]
  // has the right count, and put the third receipt's figures on the second.
  // Every index given, each once and in range, or none at all (by position).
  const idx = list.map(item => Number(item && item.index));
  const given = idx.filter(n => Number.isInteger(n));
  if (given.length) {
    if (given.length !== list.length) return null;
    if (new Set(given).size !== list.length || given.some(n => n < 1 || n > parts.length)) return null;
  }

  // An image the model says holds more than one receipt is left for a read of
  // its own, which can split it as a photo is split. One entry an image kept
  // one of the two and dropped the other.
  const out = new Array(parts.length).fill(null);
  list.forEach((item, k) => { out[given.length ? idx[k] - 1 : k] = Number(item && item.count) > 1 ? null : normalise(item); });
  return out.some(x => x) ? out : null;
}

// Reads many receipts, batching where it can and falling back per-image where it
// cannot. `onProgress(doneCount)` fires as results land so a job can report it.
//
// Each answer is one receipt, or null. With { split: true } each is instead a
// whole read as parseReceiptImage gives it ({ receipts, split, reason }, or
// null), so a page holding two receipts can be split like a photo and a
// reader out of reach can say so.
async function parseReceiptBatch(userId, images, { batchSize = BATCH_SIZE, onProgress, split = false } = {}) {
  const results = new Array(images.length).fill(null);
  const answer = parsed => (split ? parsed : firstReceipt(parsed));
  let done = 0;

  for (let start = 0; start < images.length; start += batchSize) {
    const slice = images.slice(start, start + batchSize);
    // Each image is shrunk and encoded once, for the batch and for any read of
    // its own after it. The fallback used to do all of that again per image.
    const parts = [];
    for (const img of slice) parts.push(Buffer.isBuffer(img.buffer) && img.buffer.length ? await imagePart(img.buffer, img.mime) : null);
    const alone = i => (parts[i] ? _readImage(userId, parts[i]) : null);

    let batch = null;
    if (slice.length > 1 && parts.every(Boolean)) {
      try { batch = await _readBatch(userId, parts); }
      catch (err) { logger.warn('Receipt batch failed, falling back to one at a time', { userId, size: slice.length, error: err.message }); }
    }

    if (batch) {
      // A slot the batch could not read is read on its own: one bad photo in a
      // batch of five used to be reported unreadable without a second look.
      for (let i = 0; i < slice.length; i++) {
        results[start + i] = answer(readSomething(batch[i]) ? { receipts: [batch[i]], split: false, reason: 'single' } : await alone(i));
      }
      done += slice.length;
      onProgress && onProgress(done);
      continue;
    }

    // Either a single image, or a batch whose reply could not be trusted.
    for (let i = 0; i < slice.length; i++) {
      results[start + i] = answer(await alone(i));
      done++;
      onProgress && onProgress(done);
    }
  }

  return results;
}

module.exports = { parseReceiptImage, parseReceiptText, parseReceiptPages, parseReceiptBatch, _readBatch, BATCH_SIZE, READ_MAX_TOKENS, PAGES_MAX_TOKENS, normalise, normaliseMany, splittable, separateDocuments, SYSTEM_PROMPT, DOC_TYPES, _num, _isoDate, _time, _currency, _box, _overlapFraction, _withoutTransfer };
