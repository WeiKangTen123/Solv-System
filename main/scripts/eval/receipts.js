// The receipts the reader is scored on, and what is really printed on each.
//
// Two kinds. Synthetic receipts are drawn by make-synth.js from the lines
// below, so their truth is known exactly and they can be made again on any
// machine; each one carries a problem a real receipt has shown (a tax name
// outside GST/VAT, a tip after the "Total", a US date, a discount line, a
// colleague's room on a folio). The two sample folios are real hotel bills
// kept in samples/receipts, which never reaches the repository: their truth
// is here, but not the guests' names, and their invoice numbers only as a
// hash, because the repository is public.
//
// A drawn line is a string (left), { c } centred, { b } bold and centred,
// [left, right], '-' a rule, or '' a blank line.
//
// A truth value may be an exact value, a RegExp, an array of accepted values,
// { judgement: [...] } where several answers are defensible, or null for
// "nothing should be read". `lines` is the report lines by "Category|OB"
// (OB: on behalf of someone else), made from the receipt as printed;
// `checks` the read-time checks that should fire (aiRead.checks), by name.
// `subTotal` is the subtotal exactly as printed, null where none is.
//
// `rows` is the receipt as printed (receipts/printed.js), scored row by row:
// `items` how many items it prints; `taxes` each tax in printed order as
// { label, rate, amount, included }, or for a folio with dozens of them
// { count, label, rate, sum }; `charges` the amounts of its charges (service
// charge, tip, surcharge, levy) in order; `rounding` its rounding, or null.

const SYNTH = {
  'sg-hawker': {
    angle: 1.2,
    draw: [
      { b: 'AH HOCK CHICKEN RICE' }, { c: 'Stall #01-10 Maxwell Food Centre' }, { c: '1 Kadayanallur Street' }, { c: 'Singapore 069184' },
      { c: 'GST Reg No: 201912345K' }, { c: 'Tel: 6221 0000' }, '-',
      ['Receipt No: 0012345', 'Table: 12'], ['Date: 05/10/2026', 'Time: 12:34'], '-',
      ['2 x Steamed Chicken Rice', '$11.00'], ['      @ $5.50', ''], ['1 x Barley (Hot)', '$1.80'], ['1 x Braised Egg', '$1.00'], '-',
      ['Sub Total', '$13.80'], ['GST 9% (incl.)', '$1.14'], ['TOTAL', '$13.80'], '-', ['CASH', '$20.00'], ['CHANGE', '$6.20'], '',
      { c: 'Thank you! Please come again' },
    ],
    truth: {
      merchant: /Ah Hock Chicken Rice/i, date: '2026-10-05', time: '12:34', invoiceNumber: '0012345', currency: 'SGD',
      total: 13.8, tax: 1.14, subTotal: 13.8, category: 'Meals', city: /^Singapore$/i, country: 'SG', docType: 'meal',
      lines: { 'Meals|': 13.8 }, checks: [],
      rows: { items: 3, taxes: [{ label: /^GST/i, rate: 9, amount: 1.14, included: true }], charges: [], rounding: null },
    },
  },
  'sg-grab': {
    angle: -0.8,
    draw: [
      { b: 'Grab' }, { c: 'Your Grab E-Receipt' }, { c: 'Hope you enjoyed your ride!' }, '-',
      ['Booking ID', 'A-8KXQ2WZ3G4TT'], ['Date', '07 Oct 2026, 08:08 PM'], ['Service', 'JustGrab'], '-',
      'Pick-up location:', '  ION Orchard, 2 Orchard Turn', '  Singapore 238801', 'Drop-off location:', '  Changi Airport Terminal 3', '  65 Airport Boulevard, Singapore 819663', '-',
      ['Fare', 'S$ 19.50'], ['Airport Surcharge', 'S$ 3.00'], ['Platform Fee', 'S$ 0.90'], ['Promo GRABSAVE', '-S$ 2.00'], '-',
      ['TOTAL', 'S$ 21.40'], ['Paid by', 'GrabPay Wallet'], '', { c: 'Grab Rides Pte Ltd, 3 Media Close' }, { c: 'Singapore 138498' },
    ],
    truth: {
      merchant: /^Grab/i, date: '2026-10-07', time: '20:08', invoiceNumber: 'A-8KXQ2WZ3G4TT', currency: 'SGD',
      total: 21.4, tax: null, subTotal: null, category: 'Air & Transport', city: /^Singapore$/i, country: 'SG', docType: 'ride',
      lines: { 'Air & Transport|': 21.4 }, descMust: [/ION Orchard/i, /Changi/i], checks: [],
      rows: { items: 1, taxes: [], charges: [3, 0.9], rounding: null },
    },
  },
  'my-nasikandar': {
    angle: 1.6,
    draw: [
      { b: 'RESTORAN SRI MELAKA' }, { c: 'NASI KANDAR' }, { c: 'No. 12, Jalan Ampang' }, { c: '50450 Kuala Lumpur, Malaysia' }, { c: 'Tel: +603-2161 0000' },
      { c: 'SST No: W10-1808-32000123' }, { c: 'TAX INVOICE' }, '-',
      ['Inv No: INV-2026-004571', 'Cashier: 03'], ['Date: 08-10-2026', 'Time: 13:15'], '-',
      ['Nasi Kandar Ayam Goreng  1', '14.50'], ['Roti Canai  2 @ 1.50', '3.00'], ['Teh Tarik   2 @ 3.20', '6.40'], '-',
      ['Subtotal', '23.90'], ['Service Charge 10%', '2.39'], ['SST 6%', '1.58'], ['Rounding Adj', '-0.02'], '-',
      ['TOTAL (RM)', '27.85'], ['Cash', 'RM 50.00'], ['Change', 'RM 22.15'], '', { c: 'Terima kasih' },
    ],
    truth: {
      // SST only: the service charge goes to the restaurant, not the government.
      merchant: /Sri Melaka/i, date: '2026-10-08', time: '13:15', invoiceNumber: 'INV-2026-004571', currency: 'MYR',
      total: 27.85, tax: 1.58, subTotal: 23.9, category: 'Meals', city: /Kuala Lumpur/i, country: 'MY', docType: 'meal',
      lines: { 'Meals|': 27.85 }, checks: [],
      rows: { items: 3, taxes: [{ label: /^SST/i, rate: 6, amount: 1.58, included: false }], charges: [2.39], rounding: -0.02 },
    },
  },
  'us-grill-tip': {
    angle: -1.4,
    draw: [
      { b: 'THE GOLDEN GATE GRILL' }, { c: '450 Mission Street' }, { c: 'San Francisco, CA 94105' }, { c: '(415) 555-0142' }, '-',
      ['Server: Maria', 'Table 7  Guests 2'], ['Check #4821', ''], ['10/09/2026', '7:42 PM'], '-',
      ['1 Ribeye Steak', 'US$ 42.00'], ['1 Grilled Salmon', 'US$ 34.00'], ['2 Iced Tea @ 4.50', 'US$ 9.00'], ['1 Caesar Salad', 'US$ 14.00'], '-',
      ['Subtotal', 'US$ 99.00'], ['Sales Tax 8.625%', 'US$ 8.54'], ['SF Mandate 4%', 'US$ 3.96'], ['Total', 'US$ 111.50'], '-',
      ['Tip', 'US$ 20.00'], ['GRAND TOTAL', 'US$ 131.50'], '-', ['VISA ****1234', 'US$ 131.50'], ['Auth 08812C', 'APPROVED'], '',
      { c: 'x  M. Tan (signed)' },
    ],
    truth: {
      // Charged with the tip. 10/09 is 9 October, printed month first; both
      // numbers are 12 or under, so the other reading is worth a look.
      merchant: /Golden Gate Grill/i, date: '2026-10-09', time: '19:42', invoiceNumber: /^#?4821$/, currency: 'USD',
      total: 131.5, tax: 8.54, subTotal: 99, category: 'Meals', city: /San Francisco/i, country: 'US', docType: 'meal',
      lines: { 'Meals|': 131.5 }, checks: ['dateOrder'],
      rows: { items: 4, taxes: [{ label: /^Sales Tax/i, rate: 8.625, amount: 8.54, included: false }], charges: [3.96, 20], rounding: null },
    },
  },
  'jp-ramen': {
    angle: 0.9,
    font: 'cjk',
    draw: [
      { b: 'らーめん 一番星 新宿店' }, { c: '〒160-0022 東京都新宿区新宿3-1-1' }, { c: 'TEL 03-1234-5678' }, { c: '登録番号 T1234567890123' }, { c: '領 収 書' }, '-',
      ['2026年10月15日(木)', '19:42'], ['No.0042', '担当: 02'], '-',
      ['醤油らーめん', '¥980'], ['替玉', '¥150'], ['生ビール 2 @¥600', '¥1,200'], ['餃子', '¥450'], '-',
      ['小計', '¥2,780'], ['(10%対象', '¥2,780)'], ['消費税(10%)', '¥278'], ['合計', '¥3,058'], '-', ['お預り', '¥5,000'], ['お釣り', '¥1,942'], '',
      { c: 'ありがとうございました' },
    ],
    truth: {
      merchant: /一番星|Ichiban/i, date: '2026-10-15', time: '19:42', invoiceNumber: /^(No\.?\s*)?0042$/, currency: 'JPY',
      total: 3058, tax: 278, subTotal: 2780, category: 'Meals', city: /Tokyo|東京|Shinjuku|新宿/i, country: 'JP', docType: 'meal',
      lines: { 'Meals|': 3058 }, checks: [],
      rows: { items: 4, taxes: [{ label: /消費税/, rate: 10, amount: 278, included: false }], charges: [], rounding: null },
    },
  },
  'sg-supermarket': {
    angle: -1.1,
    draw: [
      { b: 'GREENLEAF SUPERMARKET' }, { c: 'Blk 123 Bukit Timah Road #01-01' }, { c: 'Singapore 229833' }, { c: 'GST Reg No: M90312345X' }, { c: 'TAX INVOICE' }, '-',
      ['Inv: 0104-2026-77812', ''], ['Date: 21/10/2026', '18:05'], '-',
      ['FRESH MILK 2L', '6.95'], ['WHOLEMEAL BREAD', '3.20'], ['EGGS 10S', '4.15'], ['APPLE FUJI  4 @ 0.80', '3.20'], ['COFFEE BEANS 500G', '15.90'],
      ['DISHWASHING LIQUID', '4.50'], ['A4 PAPER 500 SHTS 2 @ 6.90', '13.80'], ['  2ND UNIT 50% OFF', '-3.45'], ['BALLPOINT PEN 10PK', '5.60'], ['BANANA 1.2KG @ 2.40/KG', '2.88'], '-',
      ['SUBTOTAL', '56.73'], ['TOTAL S$', '56.73'], ['GST 9% INCLUDED', '4.68'], '-', ['VISA ****8812', '56.73'], '',
      { c: 'Thank you for shopping with us' },
    ],
    truth: {
      // Office Supplies = A4 13.80 less the 3.45 promotion plus pens 5.60;
      // the groceries (and the dish liquid) are Meals or Other.
      merchant: /Greenleaf/i, date: '2026-10-21', time: '18:05', invoiceNumber: '0104-2026-77812', currency: 'SGD',
      total: 56.73, tax: 4.68, subTotal: 56.73, category: { judgement: ['Other', 'Meals', 'Office Supplies'] }, city: /^Singapore$/i, country: 'SG', docType: 'other',
      lines: { 'Office Supplies|': 15.95 }, partialLines: true, checks: [],
      rows: { items: 9, taxes: [{ label: /^GST/i, rate: 9, amount: 4.68, included: true }], charges: [], rounding: null },
    },
  },
  'de-hotel-dcc': {
    angle: 0.7,
    draw: [
      { b: 'HOTEL KASTANIE BERLIN' }, { c: 'Friedrichstrasse 100, 10117 Berlin' }, { c: 'Germany  Tel +49 30 1234567' }, { c: 'USt-IdNr. DE123456789' }, '-',
      ['RECHNUNG / INVOICE', 'Nr. 2026-10-3381'], ['Datum / Date', '03.10.2026'], ['Anreise / Arrival', '01.10.2026'], ['Abreise / Departure', '03.10.2026'], '-',
      ['01.10. Logis / Room', 'EUR 180,00'], ['02.10. Logis / Room', 'EUR 180,00'], ['02.10. Fruehstueck / Breakfast', 'EUR 24,00'], ['City Tax 5%', 'EUR 18,00'], '-',
      ['Gesamt / Total', 'EUR 402,00'], ['enth. MwSt 7% (Logis 360,00)', 'EUR 23,55'], ['enth. MwSt 19% (Fruehst. 24,00)', 'EUR 3,83'], ['MwSt / VAT gesamt', 'EUR 27,38'], '-',
      ['Bezahlt / Paid: VISA ****4471', ''], ['Amount charged to card', 'SGD 573,05'], ['DCC rate 1 EUR = 1,4255 SGD', ''], '',
      { c: 'Vielen Dank fuer Ihren Besuch' },
    ],
    truth: {
      // The VAT is inside the prices; the city tax is a levy, not VAT.
      merchant: /Kastanie/i, date: '2026-10-03', time: null, invoiceNumber: /^(Nr\.?\s*)?2026-10-3381$/, currency: 'EUR',
      total: 402, tax: 27.38, subTotal: null, category: 'Lodging', city: /Berlin/i, country: 'DE', docType: 'hotel',
      lines: { 'Lodging|': 378, 'Meals|': 24 }, checks: [],
      rows: { items: 3, taxes: [{ label: /MwSt/i, rate: 7, amount: 23.55, included: true }, { label: /MwSt/i, rate: 19, amount: 3.83, included: true }], charges: [18], rounding: null },
    },
  },
  'bare-dollar': {
    angle: 0.5,
    draw: [
      { b: "JOE'S COFFEE" }, { c: 'Receipt #881' }, ['2026-10-20', '09:15'], '-',
      ['Latte', '$5.50'], ['Croissant', '$4.25'], '-', ['TOTAL', '$9.75'], ['Card', '$9.75'], '', { c: 'Thanks!' },
    ],
    truth: {
      merchant: /Joe's Coffee/i, date: '2026-10-20', time: '09:15', invoiceNumber: /^#?881$/, currency: null,
      total: 9.75, tax: null, subTotal: null, category: 'Meals', city: null, country: null, docType: 'meal',
      lines: { 'Meals|': 9.75 }, checks: [],
      rows: { items: 2, taxes: [], charges: [], rounding: null },
    },
  },
  'ca-diner': {
    angle: -0.6,
    draw: [
      { b: 'MAPLE LEAF DINER' }, { c: '220 King St W, Toronto, ON M5H 1K4' }, { c: 'HST # 123456789 RT0001' }, '-',
      ['Bill 3307', 'Table 4'], ['2026-10-19', '18:30'], '-',
      ['Poutine', 'CA$ 12.00'], ['Club Sandwich', 'CA$ 16.50'], ['Coffee', 'CA$ 3.50'], '-',
      ['Subtotal', 'CA$ 32.00'], ['HST 13%', 'CA$ 4.16'], ['TOTAL', 'CA$ 36.16'], '', { c: 'Merci / Thank you' },
    ],
    truth: {
      merchant: /Maple Leaf Diner/i, date: '2026-10-19', time: '18:30', invoiceNumber: '3307', currency: 'CAD',
      total: 36.16, tax: 4.16, subTotal: 32, category: 'Meals', city: /Toronto/i, country: 'CA', docType: 'meal',
      lines: { 'Meals|': 36.16 }, checks: [],
      rows: { items: 3, taxes: [{ label: /^HST/i, rate: 13, amount: 4.16, included: false }], charges: [], rounding: null },
    },
  },
  'id-warung': {
    angle: 1.0,
    draw: [
      { b: 'WARUNG SEDAP' }, { c: 'Jl. Sabang No. 25, Jakarta Pusat 10350' }, { c: 'Indonesia  Telp (021) 3190 0000' }, { c: 'NPWP 01.234.567.8-012.000' }, '-',
      ['No. Bill: WS-88213', 'Meja: 7'], ['Tanggal: 14/10/2026', 'Jam: 19:20'], '-',
      ['Nasi Goreng Spesial 2 x 45.000', '90.000'], ['Sate Ayam (10 tusuk)', '55.000'], ['Es Teh Manis 2 x 12.500', '25.000'], '-',
      ['Subtotal', '170.000'], ['Service 5%', '8.500'], ['PB1 10%', '17.850'], '-',
      ['TOTAL', 'Rp 196.350'], ['Tunai', 'Rp 200.000'], ['Kembali', 'Rp 3.650'], '', { c: 'Terima kasih atas kunjungan Anda' },
    ],
    truth: {
      // PB1 is Jakarta's restaurant tax, charged on the food and the service.
      merchant: /Warung Sedap/i, date: '2026-10-14', time: '19:20', invoiceNumber: /^(No\.?\s*Bill:?\s*)?WS-88213$/i, currency: 'IDR',
      total: 196350, tax: 17850, subTotal: 170000, category: 'Meals', city: /Jakarta/i, country: 'ID', docType: 'meal',
      lines: { 'Meals|': 196350 }, checks: [],
      rows: { items: 3, taxes: [{ label: /^PB\s?1/i, rate: 10, amount: 17850, included: false }], charges: [8500], rounding: null },
    },
  },
  'us-refund': {
    angle: -0.9,
    draw: [
      { b: 'OFFICE DEPOT #2231' }, { c: '1100 Market St, San Francisco CA 94102' }, { c: 'REFUND / RETURN' }, '-',
      ['Receipt #R-44871', ''], ['10/21/2026', '3:05 PM'], ['Orig. Trans 2231-0098-1123', ''], '-',
      ['HP 67XL Ink Cartridge', '-39.99'], ['Sales Tax 8.625%', '-3.45'], '-',
      ['REFUND TOTAL', '-$43.44'], ['Refunded to VISA ****5512', ''], '', { c: 'Thank you for shopping' },
    ],
    truth: {
      // A refund is not claimed here: no amount, and a note that says why.
      merchant: /Office Depot/i, date: '2026-10-21', time: '15:05', invoiceNumber: /^(Receipt\s*)?#?\s*R-44871$/i, currency: ['USD', null],
      total: null, tax: null, subTotal: null, category: 'Office Supplies', city: /San Francisco/i, country: 'US', docType: 'other',
      lines: {}, refund: true, checks: [],
    },
  },
  'th-visa': {
    angle: 0.6,
    draw: [
      { b: 'VFS GLOBAL SERVICES (THAILAND)' }, { c: 'Visa Application Centre, Trendy Building' }, { c: 'Sukhumvit Soi 13, Bangkok 10110' }, { c: 'Tel +66 2 118 7100' }, { c: 'TAX INVOICE / RECEIPT' }, '-',
      ['Receipt No:', 'VFS-BKK-2026-0457812'], ['Date: 16/10/2026', '10:42'], '-',
      ['Tourist Visa Fee (Single Entry)', '1,800.00'], ['VFS Service Fee', '950.00'], ['VAT 7% on Service Fee', '66.50'], '-',
      ['TOTAL THB', '2,816.50'], ['Paid by VISA ****7731', '2,816.50'], '', { c: 'Thank you' },
    ],
    truth: {
      // A visa FEE is a charge; the card it was paid with is not.
      merchant: /VFS Global/i, date: '2026-10-16', time: '10:42', invoiceNumber: 'VFS-BKK-2026-0457812', currency: 'THB',
      total: 2816.5, tax: 66.5, subTotal: null, category: 'Other', city: /Bangkok/i, country: 'TH', docType: 'other',
      lines: { 'Other|': 2816.5 }, checks: [],
      rows: { items: 2, taxes: [{ label: /^VAT/i, rate: 7, amount: 66.5, included: false }], charges: [], rounding: null },
    },
  },
  'sg-hotel-folio': {
    angle: -0.7,
    draw: [
      { b: 'HARBOURVIEW HOTEL' }, { c: '10 Marina Boulevard, Singapore 018983' }, { c: 'Tel +65 6123 4567' }, { c: 'GST Reg No: 199812345M' }, { c: 'TAX INVOICE / GUEST FOLIO' }, '-',
      ['Guest: Mr Daniel Ong', 'Room: 1208'], ['Arrival: 12/10/2026', 'Departure: 14/10/2026'], ['Folio No: HV-554120', 'Date: 14/10/2026'], '-',
      ['12/10 Room Charge', '280.00'],
      ['12/10 Room Charge', '280.00'], '      [NA Room] ONG MEI LIN #1210=>Ong D #1208',
      ['12/10 Harbour Grill Dinner', '96.00'], '      Room# 1208 : CHECK# 4471',
      ['13/10 Room Charge', '280.00'],
      ['13/10 Room Charge', '280.00'], '      [NA Room] ONG MEI LIN #1210=>Ong D #1208',
      ['13/10 Harbour Grill Breakfast', '32.00'], '      Room# 1208 : CHECK# 5120',
      ['13/10 Harbour Grill Breakfast', '32.00'], '      Room# 1208 : CHECK# 5120',
      '-', ['TOTAL SGD', '1,280.00'], ['GST 9% included', '105.69'], '-',
      ['MasterCard ****4410', '1,280.00'], '', { c: 'Thank you for staying with us' },
    ],
    truth: {
      // A colleague's two nights transferred onto this bill, and one
      // breakfast posted twice under the same check number.
      merchant: /Harbourview/i, date: '2026-10-14', time: null, invoiceNumber: /^(Folio\s*(No\.?)?\s*:?\s*)?HV-554120$/i, currency: 'SGD',
      total: 1280, tax: 105.69, subTotal: null, category: 'Lodging', city: /^Singapore$/i, country: 'SG', docType: 'hotel',
      lines: { 'Lodging|': 560, 'Lodging|OB': 560, 'Meals|': 160 }, checks: ['people', 'chargedTwice'],
      rows: { items: 7, taxes: [{ label: /^GST/i, rate: 9, amount: 105.69, included: true }], charges: [], rounding: null },
    },
  },
  'my-hotel-2rates': {
    angle: 0.8,
    draw: [
      { b: 'HOTEL SERI BUKIT' }, { c: 'Jalan Sultan Ismail, 50250 Kuala Lumpur' }, { c: 'Malaysia  Tel +603-2141 0000' },
      { c: 'SST Reg No: W10-1902-32000456' }, { c: 'TAX INVOICE / GUEST FOLIO' }, '-',
      ['Folio No: SB-77120', 'Room: 905'], ['Arrival: 20/10/2026', 'Depart: 21/10/2026'], ['Date: 21/10/2026', ''], '-',
      ['20/10 Room Charge', '280.00'], ['20/10 Service Charge 10%', '28.00'], ['20/10 Service Tax 8%', '24.64'], ['20/10 Tourism Tax', '10.00'],
      ['20/10 Lounge Dinner', '85.00'], ['20/10 Service Charge 10%', '8.50'], ['20/10 SST 6% (F&B)', '5.61'], '-',
      ['TOTAL RM', '441.75'], '-', 'Tax Summary', ['Service Tax 8% on 308.00', '24.64'], ['SST 6% on 93.50', '5.61'],
      ['Total Tax', '30.25'], '-', ['VISA ****2290', '441.75'], '', { c: 'Terima kasih' },
    ],
    truth: {
      // Two rates on one bill: Service Tax of 8% on the room and its service
      // charge, SST of 6% on the dinner and its service charge, and the
      // tourism tax of RM10 a night, which is a levy and not under either.
      // Before the record, the 30.25 was split again by amount: 23.46 and 6.79.
      merchant: /Seri Bukit/i, date: '2026-10-21', time: null, invoiceNumber: /^(Folio\s*(No\.?)?\s*:?\s*)?SB-77120$/i, currency: 'MYR',
      total: 441.75, tax: 30.25, subTotal: null, category: 'Lodging', city: /Kuala Lumpur/i, country: 'MY', docType: 'hotel',
      lines: { 'Lodging|': 342.64, 'Meals|': 99.11 }, checks: [],
      rows: { items: 2, taxes: [{ label: /Service Tax/i, rate: 8, amount: 24.64, included: false }, { label: /SST|Service Tax/i, rate: 6, amount: 5.61, included: false }],
              charges: [28, 10, 8.5], rounding: null },
    },
  },
  'my-sst-6-8': {
    angle: -1.0,
    draw: [
      { b: 'RESTORAN DAUN PISANG' }, { c: 'Lot G-12, Bangsar Village' }, { c: '59100 Kuala Lumpur, Malaysia' }, { c: 'SST No: W10-2105-32000789' },
      { c: 'TAX INVOICE' }, '-', ['Bill No: DP-118842', 'Table: 9'], ['Date: 22/10/2026', 'Time: 12:48'], '-',
      ['Nasi Lemak Special 2 x 15.90', '31.80 S6'], ['Teh Tarik Ais 2 x 4.50', '9.00 S6'], ['Valet Parking 3 hrs', '12.00 S8'], '-',
      ['Subtotal', '52.80'], ['SST 6% on 40.80', '2.45'], ['SST 8% on 12.00', '0.96'], ['Rounding Adj', '-0.01'], '-',
      ['TOTAL (RM)', '56.20'], ['Card', 'RM 56.20'], '', { c: 'S6 = SST 6%   S8 = SST 8%' }, { c: 'Terima kasih' },
    ],
    truth: {
      // Food at 6% and the valet parking at 8%, each item marked with its
      // rate: the lines keep each rate on its own category.
      merchant: /Daun Pisang/i, date: '2026-10-22', time: '12:48', invoiceNumber: /^(Bill\s*No\.?:?\s*)?DP-118842$/i, currency: 'MYR',
      total: 56.2, tax: 3.41, subTotal: 52.8, category: 'Meals', city: /Kuala Lumpur|Bangsar/i, country: 'MY', docType: 'meal',
      lines: { 'Meals|': 43.24, 'Air & Transport|': 12.96 }, lineTol: 0.01, checks: [],
      rows: { items: 3, taxes: [{ label: /^SST/i, rate: 6, amount: 2.45, included: false }, { label: /^SST/i, rate: 8, amount: 0.96, included: false }],
              charges: [], rounding: -0.01 },
    },
  },
  'sg-gst-noamount': {
    angle: 0.4,
    draw: [
      { b: 'TOA PAYOH KOPI' }, { c: 'Blk 190 Lorong 6 Toa Payoh #01-520' }, { c: 'Singapore 310190' }, { c: 'GST Reg No: 201733456W' }, '-',
      ['Receipt: 77-30418', ''], ['Date: 23/10/2026', '08:12'], '-',
      ['1 Kaya Toast Set', '5.80'], ['1 Kopi C', '1.90'], '-', ['TOTAL', '7.70'], ['NETS', '7.70'], '',
      { c: 'Price payable includes GST' }, { c: 'Thank you' },
    ],
    truth: {
      // No GST amount anywhere, only "Price payable includes GST": the GST
      // is worked out as 9/109 of the total and marked as worked out.
      merchant: /Toa Payoh Kopi/i, date: '2026-10-23', time: '08:12', invoiceNumber: /^(Receipt:?\s*)?77-30418$/i, currency: 'SGD',
      total: 7.7, tax: 0.64, subTotal: null, category: 'Meals', city: /^Singapore$/i, country: 'SG', docType: 'meal',
      lines: { 'Meals|': 7.7 }, checks: [],
      rows: { items: 2, taxes: [{ label: /^GST/i, rate: 9, amount: 0.64, included: true }], charges: [], rounding: null },
    },
  },
};

// The two folios in samples/receipts (read as the scanned PDFs they are).
// From the pages as rendered and read by hand: each carries a colleague's
// room and meals transferred onto it, and the Courtyard bill posts one
// dinner twice under the same check number on 3 September.
const SAMPLES = {
  'jw-marriott-mumbai': {
    file: 'jw-marriott-mumbai.pdf',
    truth: {
      // The summary table prints 6,759, which is what the total holds; the
      // itemised tax lines add to 6,760, one rupee of rounding over.
      merchant: /JW Marriott.*Mumbai.*Sahar/i, date: '2026-09-01', time: null, invoiceHash: 'e6662908819b1f51', currency: 'INR',
      total: 44309, tax: 6759, subTotal: [null, 37550], category: 'Lodging', city: /Mumbai/i, country: 'IN', docType: 'hotel',
      lines: { 'Lodging|OB': 20738.5, 'Lodging|': 20738.5, 'Meals|OB': 1416, 'Meals|': 1417 }, lineTol: 1.0, checks: ['people'],
      // Two rooms and two breakfasts, a CGST and an SGST of 9% under each.
      rows: { items: 4, taxes: { count: 8, label: /[CS]GST/i, rate: 9, sum: 6760 }, charges: [], rounding: null },
    },
  },
  'courtyard-marriott-pune': {
    file: 'courtyard-marriott-pune.pdf',
    truth: {
      merchant: /Courtyard.*Pune.*Chakan/i, date: '2026-09-04', time: ['08:23', null], invoiceHash: '102f68a99b069f3f', currency: 'INR',
      total: 88188.77, tax: 13452.52, subTotal: [null, 74736.25], category: 'Lodging', city: /^(Pune|Chakan)$/i, country: 'IN', docType: 'hotel',
      lines: { 'Lodging|': 43131.36, 'Lodging|OB': 36713.34, 'Meals|': 6426.57, 'Meals|OB': 1917.5 }, checks: ['people', 'chargedTwice'],
      // Fifteen charges, each with its CGST and SGST of 9%.
      rows: { items: 15, taxes: { count: 24, label: /[CS]GST/i, rate: 9, sum: 13452.52 }, charges: [], rounding: null },
    },
  },
};

module.exports = { SYNTH, SAMPLES };
