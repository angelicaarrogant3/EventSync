const express = require('express');
const router = express.Router();
const attendanceService = require('../services/attendance.service');
const { getEventStats } = require('../services/events.service');
const { success, error } = require('../utils/response');
const { broadcastAttendanceCheckedIn } = require('../sockets/socketManager');
const { requireRole } = require('../middleware/auth.middleware');

function emitAttendanceUpdate(result, eventId) {
  if (result.status === 'VALID' && !result.isIdempotentReplay) {
    const stats = getEventStats(eventId);
    broadcastAttendanceCheckedIn({
      eventId,
      attendance: result.attendance,
      participant: result.participant,
      event: result.event,
      wasOfflineSync: Boolean(result.attendance.was_offline_sync),
      stats
    });
  }
}

// POST /api/attendance/scan (Admin only)
router.post('/attendance/scan', requireRole('administrator'), (req, res, next) => {
  try {
    const { eventId, qrToken, clientScanId, scannedAt } = req.body;
    if (!eventId || !qrToken) {
      return error(res, 'INVALID_INPUT', 'eventId and qrToken are required', 400);
    }

    const nodeId = req.headers['x-node-id'] || 'node-3';
    const result = attendanceService.verifyAndCheckIn({
      eventId,
      qrToken,
      clientScanId,
      scannedAt,
      scannedByNode: nodeId,
      verifiedByUserId: req.user.id,
      wasOfflineSync: false
    });

    emitAttendanceUpdate(result, eventId);

    if (result.status === 'ALREADY_CHECKED_IN') {
      return res.status(409).json({
        ok: false,
        error: {
          code: 'ALREADY_CHECKED_IN',
          message: result.message,
          originalCheckIn: result.originalCheckIn,
          participant: result.participant
        }
      });
    }

    if (result.status !== 'VALID') {
      return res.status(result.code || 400).json({
        ok: false,
        error: {
          code: result.status,
          message: result.message
        }
      });
    }

    return success(res, result, 200);
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/sync (Admin only)
router.post('/attendance/sync', requireRole('administrator'), (req, res, next) => {
  try {
    const scans = req.body;
    if (!Array.isArray(scans)) {
      return error(res, 'INVALID_PAYLOAD', 'Expected an array of queued scan objects', 400);
    }

    const nodeId = req.headers['x-node-id'] || 'node-3';
    const syncReport = attendanceService.processSyncBatch(scans, nodeId, req.user.id);

    for (const item of syncReport.results) {
      if (item.status === 'VALID' && !item.isIdempotentReplay) {
        emitAttendanceUpdate(item, item.attendance.event_id);
      }
    }

    return success(res, syncReport, 200);
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/manual (Admin only)
router.post('/attendance/manual', requireRole('administrator'), (req, res, next) => {
  try {
    const { eventId, schoolId, clientScanId } = req.body;
    if (!eventId || !schoolId) {
      return error(res, 'INVALID_INPUT', 'eventId and schoolId are required', 400);
    }

    const nodeId = req.headers['x-node-id'] || 'node-3';
    const result = attendanceService.manualCheckIn({
      eventId,
      schoolId,
      clientScanId,
      scannedByNode: nodeId,
      verifiedByUserId: req.user.id
    });

    emitAttendanceUpdate(result, eventId);

    if (result.status === 'ALREADY_CHECKED_IN') {
      return res.status(409).json({
        ok: false,
        error: {
          code: 'ALREADY_CHECKED_IN',
          message: result.message,
          originalCheckIn: result.originalCheckIn,
          participant: result.participant
        }
      });
    }

    if (result.status !== 'VALID') {
      return res.status(result.code || 400).json({
        ok: false,
        error: {
          code: result.status,
          message: result.message
        }
      });
    }

    return success(res, result, 200);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
