const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { logActivity } = require('./activity.service');

const VALID_STATUSES = ['DRAFT', 'OPEN', 'ONGOING', 'COMPLETED', 'CANCELLED', 'CLOSED', 'ENDED'];

function domainError(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function isValidDateString(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTimeString(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) {
    return false;
  }
  const [h, m] = timeStr.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function normalizeStatus(status) {
  if (status === undefined || status === null) return undefined;
  return String(status).trim().toUpperCase();
}

function isValidDeadline(deadline) {
  if (deadline === undefined || deadline === null || String(deadline).trim() === '') return true;
  const parsed = Date.parse(String(deadline).trim());
  return !Number.isNaN(parsed);
}

function normalizeEventRow(row) {
  if (!row) return null;
  return {
    ...row,
    capacity: Number(row.capacity),
    archived: Number(row.archived || 0),
    registered_count: Number(row.registered_count || 0),
    checked_in_count: Number(row.checked_in_count || 0),
    remaining_capacity: Number(row.remaining_capacity ?? row.capacity ?? 0)
  };
}

function validateEventInput(data, existing = null) {
  const isTerminal = existing && (existing.status === 'ENDED' || existing.status === 'COMPLETED');
  if (isTerminal) {
    const incomingStatus = normalizeStatus(data.status);
    const immutableFields = [
      ['title', data.title !== undefined && String(data.title).trim() !== existing.title],
      ['venue', data.venue !== undefined && String(data.venue).trim() !== existing.venue],
      ['event_date', data.event_date !== undefined && data.event_date !== existing.event_date],
      ['start_time', data.start_time !== undefined && data.start_time !== existing.start_time],
      ['end_time', data.end_time !== undefined && data.end_time !== existing.end_time],
      ['capacity', data.capacity !== undefined && parseInt(data.capacity, 10) !== existing.capacity],
      ['status', incomingStatus !== undefined && incomingStatus !== existing.status]
    ];

    const modified = immutableFields.filter(([, changed]) => changed).map(([name]) => name);
    if (modified.length > 0) {
      throw domainError(
        'EVENT_ENDED',
        `Cannot edit ${modified.join(', ')} on a ${existing.status} event. Only notes/description may be updated.`,
        400
      );
    }
    return;
  }

  const title = data.title !== undefined ? String(data.title).trim() : (existing ? existing.title : '');
  const venue = data.venue !== undefined ? String(data.venue).trim() : (existing ? existing.venue : '');
  const event_date = data.event_date !== undefined ? data.event_date : (existing ? existing.event_date : '');
  const start_time = data.start_time !== undefined ? data.start_time : (existing ? existing.start_time : '');
  const end_time = data.end_time !== undefined ? data.end_time : (existing ? existing.end_time : '');
  const registration_deadline = data.registration_deadline !== undefined ? data.registration_deadline : (existing ? existing.registration_deadline : null);
  const rawCapacity = data.capacity !== undefined ? data.capacity : (existing ? existing.capacity : undefined);
  const status = data.status !== undefined ? normalizeStatus(data.status) : (existing ? existing.status : 'DRAFT');

  if (!title) {
    throw domainError('INVALID_INPUT', 'Event title is required.', 400);
  }
  if (!venue) {
    throw domainError('INVALID_INPUT', 'Event venue is required.', 400);
  }
  if (!isValidDateString(event_date)) {
    throw domainError('INVALID_INPUT', 'Valid event_date (YYYY-MM-DD) is required.', 400);
  }
  if (!isValidTimeString(start_time) || !isValidTimeString(end_time)) {
    throw domainError('INVALID_INPUT', 'Valid start_time and end_time (HH:MM) are required.', 400);
  }
  if (end_time <= start_time) {
    throw domainError('INVALID_INPUT', 'End time must be after start time.', 400);
  }
  if (!isValidDeadline(registration_deadline)) {
    throw domainError('INVALID_INPUT', 'Invalid registration_deadline date/time.', 400);
  }

  const parsedCapacity = Number(rawCapacity);
  if (!Number.isInteger(parsedCapacity) || parsedCapacity < 1) {
    throw domainError('INVALID_INPUT', 'Capacity must be a positive integer.', 400);
  }

  if (!VALID_STATUSES.includes(status)) {
    throw domainError('INVALID_STATUS', 'Status must be one of: ' + VALID_STATUSES.join(', '), 400);
  }

  if (existing && parsedCapacity < existing.registered_count) {
    throw domainError(
      'CAPACITY_TOO_LOW',
      `Cannot set capacity (${parsedCapacity}) lower than currently registered participants (${existing.registered_count}).`,
      400
    );
  }
}

/**
 * List events with optional filters: status, includeArchived, category, search, eventDate
 */
async function listEvents(statusFilter = null, includeArchived = false, filters = {}) {
  let sql = `
    SELECT
      e.*,
      COALESCE(r.reg_count, 0) AS registered_count,
      COALESCE(a.att_count, 0) AS checked_in_count,
      (e.capacity - COALESCE(r.reg_count, 0)) AS remaining_capacity
    FROM events e
    LEFT JOIN (
      SELECT event_id, COUNT(*) AS reg_count
      FROM registrations
      WHERE status = 'REGISTERED'
      GROUP BY event_id
    ) r ON e.id = r.event_id
    LEFT JOIN (
      SELECT event_id, COUNT(*) AS att_count
      FROM attendance
      GROUP BY event_id
    ) a ON e.id = a.event_id
  `;

  const conditions = [];
  const params = [];

  if (!includeArchived) {
    conditions.push(`e.archived = 0`);
  }

  if (statusFilter) {
    conditions.push(`e.status = ?`);
    params.push(normalizeStatus(statusFilter));
  }

  if (filters.category) {
    conditions.push(`lower(e.category) = lower(?)`);
    params.push(String(filters.category).trim());
  }

  if (filters.eventDate) {
    conditions.push(`e.event_date = ?`);
    params.push(String(filters.eventDate).trim());
  }

  if (filters.search) {
    conditions.push(`(LOWER(e.title) LIKE LOWER(?) OR LOWER(COALESCE(e.description, '')) LIKE LOWER(?) OR LOWER(e.venue) LIKE LOWER(?) OR LOWER(e.category) LIKE LOWER(?))`);
    const like = `%${String(filters.search).trim()}%`;
    params.push(like, like, like, like);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }

  sql += ` ORDER BY e.archived ASC, e.event_date DESC, e.start_time DESC`;

  const rows = await query.all(sql, params);
  return rows.map(normalizeEventRow);
}

async function getEventById(id) {
  const row = await query.get(
    `SELECT
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
    WHERE e.id = ?`,
    [id, id, id]
  );

  return normalizeEventRow(row);
}

async function createEvent(data, nodeId = 'node-4', actorUserId = null) {
  validateEventInput(data, null);

  const {
    title,
    description,
    category = 'General',
    venue,
    event_date,
    start_time,
    end_time,
    registration_deadline = null,
    capacity,
    status = 'DRAFT'
  } = data;
  const finalStatus = normalizeStatus(status) || 'DRAFT';
  const cleanDeadline = registration_deadline && String(registration_deadline).trim() ? String(registration_deadline).trim() : null;
  const cleanCategory = category && String(category).trim() ? String(category).trim() : 'General';
  const id = uuidv4();
  const nowIso = new Date().toISOString();

  await query.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO events (id, title, description, category, venue, event_date, start_time, end_time, registration_deadline, capacity, status, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        title.trim(),
        description ? String(description).trim() : null,
        cleanCategory,
        venue.trim(),
        event_date,
        start_time,
        end_time,
        cleanDeadline,
        parseInt(capacity, 10),
        finalStatus,
        nowIso
      ]
    );
    await tx.run(
      `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
       VALUES (?, 'CREATE', 'EVENT', ?, ?, ?, ?)`,
      [uuidv4(), id, nodeId, nowIso, JSON.stringify({ title: title.trim(), venue: venue.trim(), capacity: parseInt(capacity, 10), status: finalStatus })]
    );
  });

  await logActivity({
    userId: actorUserId,
    action: 'EVENT_CREATED',
    description: `Created event "${title.trim()}" (${finalStatus}).`
  });
  return getEventById(id);
}

async function updateEvent(id, data, nodeId = 'node-4', actorUserId = null) {
  const existing = await getEventById(id);
  if (!existing) {
    return null;
  }

  validateEventInput(data, existing);

  const title = data.title !== undefined ? String(data.title).trim() : existing.title;
  const description = data.description !== undefined ? (data.description !== null ? String(data.description).trim() : null) : existing.description;
  const category = data.category !== undefined ? (String(data.category).trim() || 'General') : (existing.category || 'General');
  const venue = data.venue !== undefined ? String(data.venue).trim() : existing.venue;
  const event_date = data.event_date !== undefined ? data.event_date : existing.event_date;
  const start_time = data.start_time !== undefined ? data.start_time : existing.start_time;
  const end_time = data.end_time !== undefined ? data.end_time : existing.end_time;
  const registration_deadline = data.registration_deadline !== undefined
    ? (data.registration_deadline && String(data.registration_deadline).trim() ? String(data.registration_deadline).trim() : null)
    : existing.registration_deadline;
  const capacity = data.capacity !== undefined ? parseInt(data.capacity, 10) : existing.capacity;
  const status = data.status !== undefined ? normalizeStatus(data.status) : existing.status;

  await query.transaction(async (tx) => {
    await tx.run(
      `UPDATE events
       SET title = ?, description = ?, category = ?, venue = ?, event_date = ?, start_time = ?, end_time = ?, registration_deadline = ?, capacity = ?, status = ?
       WHERE id = ?`,
      [title, description, category, venue, event_date, start_time, end_time, registration_deadline, capacity, status, id]
    );
    await tx.run(
      `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
       VALUES (?, 'UPDATE', 'EVENT', ?, ?, ?, ?)`,
      [uuidv4(), id, nodeId, new Date().toISOString(), JSON.stringify(data)]
    );
  });

  await logActivity({
    userId: actorUserId,
    action: 'EVENT_UPDATED',
    description: `Updated event "${title}".`
  });
  return getEventById(id);
}

async function updateEventStatus(id, newStatus, nodeId = 'node-4', actorUserId = null) {
  const normalized = normalizeStatus(newStatus);
  if (!VALID_STATUSES.includes(normalized)) {
    throw domainError('INVALID_STATUS', 'INVALID_STATUS: Must be one of ' + VALID_STATUSES.join(', '), 400);
  }

  const existing = await getEventById(id);
  if (!existing) return null;

  await query.transaction(async (tx) => {
    await tx.run(`UPDATE events SET status = ? WHERE id = ?`, [normalized, id]);
    await tx.run(
      `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
       VALUES (?, 'STATUS_CHANGE', 'EVENT', ?, ?, ?, ?)`,
      [uuidv4(), id, nodeId, new Date().toISOString(), JSON.stringify({ oldStatus: existing.status, newStatus: normalized })]
    );
  });

  await logActivity({
    userId: actorUserId,
    action: 'EVENT_STATUS_CHANGED',
    description: `Changed event "${existing.title}" status from ${existing.status} to ${normalized}.`
  });
  return getEventById(id);
}

async function deleteEvent(id, options = {}, nodeId = 'node-4', actorUserId = null) {
  const { force = false, archive = false } = options;
  let outcome = null;

  await query.transaction(async (tx) => {
    const existing = await tx.get(`SELECT * FROM events WHERE id = ?`, [id]);
    if (!existing) {
      outcome = null;
      return;
    }

    const regRow = await tx.get(`SELECT COUNT(*) AS cnt FROM registrations WHERE event_id = ?`, [id]);
    const attRow = await tx.get(`SELECT COUNT(*) AS cnt FROM attendance WHERE event_id = ?`, [id]);
    const registrationsCount = regRow ? Number(regRow.cnt) : 0;
    const attendanceCount = attRow ? Number(attRow.cnt) : 0;
    const nowIso = new Date().toISOString();

    if (archive) {
      await tx.run(`UPDATE events SET archived = 1 WHERE id = ?`, [id]);
      await tx.run(
        `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
         VALUES (?, 'ARCHIVE', 'EVENT', ?, ?, ?, ?)`,
        [uuidv4(), id, nodeId, nowIso, JSON.stringify({ title: existing.title, registrationsCount, attendanceCount })]
      );
      outcome = {
        action: 'ARCHIVED',
        eventId: id,
        title: existing.title,
        counts: { registrations: registrationsCount, attendance: attendanceCount }
      };
      return;
    }

    if (registrationsCount === 0 && attendanceCount === 0) {
      await tx.run(`DELETE FROM events WHERE id = ?`, [id]);
      await tx.run(
        `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
         VALUES (?, 'DELETE', 'EVENT', ?, ?, ?, ?)`,
        [uuidv4(), id, nodeId, nowIso, JSON.stringify({ title: existing.title, force: false })]
      );
      outcome = {
        action: 'DELETED',
        eventId: id,
        title: existing.title,
        counts: { registrations: 0, attendance: 0 }
      };
      return;
    }

    if (!force) {
      throw domainError(
        'EVENT_HAS_DATA',
        `Cannot delete event "${existing.title}" because it has ${registrationsCount} registration(s) and ${attendanceCount} check-in(s). Archive it or use force=true.`,
        409,
        { counts: { registrations: registrationsCount, attendance: attendanceCount } }
      );
    }

    await tx.run(`DELETE FROM attendance WHERE event_id = ?`, [id]);
    await tx.run(`DELETE FROM registrations WHERE event_id = ?`, [id]);
    await tx.run(`DELETE FROM events WHERE id = ?`, [id]);

    await tx.run(
      `INSERT INTO audit_log (id, action, entity, entity_id, node_id, timestamp, details_json)
       VALUES (?, 'DELETE', 'EVENT', ?, ?, ?, ?)`,
      [uuidv4(), id, nodeId, nowIso, JSON.stringify({ title: existing.title, force: true, deletedRegistrations: registrationsCount, deletedAttendance: attendanceCount })]
    );

    outcome = {
      action: 'FORCE_DELETED',
      eventId: id,
      title: existing.title,
      counts: { registrations: registrationsCount, attendance: attendanceCount }
    };
  });

  if (outcome && outcome.action === 'ARCHIVED') {
    outcome.event = await getEventById(id);
  }
  if (outcome) {
    await logActivity({
      userId: actorUserId,
      action: `EVENT_${outcome.action}`,
      description: `${outcome.action} event "${outcome.title}".`
    });
  }

  return outcome;
}

async function getEventStats(id) {
  const event = await getEventById(id);
  if (!event) return null;

  const attTimestamps = await query.all(
    `SELECT checked_in_at FROM attendance WHERE event_id = ? ORDER BY checked_in_at ASC`,
    [id]
  );

  const hourBuckets = new Map();
  for (const row of attTimestamps) {
    const raw = String(row.checked_in_at || '');
    const m = raw.match(/(?:T|\s)(\d{2}):/);
    const hour = m ? `${m[1]}:00` : '00:00';
    hourBuckets.set(hour, (hourBuckets.get(hour) || 0) + 1);
  }
  const checkInsByHour = Array.from(hourBuckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour_slot, check_in_count]) => ({ hour_slot, check_in_count }));

  const byDepartmentRows = await query.all(
    `SELECT
      p.department_or_course AS department,
      COUNT(DISTINCT r.id) AS registered_count,
      COUNT(DISTINCT a.id) AS checked_in_count
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    LEFT JOIN attendance a ON r.id = a.registration_id
    WHERE r.event_id = ? AND r.status = 'REGISTERED'
    GROUP BY p.department_or_course
    ORDER BY registered_count DESC`,
    [id]
  );

  const byRoleRows = await query.all(
    `SELECT
      p.role,
      COUNT(DISTINCT r.id) AS registered_count,
      COUNT(DISTINCT a.id) AS checked_in_count
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    LEFT JOIN attendance a ON r.id = a.registration_id
    WHERE r.event_id = ? AND r.status = 'REGISTERED'
    GROUP BY p.role`,
    [id]
  );

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
    checkInsByHour,
    byDepartment: byDepartmentRows.map((r) => ({
      ...r,
      registered_count: Number(r.registered_count || 0),
      checked_in_count: Number(r.checked_in_count || 0)
    })),
    byRole: byRoleRows.map((r) => ({
      ...r,
      registered_count: Number(r.registered_count || 0),
      checked_in_count: Number(r.checked_in_count || 0)
    }))
  };
}

module.exports = {
  VALID_STATUSES,
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  updateEventStatus,
  deleteEvent,
  getEventStats
};
