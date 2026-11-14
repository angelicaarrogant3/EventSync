const config = require('../config');
const { getSession } = require('../services/auth.service');

const SESSION_COOKIE_NAME = 'eventsync_sid';

/**
 * Parse Cookie header into a key-value map
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Set the httpOnly session cookie
 */
function setSessionCookie(res, sessionId, req = null) {
  const isHttps = config.useHttps || Boolean(req && (req.secure || req.headers['x-forwarded-proto'] === 'https'));
  const maxAgeSec = (config.sessionTimeoutMinutes || 120) * 60;
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (isHttps) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Clear the session cookie
 */
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Attach authenticated user & participant (if any) to req
 */
async function attachSession(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid) {
      const sess = await getSession(sid, { touch: true });
      if (sess) {
        req.sessionId = sess.sessionId;
        req.user = sess.user;
        req.participant = sess.participant;
      } else {
        clearSessionCookie(res);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

function isApiRequest(req) {
  return req.originalUrl.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'));
}

/**
 * Require any authenticated user
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    if (isApiRequest(req)) {
      return res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required. Please log in.' }
      });
    }
    const nextUrl = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${nextUrl}`);
  }
  return next();
}

/**
 * Require a specific application role ('administrator' | 'participant')
 */
function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!req.user) {
      if (isApiRequest(req)) {
        return res.status(401).json({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required. Please log in.' }
        });
      }
      const nextUrl = encodeURIComponent(req.originalUrl || '/');
      return res.redirect(`/login?next=${nextUrl}`);
    }

    if (req.user.role !== requiredRole) {
      if (isApiRequest(req)) {
        return res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have permission to access this resource.' }
        });
      }
      const fallback = req.user.role === 'administrator' ? '/admin' : '/app';
      return res.status(403).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>403 Forbidden - EventSync</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem;}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2rem;max-width:420px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.06);}
a{display:inline-block;margin-top:1rem;padding:0.6rem 1.2rem;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;}</style>
</head><body><div class="card"><h1>403 — Access Denied</h1><p>This page is restricted to ${requiredRole} accounts.</p><a href="${fallback}">Go to Your Dashboard</a></div></body></html>`);
    }

    return next();
  };
}

module.exports = {
  SESSION_COOKIE_NAME,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  attachSession,
  requireAuth,
  requireRole
};
