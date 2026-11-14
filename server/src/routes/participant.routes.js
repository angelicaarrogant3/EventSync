const express = require('express');
const router = express.Router();
const { db } = require('../db/connection');
const registrationsService = require('../services/registrations.service');
const attendanceService = require('../services/attendance.service');
const { logActivity } = require('../services/activity.service');
const { success, error } = require('../utils/response');
const { requireAuth } = require('../middleware/auth.middleware');
const { broadcastRegistrationCreated } = require('../sockets/socketManager');

// GET /api/my/profile
router.get('/my/profile', requireAuth, (req, res) => {
  return success(res, {
    user: req.user,
    participant: req.participant || null
  });
});

// PUT /api/my/profile
router.put('/my/profile', requireAuth, (req, res, next) => {
  try {
    const { full_name, email, contact_number, department_or_course, year_level } = req.body || {};
    const cleanName = full_name ? String(full_name).trim() : req.user.full_name;
    const cleanEmail = email ? String(email).trim().toLowerCase() : req.user.email;

    if (!cleanName || !cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return error(res, 'INVALID_INPUT', 'Valid full name and email are required.', 400);
    }

    const dupEmail = db.prepare(`SELECT id FROM users WHERE lower(email) = ? AND id != ?`).get(cleanEmail, req.user.id);
    if (dupEmail) {
      return error(res, 'DUPLICATE_EMAIL', 'That email address is already used by another account.', 409);
    }

    db.prepare(`UPDATE users SET full_name = ?, email = ? WHERE id = ?`).run(cleanName, cleanEmail, req.user.id);

    if (req.participant) {
      db.prepare(`
        UPDATE participants
        SET full_name = ?, email = ?, contact_number = ?, department_or_course = ?, year_level = ?
        WHERE id = ?
      `).run(
        cleanName,
        cleanEmail,
        contact_number !== undefined ? String(contact_number).trim() : (req.participant.contact_number || ''),
        department_or_course !== undefined ? String(department_or_course).trim() : req.participant.department_or_course,
        year_level !== undefined ? String(year_level).trim() : req.participant.year_level,
        req.participant.id
      );
    }

    logActivity({
      userId: req.user.id,
      action: 'PROFILE_UPDATED',
      description: `User "${req.user.username}" updated their profile.`
    });

    const updatedUser = db.prepare(`SELECT id, full_name, username, email, role, account_status, must_change_password, created_at FROM users WHERE id = ?`).get(req.user.id);
    const updatedParticipant = db.prepare(`SELECT * FROM participants WHERE user_id = ?`).get(req.user.id) || null;
    return success(res, { user: updatedUser, participant: updatedParticipant });
  } catch (err) {
    next(err);
  }
});

// GET /api/my/events (Participant's own registrations + QR codes)
router.get('/my/events', requireAuth, async (req, res, next) => {
  try {
    const list = await registrationsService.getRegistrationsByUser(req.user.id);
    return success(res, list);
  } catch (err) {
    next(err);
  }
});

// POST /api/my/registrations (Participant self-registers for an OPEN event)
router.post('/my/registrations', requireAuth, async (req, res, next) => {
  try {
    const { eventId } = req.body || {};
    if (!eventId) {
      return error(res, 'INVALID_INPUT', 'eventId is required', 400);
    }
    if (!req.participant) {
      return error(res, 'NO_PARTICIPANT_PROFILE', 'Your account does not have a participant profile.', 400);
    }

    const result = await registrationsService.registerParticipant({
      eventId,
      participant: req.participant,
      nodeId: 'participant-portal',
      registeredByUserId: req.user.id
    });

    broadcastRegistrationCreated({
      eventId,
      registration: result.registration,
      participant: result.participant,
      remainingCapacity: result.remainingCapacity
    });

    return success(res, result, 201);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/my/registrations/:id (Participant cancels own registration)
router.delete('/my/registrations/:id', requireAuth, async (req, res, next) => {
  try {
    const reg = await registrationsService.getRegistrationById(req.params.id);
    if (!reg) {
      return error(res, 'NOT_FOUND', 'Registration not found', 404);
    }
    if (reg.participant_user_id !== req.user.id) {
      return error(res, 'FORBIDDEN', 'You can only cancel your own registration.', 403);
    }
    const result = registrationsService.cancelRegistration(req.params.id, 'participant-portal', req.user.id);
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/my/attendance (Participant's own attendance history)
router.get('/my/attendance', requireAuth, (req, res, next) => {
  try {
    const rows = attendanceService.getAttendanceByUser(req.user.id);
    return success(res, rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
