const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const { logActivity } = require('../services/activity.service');
const { success, error } = require('../utils/response');
const { setSessionCookie, clearSessionCookie, requireAuth } = require('../middleware/auth.middleware');

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = fwd ? String(fwd).split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || '127.0.0.1');
  return raw.replace(/^.*:/, '');
}

// POST /api/auth/signup (Public participant signup — always role='participant')
router.post('/auth/signup', (req, res, next) => {
  try {
    const result = authService.signupParticipant(req.body || {});
    return success(res, {
      user: result.user,
      participant: result.participant,
      message: 'Account created successfully. You can now log in.'
    }, 201);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/auth/login', (req, res, next) => {
  try {
    const { username, email, usernameOrEmail, password } = req.body || {};
    const identifier = usernameOrEmail || username || email;
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = authService.loginUser({
      usernameOrEmail: identifier,
      password,
      ip,
      userAgent
    });

    setSessionCookie(res, result.sessionId, req);
    const redirectTo = result.user.role === 'administrator' ? '/admin' : '/app';

    return success(res, {
      user: result.user,
      participant: result.participant,
      redirectTo
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  if (req.sessionId) {
    authService.deleteSession(req.sessionId);
  }
  if (req.user) {
    logActivity({
      userId: req.user.id,
      action: 'LOGOUT',
      description: `${req.user.role} "${req.user.username}" logged out.`
    });
  }
  clearSessionCookie(res);
  return success(res, { loggedOut: true });
});

// GET /api/auth/me
router.get('/auth/me', requireAuth, (req, res) => {
  return success(res, {
    user: req.user,
    participant: req.participant || null
  });
});

// POST /api/auth/change-password
router.post('/auth/change-password', requireAuth, (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const updated = authService.changeOwnPassword(req.user.id, currentPassword, newPassword);
    return success(res, { user: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
