const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');

/**
 * Record an application activity event in activity_logs.
 */
async function logActivity({ userId = null, action, description }) {
  try {
    await query.run(
      `INSERT INTO activity_logs (id, user_id, action, description, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), userId || null, String(action || 'UNKNOWN'), String(description || ''), new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[Activity] Failed to write activity log:', err.message);
  }
}

/**
 * Query activity logs with optional filters (action, userId, search)
 */
async function listActivityLogs({ action = null, userId = null, search = null, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (action) {
    conditions.push('al.action = ?');
    params.push(action);
  }
  if (userId) {
    conditions.push('al.user_id = ?');
    params.push(userId);
  }
  if (search) {
    conditions.push('(LOWER(al.description) LIKE LOWER(?) OR LOWER(al.action) LIKE LOWER(?) OR LOWER(u.username) LIKE LOWER(?) OR LOWER(u.full_name) LIKE LOWER(?))');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  return query.all(
    `SELECT
      al.id,
      al.user_id,
      al.action,
      al.description,
      al.created_at,
      u.username,
      u.full_name,
      u.role
    FROM activity_logs al
    LEFT JOIN users u ON al.user_id = u.id
    ${where}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );
}

module.exports = {
  logActivity,
  listActivityLogs
};
