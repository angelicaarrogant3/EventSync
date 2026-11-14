const express = require('express');
const router = express.Router();
const eventsService = require('../services/events.service');
const attendanceService = require('../services/attendance.service');
const { success, error } = require('../utils/response');
const { broadcastEventUpdated, broadcastEventDeleted } = require('../sockets/socketManager');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');

// GET /api/events?status=&includeArchived=&category=&search=&date=
router.get('/events', requireAuth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'administrator';
    const { status, includeArchived, category, search, date } = req.query;

    // Participants can only browse OPEN, non-archived events
    const effectiveStatus = isAdmin ? (status || null) : 'OPEN';
    const effectiveIncludeArchived = isAdmin && includeArchived === 'true';

    const events = await eventsService.listEvents(effectiveStatus, effectiveIncludeArchived, {
      category,
      search,
      eventDate: date
    });
    return success(res, events);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id
router.get('/events/:id', requireAuth, async (req, res, next) => {
  try {
    const event = await eventsService.getEventById(req.params.id);
    if (!event) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }
    if (req.user.role !== 'administrator' && (event.archived || event.status !== 'OPEN')) {
      return error(res, 'FORBIDDEN', 'This event is not open for public viewing.', 403);
    }
    return success(res, event);
  } catch (err) {
    next(err);
  }
});

// POST /api/events (Admin only)
router.post('/events', requireRole('administrator'), async (req, res, next) => {
  try {
    const nodeId = req.headers['x-node-id'] || 'node-4';
    const event = await eventsService.createEvent(req.body, nodeId, req.user.id);
    broadcastEventUpdated({ event, action: 'CREATE' });
    return success(res, event, 201);
  } catch (err) {
    next(err);
  }
});

// PUT /api/events/:id (Admin only)
router.put('/events/:id', requireRole('administrator'), async (req, res, next) => {
  try {
    const nodeId = req.headers['x-node-id'] || 'node-4';
    const event = await eventsService.updateEvent(req.params.id, req.body, nodeId, req.user.id);
    if (!event) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }
    broadcastEventUpdated({ event, action: 'UPDATE' });
    return success(res, event);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/events/:id/status (Admin only)
router.patch('/events/:id/status', requireRole('administrator'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) {
      return error(res, 'MISSING_STATUS', 'Status field is required', 400);
    }
    const nodeId = req.headers['x-node-id'] || 'node-4';
    const event = await eventsService.updateEventStatus(req.params.id, status, nodeId, req.user.id);
    if (!event) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }
    broadcastEventUpdated({ event, action: 'STATUS_CHANGE' });
    return success(res, event);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/events/:id?force=true&archive=true (Admin only)
router.delete('/events/:id', requireRole('administrator'), async (req, res, next) => {
  try {
    const force = req.query.force === 'true';
    const archive = req.query.archive === 'true';
    const nodeId = req.headers['x-node-id'] || 'node-4';

    const result = await eventsService.deleteEvent(req.params.id, { force, archive }, nodeId, req.user.id);
    if (!result) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }

    broadcastEventDeleted({
      eventId: result.eventId,
      title: result.title,
      action: result.action,
      archived: result.action === 'ARCHIVED',
      counts: result.counts
    });
    broadcastEventUpdated({
      event: result.event || { id: result.eventId, title: result.title },
      action: result.action
    });

    return success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id/stats (Admin only)
router.get('/events/:id/stats', requireRole('administrator'), async (req, res, next) => {
  try {
    const stats = await eventsService.getEventStats(req.params.id);
    if (!stats) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }
    return success(res, stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id/attendance/live (Admin only)
router.get('/events/:id/attendance/live', requireRole('administrator'), async (req, res, next) => {
  try {
    const snapshot = await attendanceService.getLiveAttendance(req.params.id);
    if (!snapshot) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }
    return success(res, snapshot);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
