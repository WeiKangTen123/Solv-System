const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');
const users   = require('../store/users');
const asyncHandler = require('../middleware/async-handler');
const { HttpError } = require('../utils/http-error');
const { parseMail } = require('../intake/email');
const { storeMail, checkCase } = require('./receipts');
const logger  = require('../utils/logger');

// Mail forwarded to a person's own address, receipts+<token>@<domain>, posted
// here as it arrived by the mail provider (docs/RUNBOOK.md, "Receipts by
// email": a Cloudflare Email Worker). Mounted at /api/inbound, outside the
// session sign-in: the provider proves itself with INBOUND_EMAIL_SECRET, and
// the address says whose mail it is.
//
// The address is not a secret anyone has to keep, so it is not what lets a
// mail in: only mail from the person's own address is taken. Anybody else's
// is answered 202 and dropped, so the provider has nothing to retry and the
// sender learns nothing. A forged From could at worst add receipts to the
// person's pile, which they check like any other before claiming; nothing
// here moves money or sends anything anywhere.
//
// What is taken goes in "Not in a case", unless the subject names one of the
// person's open cases by number (EXP-2026-0002). No case is ever made here.

// Each mail is up to as many reads as it has receipts, so a person's address
// takes this many a day; the rest are refused until the day has rolled on.
const DAILY_LIMIT = 100;
// What Cloudflare's Email Routing takes in a message, and so the most it can post.
const MAX_BYTES = '25mb';

const NO_SUCH_ADDRESS = { error: 'No such address' };
const TOO_MANY = { error: `This address has taken ${DAILY_LIMIT} emails in the last day. Try again later.` };

function configured() { return !!(process.env.INBOUND_EMAIL_DOMAIN && process.env.INBOUND_EMAIL_SECRET); }

// Compared as digests, which are the same length whatever was sent, so the
// time the comparison takes says nothing about the secret.
function _secretMatches(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  if (!m) return false;
  const digest = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(digest(m[1]), digest(process.env.INBOUND_EMAIL_SECRET));
}

// Off, and then not the provider: both answered before a byte of the body is
// read, so nobody else can make the server parse 25 MB.
function gate(req, res, next) {
  if (!configured()) return res.status(404).json({ error: 'Not found' });
  if (!_secretMatches(req.get('authorization'))) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// receipts+<token>@<INBOUND_EMAIL_DOMAIN>, in any case, bare or in <>.
function tokenOf(address) {
  const raw = String(address || '').trim();
  const bare = (/<([^<>]+)>/.exec(raw) || [null, raw])[1].trim();
  const m = /^receipts\+([a-z0-9]+)@([^\s@]+)$/i.exec(bare);
  return m && m[2].toLowerCase() === users.inboundDomain() ? m[1].toLowerCase() : null;
}
// A removed person's address takes nothing, as they can no longer sign in.
function personFor(token) {
  const u = token ? users.findByInboundToken(token) : null;
  return u && !u.removed ? u : null;
}

// The recipient the provider names (the Worker passes message.to as ?to=,
// a mail server X-Original-To) is known before the body is read, and so is
// whether the person is over their limit.
function knownRecipient(req, res, next) {
  const named = req.query.to || req.get('x-original-to');
  if (!named) return next();
  const person = personFor(tokenOf(named));
  if (!person) return res.status(404).json(NO_SUCH_ADDRESS);
  if (users.inboundMailsLastDay(person.id) >= DAILY_LIMIT) return res.status(429).json(TOO_MANY);
  req.inboundPerson = person;
  next();
}

// Any content type, or none: providers label a raw message differently.
const rawBody = express.raw({ type: () => true, limit: MAX_BYTES });

// The first case number in the subject that is one of the person's own and
// still takes receipts (routes/receipts.js checkCase), else null.
const CASE_NUMBER = /\bEXP-\d{4}-\d{4}\b/gi;
function caseFromSubject(person, subject) {
  for (const [number] of String(subject || '').matchAll(CASE_NUMBER)) {
    const row = db.prepare('SELECT id FROM expense_reports WHERE company_id = ? AND user_id = ? AND number = ?').get(person.companyId, person.id, number.toUpperCase());
    if (row && !checkCase(person, row.id)) return row.id;
  }
  return null;
}

const _sameAddress = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

router.post('/email', gate, knownRecipient, rawBody, asyncHandler(async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  if (!body || !body.length) return res.status(400).json({ error: 'The message is empty.' });
  let mail;
  try {
    mail = await parseMail(body);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  let person = req.inboundPerson || null;
  if (!person) {
    person = personFor(mail.to.map(tokenOf).find(Boolean));
    if (!person) return res.status(404).json(NO_SUCH_ADDRESS);
    if (users.inboundMailsLastDay(person.id) >= DAILY_LIMIT) return res.status(429).json(TOO_MANY);
  }

  // Who it was from is the person's business, and what it said is theirs too:
  // the log says only that a mail was dropped, and for whom.
  if (!_sameAddress(mail.from, person.email)) {
    logger.warn('Inbound email dropped: not sent from its owner\'s address', { userId: person.id });
    return res.status(202).json({ dropped: 'sender' });
  }

  // Counted before anything is stored, so a mail that fails halfway still counts.
  users.recordInboundMail(person.id);
  const reportId = caseFromSubject(person, mail.subject);
  const out = await storeMail(person, mail, { reportId });
  logger.info('Inbound email taken', { userId: person.id, reportId, stored: out.stored.length, skipped: out.skipped.length });
  res.status(202).json({ stored: out.stored.length, skipped: out.skipped, reportId });
}));

module.exports = router;
module.exports.DAILY_LIMIT = DAILY_LIMIT;
module.exports._tokenOf = tokenOf;
