const email = require('./email');
const { HttpError } = require('../utils/http-error');
const { eml, msg, fakePdf, photo, logo } = require('../test-fixtures/mail');

// The tests that read a PDF's text do it as the reader does, in a child
// process, which is slow to start on a busy machine.
const SLOW = 60000;

// Every mail here is a real one: MIME written as a mail program writes it, and
// an Outlook .msg burned into the container Outlook saves (test-fixtures/mail.js).
describe('intake/email', () => {
  describe('parseMail', () => {
    test('an .eml: who, when, what about, every visible recipient, the body and each attachment', async () => {
      const mail = await email.parseMail(eml({
        from: '"Jane Tan" <Jane@Solv.sg>', to: 'receipts+abc123def456@in.solv.sg, Other <o@x.com>', cc: 'boss@solv.sg',
        subject: 'Fwd: Taxi', text: 'Taxi home', html: '<p>Taxi home <img src="cid:logo1@x"></p>',
        attachments: [
          { filename: 'r.pdf', contentType: 'application/pdf', content: fakePdf() },
          { filename: 'image001.png', contentType: 'image/png', content: await logo(), cid: 'logo1@x' },
        ],
      }));
      expect(mail).toMatchObject({
        subject: 'Fwd: Taxi', from: 'Jane@Solv.sg', fromName: 'Jane Tan',
        to: ['receipts+abc123def456@in.solv.sg', 'o@x.com', 'boss@solv.sg'],
        text: expect.stringContaining('Taxi home'), html: expect.stringContaining('cid:logo1@x'),
      });
      expect(mail.date.toISOString()).toBe('2026-10-21T01:12:00.000Z');
      const byName = Object.fromEntries(mail.attachments.map(a => [a.filename, a]));
      expect(byName['r.pdf']).toMatchObject({ contentType: 'application/pdf', inline: false, cid: null });
      expect(byName['r.pdf'].content.equals(fakePdf())).toBe(true);
      expect(byName['image001.png']).toMatchObject({ contentType: 'image/png', inline: true, cid: 'logo1@x' });
    });

    // A cid the HTML never shows is an attachment like any other.
    test('a picture with a cid the message never shows is not inline', async () => {
      const mail = await email.parseMail(eml({ html: '<p>No pictures here</p>', attachments: [{ filename: 'p.png', contentType: 'image/png', content: await logo(), cid: 'unused@x' }] }));
      expect(mail.attachments[0]).toMatchObject({ cid: 'unused@x', inline: false });
    });

    test('an Outlook .msg, known by its container rather than its name', async () => {
      const buf = msg({
        from: 'jane@solv.sg', fromName: 'Jane Tan', to: ['receipts+abc123def456@in.solv.sg'], subject: 'Hotel',
        text: 'Folio attached', html: '<p>Folio <img src="cid:img1"></p>',
        attachments: [
          { filename: 'folio.pdf', contentType: 'application/pdf', content: fakePdf(7) },
          { filename: 'logo.png', contentType: 'image/png', content: await logo(), cid: 'img1' },
        ],
      });
      expect(email.isMsg(buf)).toBe(true);
      const mail = await email.parseMail(buf, { filename: 'mail.eml' });
      expect(mail).toMatchObject({ subject: 'Hotel', from: 'jane@solv.sg', fromName: 'Jane Tan', to: ['receipts+abc123def456@in.solv.sg'], text: 'Folio attached' });
      expect(mail.date.toISOString()).toBe('2026-10-21T01:12:00.000Z');
      expect(mail.attachments.map(a => [a.filename, a.contentType, a.inline])).toEqual([['folio.pdf', 'application/pdf', false], ['logo.png', 'image/png', true]]);
      expect(mail.attachments[0].content.equals(fakePdf(7))).toBe(true);
    });

    test('anything that is not a mail is refused with the same plain sentence', async () => {
      const notMail = [
        Buffer.alloc(0), Buffer.from('just some words, no headers at all'), fakePdf(), await logo(),
        // the container Outlook uses, holding no message: an old Word or Excel file
        Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)]),
      ];
      for (const buf of notMail) {
        const err = await email.parseMail(buf).catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).toMatchObject({ status: 400, message: 'That file is not an email (.eml or .msg).' });
      }
      expect(email.isMsg(fakePdf())).toBe(false);
    });
  });

  describe('receiptsFromMail', () => {
    test('PDFs and pictures are kept; logos, tiny images and everything else are left out, each with a reason', async () => {
      const big = await photo();
      const webp = await require('sharp')({ create: { width: 700, height: 900, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).webp().toBuffer();
      const mail = await email.parseMail(eml({
        html: '<p>Receipts attached <img src="cid:logo"> <img src="cid:banner"></p>',
        attachments: [
          { filename: 'invoice.pdf', contentType: 'application/pdf', content: fakePdf(1) },
          { filename: 'IMG_0001.jpg', contentType: 'image/jpeg', content: big },
          { filename: 'shot.webp', contentType: 'image/webp', content: webp },
          { filename: 'logo.png', contentType: 'image/png', content: await logo(), cid: 'logo' },
          { filename: 'banner.jpg', contentType: 'image/jpeg', content: await photo({ width: 1200, height: 300 }), cid: 'banner' },
          { filename: 'pixel.gif', contentType: 'image/gif', content: await require('sharp')({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).gif().toBuffer() },
          { filename: 'terms.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('PK\x03\x04 word') },
          { filename: 'scan.pdf', contentType: 'application/pdf', content: Buffer.from('<html>not a pdf</html>') },
        ],
      }));
      expect(webp.length).toBeGreaterThan(email.TINY_BYTES);
      const out = await email.receiptsFromMail(mail);
      expect(out.files.map(f => [f.filename, f.declaredMime])).toEqual([
        ['invoice.pdf', 'application/pdf'], ['IMG_0001.jpg', 'image/jpeg'], ['shot.webp', 'image/webp'],
      ]);
      expect(out.files[1].buffer.equals(big)).toBe(true);
      expect(out.skipped).toEqual([
        { name: 'logo.png', why: expect.stringMatching(/^too small to be a receipt/) },
        { name: 'banner.jpg', why: expect.stringMatching(/^a picture in the message itself/) },
        { name: 'pixel.gif', why: expect.stringMatching(/^too small to be a receipt/) },
        { name: 'terms.docx', why: 'not a receipt file type' },
        { name: 'scan.pdf', why: 'not a real image or PDF' },
      ]);
      expect(out.bodyPdf).toBeNull();               // there were receipts, so the message itself is not one
    });

    // A phone's mail app sends a photo taken for the purpose as a picture the
    // message shows, exactly as a signature's logo is sent; Outlook does the
    // same with a pasted screenshot. Their size tells them apart.
    test('a photograph the message shows by its cid is a receipt, not a logo', async () => {
      const mail = await email.parseMail(eml({ html: '<div><img src="cid:photo1"></div><div>Sent from my iPhone</div>',
        attachments: [{ filename: 'IMG_2041.jpg', contentType: 'image/jpeg', content: await photo({ width: 1200, height: 1600 }), cid: 'photo1' }] }));
      expect(mail.attachments[0].inline).toBe(true);
      const out = await email.receiptsFromMail(mail);
      expect(out.files.map(f => f.filename)).toEqual(['IMG_2041.jpg']);
      expect(out.skipped).toEqual([]);
      expect(out.bodyPdf).toBeNull();
    });

    test('a mail with no receipt attached becomes a PDF of the message, which reads as a typed one', async () => {
      const mail = await email.parseMail(eml({
        from: 'Jane Tan <jane@solv.sg>', subject: 'Fwd: Your Grab E-Receipt',
        html: '<html><head><style>td{color:red}</style><title>x</title></head><body><!-- tracking -->'
          + '<table><tr><td>Fare</td><td>S$12.30</td></tr><tr><td>Tip</td><td>&#8377;5 &amp; &euro;2</td></tr></table>'
          + '<img src="cid:logo"><script>alert(1)</script></body></html>',
        attachments: [{ filename: 'logo.png', contentType: 'image/png', content: await logo(), cid: 'logo' }],
      }));
      const out = await email.receiptsFromMail(mail, { timeZone: 'Asia/Singapore' });
      expect(out.files).toEqual([]);
      expect(out.skipped).toEqual([{ name: 'logo.png', why: expect.stringMatching(/^too small/) }]);
      expect(out.bodyPdf.subarray(0, 5).toString()).toBe('%PDF-');
      // the text layer the reader will be given
      const { pages } = await require('../pdf/text-extract').extractText(out.bodyPdf);
      const text = pages.join('\n');
      expect(text).toContain('From: Jane Tan <jane@solv.sg>');
      expect(text).toContain('Date: Wed, 21 Oct 2026, 09:12 GMT+8');
      expect(text).toContain('Subject: Fwd: Your Grab E-Receipt');
      expect(text).toMatch(/Fare S\$12\.30/);
      expect(text).toMatch(/Tip INR 5 & €2/);          // a sign the PDF fonts cannot draw becomes its code
      expect(text).not.toMatch(/color:red|alert|tracking/);
      // The same mail makes the same bytes, so sending it twice is a duplicate.
      expect((await email.receiptsFromMail(mail, { timeZone: 'Asia/Singapore' })).bodyPdf.equals(out.bodyPdf)).toBe(true);
    }, SLOW);

    test('the plain-text body is used when there is one, and a mail with no text and nothing attached says so', async () => {
      const plain = await email.parseMail(eml({ text: 'Parking 4.50 SGD', html: '<p>ignored</p>' }));
      const { pages } = await require('../pdf/text-extract').extractText((await email.receiptsFromMail(plain)).bodyPdf);
      expect(pages.join(' ')).toContain('Parking 4.50 SGD');
      expect(pages.join(' ')).not.toContain('ignored');

      const empty = await email.parseMail(eml({ subject: 'Nothing here', text: '   ' }));
      const out = await email.receiptsFromMail(empty);
      expect(out).toEqual({ files: [], skipped: [{ name: 'Nothing here', why: expect.stringMatching(/no receipt is attached/) }], bodyPdf: null });
    }, SLOW);

    // Forward as attachment: what is in the forwarded mail counts, and the
    // forwarded mail's own text when nothing in it is taken; a mail inside
    // that one is not opened.
    test('a mail forwarded as an attachment is opened, one level deep', async () => {
      const withPdf = eml({ subject: 'Hotel folio', text: 'See attached', attachments: [{ filename: 'folio.pdf', contentType: 'application/pdf', content: fakePdf(3) }] });
      const typed = eml({ subject: 'RE: Your Grab E-Receipt', html: '<p>Total S$8.90</p>' });
      const deeper = eml({ subject: 'Outer', text: 'x', attachments: [{ filename: 'inner.eml', message: true, content: eml({ subject: 'Inner', text: 'Total 1.00' }) }] });
      const mail = await email.parseMail(eml({ subject: 'Fwd: three', text: 'FYI', attachments: [
        { filename: 'folio.eml', message: true, content: withPdf },
        { filename: 'grab.eml', message: true, content: typed },
        { filename: 'outer.eml', message: true, content: deeper },
        { filename: 'outlook.msg', contentType: 'application/vnd.ms-outlook', content: msg({ subject: 'Taxi', text: 'Taxi 12.00', attachments: [{ filename: 'taxi.pdf', content: fakePdf(4) }] }) },
      ] }));
      const out = await email.receiptsFromMail(mail);
      expect(out.files.map(f => f.filename)).toEqual(['folio.pdf', 'Your Grab E-Receipt.pdf', 'Outer.pdf', 'taxi.pdf']);
      expect(out.skipped).toEqual([{ name: 'inner.eml', why: 'an email inside an attached email' }]);
      expect(out.bodyPdf).toBeNull();
    });

    test('an attached mail that will not open is said to be one', async () => {
      const mail = await email.parseMail(eml({ text: 'see attached', attachments: [{ filename: 'broken.eml', contentType: 'message/rfc822', content: Buffer.from('no headers, no mail') }] }));
      const out = await email.receiptsFromMail(mail);
      expect(out.skipped[0]).toEqual({ name: 'broken.eml', why: 'an attached email that could not be opened' });
    });

    test('at most a hundred receipts are taken from one mail', async () => {
      const attachments = Array.from({ length: email.MAX_FILES + 2 }, (_, i) => ({ filename: `r${i}.pdf`, contentType: 'application/pdf', content: fakePdf(i) }));
      const out = await email.receiptsFromMail(await email.parseMail(eml({ text: 'lots', attachments })));
      expect(out.files).toHaveLength(email.MAX_FILES);
      expect(out.skipped.map(s => s.name)).toEqual([`r${email.MAX_FILES}.pdf`, `r${email.MAX_FILES + 1}.pdf`]);
      expect(out.skipped[0].why).toMatch(/more than 100 receipts/);
    });

    test('an Outlook message with only a body becomes a PDF of it as well', async () => {
      const mail = await email.parseMail(msg({ subject: 'Lunch', text: 'Lunch with client, 42.00 SGD' }));
      const out = await email.receiptsFromMail(mail);
      const { pages } = await require('../pdf/text-extract').extractText(out.bodyPdf);
      expect(pages.join(' ')).toMatch(/Subject: Lunch.*Lunch with client, 42\.00 SGD/s);
    }, SLOW);
  });

  describe('the pieces', () => {
    test('HTML becomes the text a person sees', () => {
      expect(email.htmlToText('<head><title>t</title></head><p>A&nbsp;&amp;&nbsp;B</p><ul><li>one</li><li>two</li></ul><br>&#x41;&#66;&unknown;'))
        .toBe('A & B\n\n• one\n• two\n\nAB&unknown;');
      expect(email.htmlToText('<style>open to the end <p>gone')).toBe('');
      expect(email.htmlToText('')).toBe('');
    });

    // The HTML is whoever sent the mail's to write.
    test('HTML built to make a pattern rescan itself is still read in linear time', () => {
      const started = Date.now();
      email.htmlToText('<style'.repeat(200000));
      email.htmlToText('<!--'.repeat(300000));
      email.htmlToText('<'.repeat(1000000));
      email.htmlToText('<p'.repeat(500000));
      expect(Date.now() - started).toBeLessThan(2000);
    });

    test('the PDF is named after the subject, without what a forward adds or a file name cannot hold', () => {
      expect(email.pdfName('Fwd: RE: Taxi / receipt?')).toBe('Taxi receipt.pdf');
      expect(email.pdfName('FW: Booking: SQ 321 <confirmed>')).toBe('Booking SQ 321 confirmed.pdf');
      expect(email.pdfName('')).toBe('Email.pdf');
      expect(email.pdfName(null)).toBe('Email.pdf');
      expect(email.pdfName('x'.repeat(300))).toBe(`${'x'.repeat(100)}.pdf`);
    });

    test('text is folded to what the PDF fonts draw, currency signs to their codes', () => {
      expect(email.winAnsi('₹500, ₩1000, ฿20, €5, £3, “quoted” – fine')).toBe('INR 500, KRW 1000, THB 20, €5, £3, “quoted” – fine');
      expect(email.winAnsi('東京 100円')).toBe('?? 100 JPY ');
    });
  });
});
