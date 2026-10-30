// What a line printed on a receipt is, from its words: a tax, a payment, a
// service charge or tip, a restated total. The reader (receipt-parser.js)
// asks to clean the lines it was given, and the read-time checks
// (read-receipt.js) ask to judge them, so both ask here.

// ── Tax lines ───────────────────────────────────────────────────────────────
//
// A tax is named by its country: GST in Singapore, Australia and India (CGST,
// SGST, IGST, UTGST), VAT, SST or "Service Tax" in Malaysia, PPN and PB1 (and
// "Pajak") in Indonesia, MwSt or USt in Germany, HST, PST or QST in Canada,
// IVA, TVA, a US sales tax, 消費税 in Japan. Any "tax" used to count, wherever
// it stood: "Room charge (incl. GST)" made 218.00 of tax, "Tax-free shopping"
// 50.00, and a Berlin hotel's "City Tax 5%" replaced the right VAT. So the
// name must START the line, after nothing but a date, a rate or a word like
// "add" or "enth." (included). India's names are the exception: a folio
// prints the outlet first ("JW Cafe CGST 9%"), and the names mean nothing
// else. Levies for a city, tourism or a hotel go to the city, not the tax
// office, and are not tax here; nor is anything "tax-free" or "exempt".
const TAX_NAME = String.raw`(?:(?:c|s|i|ut)gst|gst(?:\s*\/\s*hst)?|hst|pst|qst|vat|value[- ]added tax|sst|ppn|pb\s?1|pajak(?: restoran| daerah)?|mwst|mehrwertsteuer|ust|iva|tva|igv|sales tax|service tax|consumption tax|state tax|county tax|goods (?:and|&) services tax|tax(?:es)?)(?![a-z])|(?:消費税|消费税|增值税|増値税|부가세|부가가치세)`;
const HEAD_TAX_RE = new RegExp(`^(?:total\\s+)?(?:${TAX_NAME})`, 'i');
const INDIA_TAX_RE = /\b(?:c|s|i|ut)gst\b/i;
const LEVY = String.raw`\b(?:city|tourism|tourist|hotel|occupancy|accommodation|lodging|visitor|municipal|resort|destination|environment(?:al)?|heritage|bed|airport|departure|room)\s*-?\s*(?:tax|levy)\b|kurtaxe|ortstaxe|taxe de s[eé]jour`;
const NOT_TAX_RE = new RegExp(String.raw`tax[- ]?free|duty[- ]?free|tax[- ]?exempt|non[- ]?taxable|zero[- ]?rated|${LEVY}`, 'i');
// What may stand before the tax's name at the start of a line.
const LEAD_RE = /^(?:[\s([\-+*•:]+|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\.?\s+|\d+(?:[.,]\d+)?\s*%\s*|(?:add|plus|less|incl|inkl|including|included|inclusive(?:\s+of)?|enth|enthalten|inc)\b\.?\s*|[内內外]\s*)/i;
// A tax already inside the prices: "GST 9% (incl.)", "enth. MwSt 7%", "内消費税".
const INCLUDED_RE = /\b(?:incl|inkl|included|inclusive|including|enth|enthalten|inc)\b|[内內]/i;

// { included } for a tax line, null for anything else.
function taxLine(description) {
  const s = String(description || '').replace(/\s+/g, ' ').trim();
  if (!s || NOT_TAX_RE.test(s)) return null;
  let head = s;
  for (let i = 0; i < 6; i++) {
    const next = head.replace(LEAD_RE, '');
    if (next === head) break;
    head = next;
  }
  if (!HEAD_TAX_RE.test(head) && !INDIA_TAX_RE.test(s)) return null;
  return { included: INCLUDED_RE.test(s) };
}

// The tax's own name in a row's words, as it is printed: "Service Tax" in
// "20/10 Service Tax 8%", "SST" in "SST 6% on 40.80", "CGST" in "JW Cafe CGST
// 9% -[Add: 9%.(B)]", "MwSt" in "enth. MwSt 7% (Logis 360,00)". The rest is
// a date, a base, a rate or a folio's code, and kept in the name it made one
// tax look like several: the JW folio's CGST read as "CGST [Add. udf.]" and
// "CGST [Add: udf.]" showed as six taxes, and two nights' "12/10 GST" and
// "13/10 GST" went to Xero as two. null when no tax is named.
const NAME_RE = new RegExp(`(?<![A-Za-z])(?:${TAX_NAME})`, 'i');
function taxName(description) {
  const m = NAME_RE.exec(String(description || '').replace(/\s+/g, ' ').trim());
  return m ? m[0].trim() : null;
}

// ── Payments and restated totals ────────────────────────────────────────────
//
// A folio ends with the payment that settled it ("Manual MasterCard / Euro
// Card 88,188.77"), a till receipt with the cash handed over and the change.
// Neither is a charge: kept, they double the sum of the lines. "Visa" alone,
// or followed by the card's digits, is the card; a visa FEE is a charge, and
// a visa agency's receipt lost its main line to this filter.
const PAYMENT_RE = /\b(?:mastercard|master card|amex|american express|euro ?card|credit card|debit card|paynow|nets|grabpay|apple pay|google pay|cash tendered|change due|payment received|settlement|paid by|card payment|refunded to)\b/i;
const VISA_CARD_RE = /\bvisa\b(?=\s*(?:$|card|credit|debit|[*x•]|\d{4}|\/|electron|paywave|contactless))/i;
// Lines that are nothing but the money handed over or given back.
const PAYMENT_WHOLE_RE = /^(?:cash(?:\s+(?:paid|received|tendered))?|tunai|tendered|amount tendered|change|kembali(?:an)?|card|eftpos|paywave|contactless|お預り|お預かり|お釣り|釣銭|預り金|現金|现金|找零)\s*:?$/i;
function paymentLine(description) {
  const s = String(description || '').replace(/\s+/g, ' ').trim();
  return PAYMENT_RE.test(s) || VISA_CARD_RE.test(s) || PAYMENT_WHOLE_RE.test(s);
}
// "Total", "Sub Total", "Grand Total", "Amount due": a sum of other lines,
// never a charge of its own. "Total GST" is a tax line, and stays.
const TOTAL_LINE_RE = new RegExp(`^(?:(?:grand|sub|net)\\s*-?\\s*)?total\\b(?!\\s*(?:${TAX_NAME}))|^(?:amount|balance)\\s+(?:due|paid|payable)\\b|^小計|^合計`, 'i');
function totalLine(description) {
  return TOTAL_LINE_RE.test(String(description || '').replace(/\s+/g, ' ').trim());
}

// ── Charges added after the subtotal ────────────────────────────────────────
//
// A service charge goes to the restaurant, not the government, and a tip to
// the staff; neither is tax, and both sit between the subtotal and the total
// with the levies and the rounding.
const SERVICE_RE = /^(?:service(?!\s*tax)|svc|serv\.?\s*chg|s\/c)\b/i;
const TIP_RE = /^(?:tip|tips|gratuity|gratuities)\b/i;
const ADJUSTMENT_RE = /\b(?:service|svc|tip|tips|gratuity|gratuities|surcharge|mandate|rounding|round(?:ing)?\s*adj|levy|city tax|tourism tax|tourist tax|kurtaxe)\b/i;
const serviceLine = d => SERVICE_RE.test(String(d || '').trim()) && !taxLine(d);
const tipLine = d => TIP_RE.test(String(d || '').trim());
const adjustmentLine = d => ADJUSTMENT_RE.test(String(d || '')) && !taxLine(d);
// A levy for a city, tourism or a hotel ("Tourism Tax", "City Tax 5%",
// "Kurtaxe"): named like a tax, paid to the city, and never the tax on the sale.
const LEVY_RE = new RegExp(LEVY, 'i');
const levyLine = d => LEVY_RE.test(String(d || '').replace(/\s+/g, ' ').trim());
// A rounding to the currency's step: "Rounding Adj", "Round off",
// "Penggenapan" in Malaysia, "Pembulatan" in Indonesia, 端数 in Japan.
const ROUNDING_RE = /\brounding\b|\bround(?:ed|ing)?[\s-]*(?:adj(?:ustment)?|off)\b|penggenapan|pembulatan|端数/i;
const roundingLine = d => ROUNDING_RE.test(String(d || ''));

module.exports = { taxLine, taxName, paymentLine, totalLine, serviceLine, tipLine, adjustmentLine, levyLine, roundingLine };
