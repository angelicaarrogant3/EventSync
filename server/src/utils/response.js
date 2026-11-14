/**
 * Standardized API response format for EventSync.
 * Guarantees uniform structure across all REST endpoints.
 */

function success(res, data = null, statusCode = 200) {
  return res.status(statusCode).json({
    ok: true,
    data
  });
}

function error(res, code, message, statusCode = 400, details = null) {
  const payload = {
    ok: false,
    error: {
      code,
      message
    }
  };

  if (details) {
    payload.error.details = details;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  success,
  error
};

