const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { query } = require('../db/connection');
const { generateQrDataUrl } = require('./qr.service');
const { generateSignedQrToken } = require('../utils/crypto');
const { logActivity } = require('./activity.service');

/**
 * Register a participant for an event inside an ACID transaction.
 */
async function registerParticipant({
  eventId,
  participant,
  nodeId = 'node-2',
  registeredByUserId = null,
  createAccount = false,
  tempPassword = null
}) {
  const {
    school_id,
    full_name,
    email,
    contact_number = '',
    department_or_course,
    year_level,
    role = 'STUDENT'
  } = participant || {};

  if (!school_id || !full_name || !email || !department_or_course || !year_level) {
    const err = new Error('All participant fields are required');
    err.code = 'INVALID_INPUT';
    err.status = 400;
    throw err;
  }

  if (createAccount && (!tempPassword || String(tempPassword).length < 8)) {
    const err = new Error('Temporary password must be at least 8 characters when creating an account.');
    err.code = 'WEAK_PASSWORD';
    err.status = 400;
    throw err;
  }

  const registrationId = uuidv4();
  const qrToken = generateSignedQrToken(registrationId, eventId, 1);
  const nowIso = new Date().toISOString();

  let participantId;
  let finalParticipant;
  let eventRecord;
  let createdAccount = null;

  await query.transaction(async (tx) => {
    const eventSql = tx.isPostgres
      ? `SELECT * FROM events WHERE id = ? FOR UPDATE`
      : `SELECT * FROM events WHERE id = ?`;
    eventRecord = await tx.get(eventSql, [eventId]);

    if (!eventRecord) {
      const err = new Error('Event not found');
      err.code = 'EVENT_NOT_FOUND';
      err.status = 404;
      throw err;
    }

    if (eventRecord.status !== 'OPEN') {
      const err = new Error(`Registration is closed. Current event status: ${eventRecord.status}`);
      err.code = 'EVENT_NOT_OPEN';
      err.status = 400;
      throw err;
    }

    if (eventRecord.registration_deadline) {
      const deadlineMs = Date.parse(eventRecord.registration_deadline);
      if (!Number.isNaN(deadlineMs) && Date.now() > deadlineMs) {
        const err = new Error('Registration deadline has passed for this event.');
        err.code = 'DEADLINE_PASSED';
        err.status = 400;
        throw err;
      }
    }

    const regCountRow = await tx.get(
      `SELECT COUNT(*) AS count FROM registrations WHERE event_id = ? AND status = 'REGISTERED'`,
      [eventId]
    );
    const activeCount = Number(regCountRow?.count || 0);
    if (activeCount >= Number(eventRecord.capacity)) {
      const err = new Error(`Event is at full capacity (${eventRecord.capacity} slots filled)`);
      err.code = 'EVENT_FULL';
      err.status = 409;
      throw err;
    }

    const cleanSchoolId = String(school_id).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const existingParticipant = await tx.get(`SELECT * FROM participants WHERE school_id = ?`, [cleanSchoolId]);

    let linkedUserId = existingParticipant ? existingParticipant.user_id : null;

    if (createAccount && !linkedUserId) {
      const baseUsername = cleanEmail.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || `user${Date.now()}`;
      let candidateUsername = baseUsername.slice(0, 24);
      let suffix = 1;
      while (await tx.get(`SELECT id FROM users WHERE lower(username) = ?`, [candidateUsername])) {
        candidateUsername = `${baseUsername.slice(0, 20)}${suffix++}`;
      }
      const existingEmailUser = await tx.get(`SELECT id FROM users WHERE lower(email) = ?`, [cleanEmail]);
      if (existingEmailUser) {
        linkedUserId = existingEmailUser.id;
      } else {
        linkedUserId = uuidv4();
        const pwHash = bcrypt.hashSync(String(tempPassword), 10);
        await tx.run(
          `INSERT INTO users (id, full_name, username, email, password_hash, role, account_status, must_change_password, created_at)
           VALUES (?, ?, ?, ?, ?, 'participant', 'active', 1, ?)`,
          [linkedUserId, full_name.trim(), candidateUsername, cleanEmail, pwHash, nowIso]
        );
        createdAccount = { id: linkedUserId, username: candidateUsername, email: cleanEmail };
      }
    }

    if (existingParticipant) {
      participantId = existingParticipant.id;
      await tx.run(
        `UPDATE participants
         SET full_name = ?, email = ?, contact_number = COALESCE(NULLIF(?, ''), contact_number), department_or_course = ?, year_level = ?, role = ?, user_id = COALESCE(user_id, ?)
         WHERE id = ?`,
        [
          full_name.trim(),
          cleanEmail,
          String(contact_number || '').trim(),
          department_or_course.trim(),
          year_level.trim(),
          role,
          linkedUserId,
          participantId
        ]
      );
    } else {
      participantId = uuidv4();
      await tx.run(
        `INSERT INTO participants (id, user_id, school_id, full_name, email, contact_number, department_or_course, year_level, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          participantId,
          linkedUserId,
          cleanSchoolId,
          full_name.trim(),
          cleanEmail,
          String(contact_number || '').trim(),
          department_or_course.trim(),
          year_level.trim(),
          role,
          nowIso
        ]
      );
    }

    try {
      await tx.run(
        `INSERT INTO registrations (id, event_id, participant_id, qr_token, token_version, status, registered_at, registered_by_node, registered_by_user_id)
         VALUES (?, ?, ?, ?, 1, 'REGISTERED', ?, ?, ?)`,
        [registrationId, eventId, participantId, qrToken, nowIso, nodeId, registeredByUserId || null]
      );
    } catch (dbErr) {
      if (
        dbErr.code === '23505' ||
        dbErr.code === 'SQLITE_CONSTRAINT' ||
        (dbErr.message && dbErr.message.includes('UNIQUE constraint failed'))
      ) {
        const err = new Error(`Participant with School ID '${cleanSchoolId}' is already registered for this event.`);
        err.code = 'ALREADY_REGISTERED';
        err.status = 409;
        throw err;
      }
      throw dbErr;
    }

    await tx.run(
      `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
       VALUES (?, 'REGISTER', 'REGISTRATION', ?, ?, ?, ?)`,
      [uuidv4(), registrationId, nodeId, nowIso, JSON.stringify({ eventId, school_id: cleanSchoolId, participantId, registeredByUserId })]
    );

    finalParticipant = await tx.get(`SELECT * FROM participants WHERE school_id = ?`, [cleanSchoolId]);
  });

  const qrDataUrl = await generateQrDataUrl(qrToken);

  const remainingCount = await query.get(
    `SELECT (e.capacity - COUNT(r.id)) AS remaining
     FROM events e
     LEFT JOIN registrations r ON e.id = r.event_id AND r.status = 'REGISTERED'
     WHERE e.id = ?
     GROUP BY e.id`,
    [eventId]
  );

  await logActivity({
    userId: registeredByUserId || finalParticipant.user_id || null,
    action: 'REGISTRATION_CREATED',
    description: `Registered "${finalParticipant.full_name}" (${finalParticipant.school_id}) for "${eventRecord.title}".`
  });

  return {
    registration: {
      id: registrationId,
      eventId,
      participantId,
      qrToken,
      tokenVersion: 1,
      status: 'REGISTERED',
      registeredAt: nowIso,
      registeredByNode: nodeId,
      registeredByUserId: registeredByUserId || null
    },
    participant: finalParticipant,
    event: eventRecord,
    createdAccount,
    qrDataUrl,
    remainingCapacity: remainingCount ? Number(remainingCount.remaining) : 0
  };
}

async function getRegistrationsByEvent(eventId) {
  return query.all(
    `SELECT
      r.id AS registration_id,
      r.event_id,
      r.status AS registration_status,
      r.registered_at,
      r.registered_by_node,
      r.registered_by_user_id,
      r.qr_token,
      r.token_version,
      p.id AS participant_id,
      p.user_id AS participant_user_id,
      p.school_id,
      p.full_name,
      p.email,
      p.contact_number,
      p.department_or_course,
      p.year_level,
      p.role,
      e.status AS event_status,
      a.id AS attendance_id,
      a.checked_in_at,
      a.scanned_by_node,
      a.verified_by_user_id,
      a.was_offline_sync,
      CASE
        WHEN a.id IS NOT NULL THEN 'PRESENT'
        WHEN e.status IN ('COMPLETED', 'ENDED') THEN 'ABSENT'
        ELSE 'PENDING'
      END AS attendance_status
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    JOIN events e ON r.event_id = e.id
    LEFT JOIN attendance a ON r.id = a.registration_id
    WHERE r.event_id = ?
    ORDER BY r.registered_at DESC`,
    [eventId]
  );
}

async function getRegistrationsByUser(userId) {
  const rows = await query.all(
    `SELECT
      r.id,
      r.event_id,
      r.participant_id,
      r.qr_token,
      r.token_version,
      r.status AS registration_status,
      r.registered_at,
      e.title AS event_title,
      e.description AS event_description,
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
    ORDER BY e.event_date DESC, r.registered_at DESC`,
    [userId]
  );

  return Promise.all(rows.map(async (row) => ({
    ...row,
    qrDataUrl: row.registration_status === 'REGISTERED' ? await generateQrDataUrl(row.qr_token) : null
  })));
}

async function getRegistrationById(id) {
  const record = await query.get(
    `SELECT
      r.*,
      p.user_id AS participant_user_id,
      p.school_id,
      p.full_name,
      p.email,
      p.contact_number,
      p.department_or_course,
      p.year_level,
      p.role,
      e.title AS event_title,
      e.venue AS event_venue,
      e.event_date,
      e.start_time,
      e.end_time,
      e.status AS event_status
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    JOIN events e ON r.event_id = e.id
    WHERE r.id = ?`,
    [id]
  );

  if (!record) return null;
  const qrDataUrl = await generateQrDataUrl(record.qr_token);
  return { ...record, qrDataUrl };
}

async function findRegistrationBySchoolId(eventId, schoolId) {
  const record = await query.get(
    `SELECT
      r.*,
      p.user_id AS participant_user_id,
      p.school_id,
      p.full_name,
      p.email,
      p.contact_number,
      p.department_or_course,
      p.year_level,
      p.role,
      e.title AS event_title,
      e.venue AS event_venue,
      e.event_date,
      e.start_time,
      e.end_time,
      e.status AS event_status
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    JOIN events e ON r.event_id = e.id
    WHERE r.event_id = ? AND p.school_id = ? AND r.status = 'REGISTERED'`,
    [eventId, String(schoolId).trim()]
  );

  if (!record) return null;
  const qrDataUrl = await generateQrDataUrl(record.qr_token);
  return { ...record, qrDataUrl };
}

/**
 * Reissue QR code for a registration (increments token_version, invalidating old tokens)
 */
async function reissueQrToken(registrationId, actorUserId = null) {
  const reg = await query.get(
    `SELECT r.*, p.full_name, p.school_id
     FROM registrations r
     JOIN participants p ON r.participant_id = p.id
     WHERE r.id = ?`,
    [registrationId]
  );

  if (!reg) return null;
  if (reg.status !== 'REGISTERED') {
    const err = new Error('Cannot reissue QR for a cancelled registration.');
    err.code = 'REGISTRATION_CANCELLED';
    err.status = 400;
    throw err;
  }

  const nextVersion = Number(reg.token_version || 1) + 1;
  const newToken = generateSignedQrToken(reg.id, reg.event_id, nextVersion);

  await query.run(
    `UPDATE registrations SET qr_token = ?, token_version = ? WHERE id = ?`,
    [newToken, nextVersion, reg.id]
  );

  await logActivity({
    userId: actorUserId,
    action: 'QR_REISSUED',
    description: `Reissued QR pass (v${nextVersion}) for ${reg.full_name} (${reg.school_id}).`
  });

  return getRegistrationById(reg.id);
}

async function cancelRegistration(id, nodeId = 'node-4', actorUserId = null) {
  const existing = await query.get(
    `SELECT r.*, p.full_name, p.school_id
     FROM registrations r
     JOIN participants p ON r.participant_id = p.id
     WHERE r.id = ?`,
    [id]
  );

  if (!existing) return null;

  await query.transaction(async (tx) => {
    await tx.run(`UPDATE registrations SET status = 'CANCELLED' WHERE id = ?`, [id]);
    await tx.run(
      `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
       VALUES (?, 'CANCEL', 'REGISTRATION', ?, ?, ?, '{}')`,
      [uuidv4(), id, nodeId, new Date().toISOString()]
    );
  });

  await logActivity({
    userId: actorUserId,
    action: 'REGISTRATION_CANCELLED',
    description: `Cancelled registration for ${existing.full_name} (${existing.school_id}).`
  });

  return { id, status: 'CANCELLED' };
}

module.exports = {
  registerParticipant,
  getRegistrationsByEvent,
  getRegistrationsByUser,
  getRegistrationById,
  findRegistrationBySchoolId,
  reissueQrToken,
  cancelRegistration
};
