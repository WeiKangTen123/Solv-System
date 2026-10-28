// The claimant's declaration: shown in the "Mark claimed" window
// (ui/src/utils/declaration.js holds the same sentence; a test checks the two
// agree) and printed on the case PDF.
//
// The PDF says "Declared in Solv by …" only for a claim made after the window
// showed these words: the claim's event carries DECLARED_NOTE. A case claimed
// before then was never declared in Solv, and its PDF does not pretend it was.
// No law in Singapore or Malaysia asks for this; it is the company's own
// control, worded on the "wholly and exclusively" test both tax acts use.
const DECLARATION = 'I declare that the expenses in this claim were incurred wholly and exclusively for the business of {company}, are supported by the receipts attached (or explained where there is none), have not been claimed before, and follow the company\'s policy.';
const DECLARED_NOTE = 'with the declaration';

const declarationFor = company => DECLARATION.replace('{company}', String(company || '').trim() || 'the company');

// The claim that put the case where it is: the last "claimed" event, if no
// reopening came after it.
function currentClaim(events = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].action === 'reopened') return null;
    if (events[i].action === 'claimed') return events[i];
  }
  return null;
}

module.exports = { DECLARATION, DECLARED_NOTE, declarationFor, currentClaim };
