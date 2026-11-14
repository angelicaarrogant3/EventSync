const express = require('express');
const router = express.Router();
const registrationsService = require('../services/registrations.service');
const { success, error } = require('../utils/response');
const { broadcastRegistrationCreated } = require('../sockets/socketManager');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');

// GET /api/events/:id/registrations (Admin only)
router.get('/events/:id/registrations', requireRole('administrator'), async (req, res, next) => {
  try {
    const list = await registrationsService.getRegistrationsByEvent(req.params.id);
    return success(res, list);
  } catch (err) {
    next(err);
  }
});

// POST /api/registrations (Admin-assisted registration)
router.post('/registrations', requireRole('administrator'), async (req, res, next) => {
  try {
    const { eventId, participant, createAccount = false, tempPassword = null } = req.body;
    if (!eventId || !participant) {
      return error(res, 'INVALID_PAYLOAD', 'eventId and participant details are required', 400);
    }

    const nodeId = req.headers['x-node-id'] || 'node-2';
    const result = await registrationsService.registerParticipant({
      eventId,
      participant,
      nodeId,
      registeredByUserId: req.user.id,
      createAccount: Boolean(createAccount),
      tempPassword
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

// GET /api/registrations/lookup?eventId=...&schoolId=... (Admin only)
router.get('/registrations/lookup', requireRole('administrator'), async (req, res, next) => {
  try {
    const { eventId, schoolId } = req.query;
    if (!eventId || !schoolId) {
      return error(res, 'MISSING_PARAMS', 'eventId and schoolId are required query parameters', 400);
    }

    const registration = await registrationsService.findRegistrationBySchoolId(eventId, schoolId);
    if (!registration) {
      return error(res, 'NOT_FOUND', 'No registration found for this school ID and event', 404);
    }

    return success(res, registration);
  } catch (err) {
    next(err);
  }
});

// GET /api/registrations/:id (Admin or owning Participant)
router.get('/registrations/:id', requireAuth, async (req, res, next) => {
  try {
    const registration = await registrationsService.getRegistrationById(req.params.id);
    if (!registration) {
      return error(res, 'NOT_FOUND', 'Registration not found', 404);
    }
    if (req.user.role !== 'administrator' && registration.participant_user_id !== req.user.id) {
      return error(res, 'FORBIDDEN', 'You can only view your own registrations.', 403);
    }
    return success(res, registration);
  } catch (err) {
    next(err);
  }
});

// GET /api/registrations/:id/qr (Admin or owning Participant)
router.get('/registrations/:id/qr', requireAuth, async (req, res, next) => {
  try {
    const registration = await registrationsService.getRegistrationById(req.params.id);
    if (!registration) {
      return error(res, 'NOT_FOUND', 'Registration not found', 404);
    }
    if (req.user.role !== 'administrator' && registration.participant_user_id !== req.user.id) {
      return error(res, 'FORBIDDEN', 'You can only access your own QR code.', 403);
    }
    return success(res, {
      id: registration.id,
      qrToken: registration.qr_token,
      tokenVersion: registration.token_version || 1,
      qrDataUrl: registration.qrDataUrl
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/registrations/:id/reissue (Admin only — invalidates old QR)
router.post('/registrations/:id/reissue', requireRole('administrator'), async (req, res, next) => {
  try {
    const updated = await registrationsService.reissueQrToken(req.params.id, req.user.id);
    if (!updated) {
      return error(res, 'NOT_FOUND', 'Registration not found', 404);
    }
    return success(res, updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/registrations/:id (Admin or owning Participant)
router.delete('/registrations/:id', requireAuth, async (req, res, next) => {
  try {
    const existing = await registrationsService.getRegistrationById(req.params.id);
    if (!existing) {
      return error(res, 'NOT_FOUND', 'Registration not found', 404);
    }
    if (req.user.role !== 'administrator' && existing.participant_user_id !== req.user.id) {
      return error(res, 'FORBIDDEN', 'You can only cancel your own registration.', 403);
    }
    const nodeId = req.headers['x-node-id'] || (req.user.role === 'administrator' ? 'node-4' : 'participant-portal');
    const result = await registrationsService.cancelRegistration(req.params.id, nodeId, req.user.id);
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
