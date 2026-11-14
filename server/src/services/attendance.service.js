const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/connection');
const { verifySignedQrToken } = require('../utils/crypto');
const { logActivity } = require('./activity.service');

function verifyAndCheckIn({
  eventId,
  qrToken,
  clientScanId = uuidv4(),
  scannedAt = null,
  scannedByNode = 'node-3',
  verifiedByUserId = null,
  wasOfflineSync = false
}) {
  const tokenResult = verifySignedQrToken(qrToken);
  if (!tokenResult.valid) {
    return {
      status: 'INVALID_TOKEN',
      code: 400,
      message: 'QR Token cryptographic verification failed: ' + tokenResult.reason,
      clientScanId
    };
  }

  const { registrationId, eventId: tokenEventId, tokenVersion = 1 } = tokenResult;

  if (tokenEventId !== eventId) {
    return {
      status: 'WRONG_EVENT',
      code: 400,
      message: 'This QR code was issued for a different event.',
      clientScanId
    };
  }

  const getEventStmt = db.prepare(`SELECT * FROM events WHERE id = ?`);
  const getRegStmt = db.prepare(`
    SELECT r.*, p.school_id, p.full_name, p.email, p.department_or_course, p.year_level, p.role, p.user_id AS participant_user_id
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    WHERE r.id = ?
  `);
  const getAttendanceByClientScanStmt = db.prepare(`
    SELECT a.*, p.full_name, p.school_id
    FROM attendance a
    JOIN registrations r ON a.registration_id = r.id
    JOIN participants p ON r.participant_id = p.id
    WHERE a.client_scan_id = ?
  `);
  const getExistingAttendanceStmt = db.prepare(`
    SELECT a.*, p.full_name, p.school_id, p.department_or_course
    FROM attendance a
    JOIN registrations r ON a.registration_id = r.id
    JOIN participants p ON r.participant_id = p.id
    WHERE a.registration_id = ?
  `);

  const insertAttendanceStmt = db.prepare(`
    INSERT INTO attendance (id, registration_id, event_id, checked_in_at, scanned_by_node, verified_by_user_id, client_scan_id, was_offline_sync)
    VALUES (?, ?, ?, COALESCE(?, datetime('now', 'localtime')), ?, ?, ?, ?)
  `);

  const auditStmt = db.prepare(`
    INSERT INTO audit_log (id, action, entity, entity_id, node_id, details_json)
    VALUES (?, 'CHECK_IN', 'ATTENDANCE', ?, ?, ?)
  `);

  let finalResult = null;

  const checkInTx = db.transaction(() => {
    const event = getEventStmt.get(eventId);
    if (!event) {
      finalResult = {
        status: 'EVENT_NOT_FOUND',
        code: 404,
        message: 'Event no longer exists.',
        clientScanId
      };
      return;
    }

    if (!['OPEN', 'ONGOING'].includes(event.status)) {
      finalResult = {
        status: 'EVENT_NOT_OPEN',
        code: 400,
        message: `Event attendance is closed. Current status: ${event.status}`,
        clientScanId
      };
      return;
    }

    const registration = getRegStmt.get(registrationId);
    if (!registration) {
      finalResult = {
        status: 'REGISTRATION_NOT_FOUND',
        code: 404,
        message: 'No registration record found for this QR token.',
        clientScanId
      };
      return;
    }

    if ((registration.token_version || 1) !== tokenVersion) {
      finalResult = {
        status: 'INVALID_TOKEN',
        code: 400,
        message: 'This QR pass has been reissued and is no longer valid.',
        clientScanId
      };
      return;
    }

    if (registration.status === 'CANCELLED') {
      finalResult = {
        status: 'REGISTRATION_CANCELLED',
        code: 400,
        message: 'This registration was cancelled.',
        clientScanId,
        participant: {
          fullName: registration.full_name,
          schoolId: registration.school_id
        }
      };
      return;
    }

    const existingScan = getAttendanceByClientScanStmt.get(clientScanId);
    if (existingScan) {
      finalResult = {
        status: 'VALID',
        code: 200,
        message: 'Attendance already recorded idempotently via this scan ID.',
        attendance: existingScan,
        participant: {
          fullName: existingScan.full_name,
          schoolId: existingScan.school_id,
          userId: registration.participant_user_id || null
        },
        event: { id: event.id, title: event.title },
        clientScanId,
        isIdempotentReplay: true
      };
      return;
    }

    const existingAttendance = getExistingAttendanceStmt.get(registrationId);
    if (existingAttendance) {
      finalResult = {
        status: 'ALREADY_CHECKED_IN',
        code: 409,
        message: `Already checked in at ${existingAttendance.checked_in_at} by ${existingAttendance.scanned_by_node}`,
        originalCheckIn: existingAttendance,
        participant: {
          fullName: existingAttendance.full_name,
          schoolId: existingAttendance.school_id,
          department: existingAttendance.department_or_course
        },
        clientScanId
      };
      return;
    }

    const attendanceId = uuidv4();
    const isOffline = wasOfflineSync ? 1 : 0;

    insertAttendanceStmt.run(
      attendanceId,
      registrationId,
      eventId,
      scannedAt,
      scannedByNode,
      verifiedByUserId || null,
      clientScanId,
      isOffline
    );

    auditStmt.run(
      uuidv4(),
      attendanceId,
      scannedByNode,
      JSON.stringify({ eventId, registrationId, clientScanId, wasOfflineSync, verifiedByUserId })
    );

    const recordedAttendance = db.prepare(`SELECT * FROM attendance WHERE id = ?`).get(attendanceId);

    finalResult = {
      status: 'VALID',
      code: 200,
      message: 'Attendance verified successfully.',
      attendance: recordedAttendance,
      participant: {
        id: registration.participant_id,
        userId: registration.participant_user_id || null,
        schoolId: registration.school_id,
        fullName: registration.full_name,
        email: registration.email,
        departmentOrCourse: registration.department_or_course,
        yearLevel: registration.year_level,
        role: registration.role
      },
      event: {
        id: event.id,
        title: event.title,
        venue: event.venue
      },
      clientScanId
    };
  });

  checkInTx();

  if (finalResult && finalResult.status === 'VALID' && !finalResult.isIdempotentReplay) {
    logActivity({
      userId: verifiedByUserId,
      action: 'ATTENDANCE_SCAN',
      description: `Checked in "${finalResult.participant.fullName}" (${finalResult.participant.schoolId}) for "${finalResult.event.title}".`
    });
  }

  return finalResult;
}

function processSyncBatch(scans = [], scannedByNode = 'node-3', verifiedByUserId = null) {
  if (!Array.isArray(scans) || scans.length === 0) {
    return { syncedCount: 0, results: [] };
  }

  const results = [];
  let successCount = 0;

  for (const scan of scans) {
    const { eventId, qrToken, clientScanId, scannedAt } = scan;
    const result = verifyAndCheckIn({
      eventId,
      qrToken,
      clientScanId,
      scannedAt,
      scannedByNode,
      verifiedByUserId,
      wasOfflineSync: true
    });

    results.push(result);
    if (result.status === 'VALID') {
      successCount++;
    }
  }

  return {
    totalSubmitted: scans.length,
    syncedCount: successCount,
    results
  };
}

function manualCheckIn({
  eventId,
  schoolId,
  clientScanId = uuidv4(),
  scannedByNode = 'node-3',
  verifiedByUserId = null
}) {
  if (!eventId || !schoolId) {
    return {
      status: 'INVALID_INPUT',
      code: 400,
      message: 'eventId and schoolId are required.',
      clientScanId
    };
  }

  const reg = db.prepare(`
    SELECT r.id, r.qr_token, r.status
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    WHERE r.event_id = ? AND p.school_id = ?
  `).get(eventId, String(schoolId).trim());

  if (!reg) {
    return {
      status: 'REGISTRATION_NOT_FOUND',
      code: 404,
      message: `No registration found for School ID '${schoolId}' in this event.`,
      clientScanId
    };
  }

  return verifyAndCheckIn({
    eventId,
    qrToken: reg.qr_token,
    clientScanId,
    scannedAt: null,
    scannedByNode,
    verifiedByUserId,
    wasOfflineSync: false
  });
}

function getLiveAttendance(eventId) {
  const event = db.prepare(`
    SELECT 
      e.*,
      COALESCE(r.reg_count, 0) AS registered_count,
      COALESCE(a.att_count, 0) AS checked_in_count,
      (e.capacity - COALESCE(r.reg_count, 0)) AS remaining_capacity
    FROM events e
    LEFT JOIN (
      SELECT event_id, COUNT(*) AS reg_count
      FROM registrations
      WHERE status = 'REGISTERED' AND event_id = ?
      GROUP BY event_id
    ) r ON e.id = r.event_id
    LEFT JOIN (
      SELECT event_id, COUNT(*) AS att_count
      FROM attendance
      WHERE event_id = ?
      GROUP BY event_id
    ) a ON e.id = a.event_id
    WHERE e.id = ?
  `).get(eventId, eventId, eventId);

  if (!event) return null;

  const recentCheckIns = db.prepare(`
    SELECT 
      a.id,
      a.checked_in_at,
      a.scanned_by_node,
      a.verified_by_user_id,
      a.was_offline_sync,
      p.school_id,
      p.full_name,
      p.department_or_course,
      p.year_level,
      p.role
    FROM attendance a
    JOIN registrations r ON a.registration_id = r.id
    JOIN participants p ON r.participant_id = p.id
    WHERE a.event_id = ?
    ORDER BY a.checked_in_at DESC
    LIMIT 50
  `).all(eventId);

  const attendanceRate = event.registered_count > 0
    ? Math.round((event.checked_in_count / event.registered_count) * 1000) / 10
    : 0;

  return {
    eventId: event.id,
    title: event.title,
    status: event.status,
    capacity: event.capacity,
    registeredCount: event.registered_count,
    checkedInCount: event.checked_in_count,
    remainingCapacity: event.remaining_capacity,
    attendanceRate,
    recentCheckIns
  };
}

function getAttendanceByUser(userId) {
  return db.prepare(`
    SELECT
      r.id AS registration_id,
      r.status AS registration_status,
      r.registered_at,
      e.id AS event_id,
      e.title AS event_title,
      e.category AS event_category,
      e.venue AS event_venue,
      e.event_date,
      e.start_time,
      e.end_time,
      e.status AS event_status,
      a.id AS attendance_id,
      a.checked_in_at,
      CASE
        WHEN a.id IS NOT NULL THEN 'PRESENT'
        WHEN e.status IN ('COMPLETED', 'ENDED') THEN 'ABSENT'
        ELSE 'PENDING'
      END AS attendance_status
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    JOIN events e ON r.event_id = e.id
    LEFT JOIN attendance a ON r.id = a.registration_id
    WHERE p.user_id = ?
    ORDER BY e.event_date DESC, r.registered_at DESC
  `).all(userId);
}

module.exports = {
  verifyAndCheckIn,
  processSyncBatch,
  manualCheckIn,
  getLiveAttendance,
  getAttendanceByUser
};
