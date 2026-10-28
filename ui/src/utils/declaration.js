// The words a claimant agrees to by marking a case claimed. The server keeps
// the same sentence (main/reports/declaration.js) and prints it on the case
// PDF, saying it was declared in Solv only for a claim made after this window
// showed it; a test checks the two copies agree.
export const DECLARATION = 'I declare that the expenses in this claim were incurred wholly and exclusively for the business of {company}, are supported by the receipts attached (or explained where there is none), have not been claimed before, and follow the company\'s policy.';

export const declarationFor = company => DECLARATION.replace('{company}', String(company || '').trim() || 'the company');
