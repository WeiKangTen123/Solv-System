// An error meant for the person who asked. Its status and message go back as
// they are (index.js shows any error marked `expose`), and anything in `extra`
// is added to the JSON answer. Everything else that reaches the error handler
// is ours, logged in full and answered as a plain 500.
//
// Domain code throws these instead of returning { status, error } objects or
// building an Error and setting .status by hand, which is how one service
// came to answer the same refusal four different ways.
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = status < 500;
    if (extra) this.extra = extra;
  }
}

const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

module.exports = { HttpError, fail };
