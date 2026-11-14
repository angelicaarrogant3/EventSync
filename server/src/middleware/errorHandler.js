const { error } = require('../utils/response');

/**
 * Central Error Handler for EventSync Express API
 * Maps domain errors and SQLite constraint exceptions to clean HTTP responses.
 */
function errorHandler(err, req, res, next) {
  console.error(`[Error] ${req.method} ${req.url}:`, err.message || err);

  // 1. Capacity / Concurrency Conflicts
  if (err.code === 'EVENT_FULL') {
    return error(res, 'EVENT_FULL', err.message, 409);
  }

  if (err.code === 'ALREADY_REGISTERED') {
    return error(res, 'ALREADY_REGISTERED', err.message, 409);
  }

  if (err.code === 'EVENT_NOT_OPEN') {
    return error(res, 'EVENT_NOT_OPEN', err.message, 400);
  }

  if (err.code === 'EVENT_HAS_DATA') {
    return res.status(409).json({
      ok: false,
      error: {
        code: 'EVENT_HAS_DATA',
        message: err.message,
        counts: err.counts || { registrations: 0, attendance: 0 }
      }
    });
  }

  if (err.code === 'CAPACITY_TOO_LOW' || err.code === 'EVENT_ENDED') {
    return error(res, err.code, err.message, 400);
  }

  // 2. Database Constraint Violations
  if (err.code === 'SQLITE_CONSTRAINT' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
    if (err.message.includes('uq_event_participant') || err.message.includes('registrations')) {
      return error(res, 'ALREADY_REGISTERED', 'Participant is already registered for this event.', 409);
    }
    if (err.message.includes('uq_attendance_registration') || err.message.includes('attendance')) {
      return error(res, 'ALREADY_CHECKED_IN', 'Participant is already checked in.', 409);
    }
    return error(res, 'DUPLICATE_ENTRY', 'A unique database constraint was violated.', 409);
  }

  // 3. Not Found
  if (err.code === 'EVENT_NOT_FOUND' || err.message === 'Event not found') {
    return error(res, 'NOT_FOUND', 'Requested resource was not found.', 404);
  }

  // 4. Bad Input / Explicit Domain Status
  if (err.code === 'INVALID_INPUT' || err.code === 'INVALID_STATUS') {
    return error(res, err.code, err.message, 400);
  }

  if (err.status && err.status >= 400 && err.status < 500) {
    return error(res, err.code || 'REQUEST_ERROR', err.message, err.status);
  }

  // 5. Default Internal Server Error
  return error(
    res,
    'INTERNAL_SERVER_ERROR',
    process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : err.message,
    500
  );
}

module.exports = errorHandler;

