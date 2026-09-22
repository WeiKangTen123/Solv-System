// The schema version a migrated database ends on.
//
// It lives here rather than in migrate.js because asking migrate.js for it
// opens the database as a side effect — requiring it loads db/index.js, which
// creates the file and sets journal_mode. preflight reports which schema a box
// is on without touching it, and that require left an empty app.db behind:
// run under sudo, one owned by root that the application could then not write.
//
// migrate.test.js holds this to the highest step declared in migrate.js.
module.exports = { LATEST: 3 };
