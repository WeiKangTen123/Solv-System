const logger = require('../utils/logger');

// The last middleware: what any error that reaches it looks like to the caller.
// In its own module so a route's test answers exactly as the server does.
//
// A body that is too large or not JSON is the caller's mistake and says so;
// an error made to be shown (`expose`, as utils/http-error sets) is shown;
// everything else is ours, logged in full and answered without the details.
// A route that had already started its answer cannot be given a second one:
// Express is handed the error and closes the connection, rather than this
// throwing ERR_HTTP_HEADERS_SENT and leaving the client to time out.
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status < 500) {
    const msg = err.type === 'entity.too.large' ? 'That request is too large.'
      : err.type === 'entity.parse.failed' ? 'That request is not valid JSON.'
      : err.expose && err.message ? err.message : 'Bad request';
    return res.status(status).json({ error: msg, ...(err.expose && err.extra ? err.extra : {}) });
  }
  logger.error('Unhandled error', { requestId: req.id, method: req.method, path: String(req.originalUrl || '').split('?')[0], error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
};
