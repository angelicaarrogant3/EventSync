const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/connection');

/**
 * Record an application activity event in activity_logs.
 */
function logActivity({ userId = null, action, description }) {
  try {
    db.prepare(`
      INSERT INTO activity_logs (id, user_id, action, description)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), userId || null, String(action || 'UNKNOWN'), String(description || ''));
  } catch (err) {
    console.warn('[Activity] Failed to write activity log:', err.message);
  }
}

/**
 * Query activity logs with optional filters (action, userId, search)
 */
function listActivityLogs({ action = null, userId = null, search = null, limit = 100, offset = 0 } = {}) {
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
    conditions.push('(al.description LIKE ? OR al.action LIKE ? OR u.username LIKE ? OR u.full_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  return db.prepare(`
    SELECT
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
    ORDER BY al.created_at DESC, al.rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, safeOffset);
}

module.exports = {
  logActivity,
  listActivityLogs
};
