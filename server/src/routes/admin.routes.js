const express = require('express');
const router = express.Router();
const { db } = require('../db/connection');
const authService = require('../services/auth.service');
const { listActivityLogs } = require('../services/activity.service');
const { success, error } = require('../utils/response');
const { requireRole } = require('../middleware/auth.middleware');

// All /api/admin/* routes strictly require administrator role
router.use('/admin', requireRole('administrator'));

// GET /api/admin/users?role=&status=
router.get('/admin/users', (req, res, next) => {
  try {
    const users = authService.listUsers({
      role: req.query.role || null,
      status: req.query.status || null
    });
    return success(res, users);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/admin (Create another Administrator)
router.post('/admin/users/admin', (req, res, next) => {
  try {
    const { full_name, username, email, password } = req.body || {};
    const admin = authService.createAdministrator({
      full_name,
      username,
      email,
      password,
      actorUserId: req.user.id
    });
    return success(res, admin, 201);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/status
router.patch('/admin/users/:id/status', (req, res, next) => {
  try {
    const { account_status } = req.body || {};
    const updated = authService.setAccountStatus(req.params.id, account_status, req.user.id);
    return success(res, updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/reset-password
router.post('/admin/users/:id/reset-password', (req, res, next) => {
  try {
    const { tempPassword } = req.body || {};
    if (!tempPassword) {
      return error(res, 'INVALID_INPUT', 'tempPassword is required.', 400);
    }
    const updated = authService.resetUserPassword(req.params.id, tempPassword, req.user.id);
    return success(res, updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/participants?search=
router.get('/admin/participants', (req, res, next) => {
  try {
    const search = req.query.search ? `%${String(req.query.search).trim()}%` : null;
    const where = search ? `WHERE p.full_name LIKE ? OR p.school_id LIKE ? OR p.email LIKE ? OR p.department_or_course LIKE ?` : '';
    const params = search ? [search, search, search, search] : [];

    const rows = db.prepare(`
      SELECT
        p.*,
        u.username,
        u.account_status,
        COUNT(DISTINCT CASE WHEN r.status = 'REGISTERED' THEN r.id END) AS registration_count,
        COUNT(DISTINCT a.id) AS attendance_count
      FROM participants p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN registrations r ON p.id = r.participant_id
      LEFT JOIN attendance a ON r.id = a.registration_id
      ${where}
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all(...params);

    return success(res, rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/records?eventId=&search=
router.get('/admin/records', (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.eventId) {
      conditions.push('r.event_id = ?');
      params.push(req.query.eventId);
    }
    if (req.query.search) {
      const like = `%${String(req.query.search).trim()}%`;
      conditions.push('(p.full_name LIKE ? OR p.school_id LIKE ? OR e.title LIKE ?)');
      params.push(like, like, like);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        r.id AS registration_id,
        r.status AS registration_status,
        r.registered_at,
        r.registered_by_node,
        r.token_version,
        e.id AS event_id,
        e.title AS event_title,
        e.event_date,
        e.status AS event_status,
        p.school_id,
        p.full_name,
        p.email,
        p.department_or_course,
        p.year_level,
        a.id AS attendance_id,
        a.checked_in_at,
        a.scanned_by_node,
        a.was_offline_sync,
        CASE
          WHEN a.id IS NOT NULL THEN 'PRESENT'
          WHEN e.status IN ('COMPLETED', 'ENDED') THEN 'ABSENT'
          ELSE 'PENDING'
        END AS attendance_status
      FROM registrations r
      JOIN events e ON r.event_id = e.id
      JOIN participants p ON r.participant_id = p.id
      LEFT JOIN attendance a ON r.id = a.registration_id
      ${where}
      ORDER BY r.registered_at DESC
      LIMIT 300
    `).all(...params);

    return success(res, rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/activity?action=&search=&limit=
router.get('/admin/activity', (req, res, next) => {
  try {
    const logs = listActivityLogs({
      action: req.query.action || null,
      search: req.query.search || null,
      limit: req.query.limit || 150
    });
    return success(res, logs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
