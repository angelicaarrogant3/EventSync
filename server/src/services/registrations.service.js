const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { db } = require('../db/connection');
const { generateQrDataUrl } = require('./qr.service');
const { generateSignedQrToken } = require('../utils/crypto');
const { logActivity } = require('./activity.service');

/**
 * Register a participant for an event inside an ACID SQLite transaction.
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

  const getEventStmt = db.prepare(`SELECT * FROM events WHERE id = ?`);
  const countRegsStmt = db.prepare(`SELECT COUNT(*) AS count FROM registrations WHERE event_id = ? AND status = 'REGISTERED'`);
  const getParticipantStmt = db.prepare(`SELECT * FROM participants WHERE school_id = ?`);

  const insertParticipantStmt = db.prepare(`
    INSERT INTO participants (id, user_id, school_id, full_name, email, contact_number, department_or_course, year_level, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateParticipantStmt = db.prepare(`
    UPDATE participants
    SET full_name = ?, email = ?, contact_number = COALESCE(NULLIF(?, ''), contact_number), department_or_course = ?, year_level = ?, role = ?, user_id = COALESCE(user_id, ?)
    WHERE id = ?
  `);

  const insertRegStmt = db.prepare(`
    INSERT INTO registrations (id, event_id, participant_id, qr_token, token_version, status, registered_by_node, registered_by_user_id)
    VALUES (?, ?, ?, ?, 1, 'REGISTERED', ?, ?)
  `);

  const auditStmt = db.prepare(`
    INSERT INTO audit_log (id, action, entity, entity_id, node_id, details_json)
    VALUES (?, 'REGISTER', 'REGISTRATION', ?, ?, ?)
  `);

  let participantId;
  let finalParticipant;
  let eventRecord;
  let createdAccount = null;

  const executeRegistrationTx = db.transaction(() => {
    eventRecord = getEventStmt.get(eventId);
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

    const activeCount = countRegsStmt.get(eventId).count;
    if (activeCount >= eventRecord.capacity) {
      const err = new Error(`Event is at full capacity (${eventRecord.capacity} slots filled)`);
      err.code = 'EVENT_FULL';
      err.status = 409;
      throw err;
    }

    const cleanSchoolId = String(school_id).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const existingParticipant = getParticipantStmt.get(cleanSchoolId);

    let linkedUserId = existingParticipant ? existingParticipant.user_id : null;

    if (createAccount && !linkedUserId) {
      const baseUsername = cleanEmail.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || `user${Date.now()}`;
      let candidateUsername = baseUsername.slice(0, 24);
      let suffix = 1;
      while (db.prepare(`SELECT id FROM users WHERE lower(username) = ?`).get(candidateUsername)) {
        candidateUsername = `${baseUsername.slice(0, 20)}${suffix++}`;
      }
      const existingEmailUser = db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(cleanEmail);
      if (existingEmailUser) {
        linkedUserId = existingEmailUser.id;
      } else {
        linkedUserId = uuidv4();
        const pwHash = bcrypt.hashSync(String(tempPassword), 10);
        db.prepare(`
          INSERT INTO users (id, full_name, username, email, password_hash, role, account_status, must_change_password)
          VALUES (?, ?, ?, ?, ?, 'participant', 'active', 1)
        `).run(linkedUserId, full_name.trim(), candidateUsername, cleanEmail, pwHash);
        createdAccount = { id: linkedUserId, username: candidateUsername, email: cleanEmail };
      }
    }

    if (existingParticipant) {
      participantId = existingParticipant.id;
      updateParticipantStmt.run(
        full_name.trim(),
        cleanEmail,
        String(contact_number || '').trim(),
        department_or_course.trim(),
        year_level.trim(),
        role,
        linkedUserId,
        participantId
      );
    } else {
      participantId = uuidv4();
      insertParticipantStmt.run(
        participantId,
        linkedUserId,
        cleanSchoolId,
        full_name.trim(),
        cleanEmail,
        String(contact_number || '').trim(),
        department_or_course.trim(),
        year_level.trim(),
        role
      );
    }

    try {
      insertRegStmt.run(registrationId, eventId, participantId, qrToken, nodeId, registeredByUserId || null);
    } catch (dbErr) {
      if (dbErr.message.includes('UNIQUE constraint failed') || dbErr.code === 'SQLITE_CONSTRAINT') {
        const err = new Error(`Participant with School ID '${cleanSchoolId}' is already registered for this event.`);
        err.code = 'ALREADY_REGISTERED';
        err.status = 409;
        throw err;
      }
      throw dbErr;
    }

    auditStmt.run(
      uuidv4(),
      registrationId,
      nodeId,
      JSON.stringify({ eventId, school_id: cleanSchoolId, participantId, registeredByUserId })
    );

    finalParticipant = getParticipantStmt.get(cleanSchoolId);
  });

  executeRegistrationTx();

  const qrDataUrl = await generateQrDataUrl(qrToken);

  const remainingCount = db.prepare(`
    SELECT (e.capacity - COUNT(r.id)) AS remaining
    FROM events e
    LEFT JOIN registrations r ON e.id = r.event_id AND r.status = 'REGISTERED'
    WHERE e.id = ?
    GROUP BY e.id
  `).get(eventId);

  logActivity({
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
      registeredAt: new Date().toISOString(),
      registeredByNode: nodeId,
      registeredByUserId: registeredByUserId || null
    },
    participant: finalParticipant,
    event: eventRecord,
    createdAccount,
    qrDataUrl,
    remainingCapacity: remainingCount ? remainingCount.remaining : 0
  };
}

function getRegistrationsByEvent(eventId) {
  const query = `
    SELECT 
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
    ORDER BY r.registered_at DESC
  `;

  return db.prepare(query).all(eventId);
}

async function getRegistrationsByUser(userId) {
  const rows = db.prepare(`
    SELECT
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
    ORDER BY e.event_date DESC, r.registered_at DESC
  `).all(userId);

  return Promise.all(rows.map(async (row) => ({
    ...row,
    qrDataUrl: row.registration_status === 'REGISTERED' ? await generateQrDataUrl(row.qr_token) : null
  })));
}

async function getRegistrationById(id) {
  const query = `
    SELECT 
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
    WHERE r.id = ?
  `;

  const record = db.prepare(query).get(id);
  if (!record) return null;

  const qrDataUrl = await generateQrDataUrl(record.qr_token);
  return { ...record, qrDataUrl };
}

async function findRegistrationBySchoolId(eventId, schoolId) {
  const query = `
    SELECT 
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
    WHERE r.event_id = ? AND p.school_id = ? AND r.status = 'REGISTERED'
  `;

  const record = db.prepare(query).get(eventId, String(schoolId).trim());
  if (!record) return null;

  const qrDataUrl = await generateQrDataUrl(record.qr_token);
  return { ...record, qrDataUrl };
}

/**
 * Reissue QR code for a registration (increments token_version, invalidating old tokens)
 */
async function reissueQrToken(registrationId, actorUserId = null) {
  const reg = db.prepare(`
    SELECT r.*, p.full_name, p.school_id
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    WHERE r.id = ?
  `).get(registrationId);

  if (!reg) return null;
  if (reg.status !== 'REGISTERED') {
    const err = new Error('Cannot reissue QR for a cancelled registration.');
    err.code = 'REGISTRATION_CANCELLED';
    err.status = 400;
    throw err;
  }

  const nextVersion = (reg.token_version || 1) + 1;
  const newToken = generateSignedQrToken(reg.id, reg.event_id, nextVersion);

  db.prepare(`
    UPDATE registrations SET qr_token = ?, token_version = ? WHERE id = ?
  `).run(newToken, nextVersion, reg.id);

  logActivity({
    userId: actorUserId,
    action: 'QR_REISSUED',
    description: `Reissued QR pass (v${nextVersion}) for ${reg.full_name} (${reg.school_id}).`
  });

  return getRegistrationById(reg.id);
}

function cancelRegistration(id, nodeId = 'node-4', actorUserId = null) {
  const existing = db.prepare(`
    SELECT r.*, p.full_name, p.school_id
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    WHERE r.id = ?
  `).get(id);

  if (!existing) return null;

  const stmt = db.prepare(`UPDATE registrations SET status = 'CANCELLED' WHERE id = ?`);
  const auditStmt = db.prepare(`
    INSERT INTO audit_log (id, action, entity, entity_id, node_id, details_json)
    VALUES (?, 'CANCEL', 'REGISTRATION', ?, ?, '{}')
  `);

  const tx = db.transaction(() => {
    stmt.run(id);
    auditStmt.run(uuidv4(), id, nodeId);
  });

  tx();

  logActivity({
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
