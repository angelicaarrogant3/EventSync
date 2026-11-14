const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db/connection');
const config = require('../config');
const { logActivity } = require('./activity.service');

const BCRYPT_ROUNDS = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 10;

// In-memory rate-limit buckets: key -> array of failure timestamps
const failedLoginBuckets = new Map();

function domainError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function validatePasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw domainError('WEAK_PASSWORD', 'Password must be at least 8 characters long.', 400);
  }
}

function pruneBucket(key, now) {
  const list = failedLoginBuckets.get(key) || [];
  const fresh = list.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (fresh.length === 0) {
    failedLoginBuckets.delete(key);
  } else {
    failedLoginBuckets.set(key, fresh);
  }
  return fresh;
}

function checkLoginRateLimit(ip, identifier) {
  const now = Date.now();
  const keys = [`ip:${ip || 'unknown'}`, `user:${String(identifier || '').toLowerCase()}`];
  for (const key of keys) {
    const fresh = pruneBucket(key, now);
    if (fresh.length >= RATE_LIMIT_MAX_ATTEMPTS) {
      throw domainError(
        'RATE_LIMITED',
        'Too many failed login attempts. Please wait 10 minutes before trying again.',
        429
      );
    }
  }
}

function recordFailedLoginAttempt(ip, identifier) {
  const now = Date.now();
  const keys = [`ip:${ip || 'unknown'}`, `user:${String(identifier || '').toLowerCase()}`];
  for (const key of keys) {
    const fresh = pruneBucket(key, now);
    fresh.push(now);
    failedLoginBuckets.set(key, fresh);
  }
}

function clearLoginRateLimit(ip, identifier) {
  failedLoginBuckets.delete(`ip:${ip || 'unknown'}`);
  failedLoginBuckets.delete(`user:${String(identifier || '').toLowerCase()}`);
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    full_name: row.full_name,
    username: row.username,
    email: row.email,
    role: row.role,
    account_status: row.account_status,
    must_change_password: Boolean(row.must_change_password),
    created_at: row.created_at
  };
}

/**
 * Create a new database-backed session for a user
 */
async function createSession(userId, { ip = null, userAgent = null } = {}) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const timeoutMs = (config.sessionTimeoutMinutes || 120) * 60 * 1000;
  const expiresAt = now + timeoutMs;

  await query.run(
    `INSERT INTO sessions (id, user_id, expires_at, last_activity_at, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, expiresAt, now, ip, userAgent, new Date().toISOString()]
  );

  return { sessionId, expiresAt };
}

/**
 * Validate a session ID, enforce inactivity timeout, and slide expiration
 */
async function getSession(sessionId, { touch = true } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;

  const row = await query.get(
    `SELECT
      s.id AS session_id,
      s.user_id,
      s.expires_at,
      s.last_activity_at,
      u.id,
      u.full_name,
      u.username,
      u.email,
      u.role,
      u.account_status,
      u.must_change_password,
      u.created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?`,
    [sessionId]
  );

  if (!row) return null;

  const now = Date.now();
  const expiresAtNum = Number(row.expires_at);
  if (expiresAtNum <= now) {
    await query.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
    return null;
  }

  if (row.account_status !== 'active') {
    await query.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
    return null;
  }

  let finalExpiresAt = expiresAtNum;
  if (touch) {
    const timeoutMs = (config.sessionTimeoutMinutes || 120) * 60 * 1000;
    const nextExpires = now + timeoutMs;
    await query.run(
      `UPDATE sessions SET last_activity_at = ?, expires_at = ? WHERE id = ?`,
      [now, nextExpires, sessionId]
    );
    finalExpiresAt = nextExpires;
  }

  const participant = (await query.get(`SELECT * FROM participants WHERE user_id = ?`, [row.user_id])) || null;

  return {
    sessionId: row.session_id,
    expiresAt: finalExpiresAt,
    user: sanitizeUser(row),
    participant
  };
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  await query.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

async function deleteUserSessions(userId) {
  await query.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

async function purgeExpiredSessions() {
  await query.run(`DELETE FROM sessions WHERE expires_at <= ?`, [Date.now()]);
}

/**
 * Public Participant Sign-Up (always creates role = 'participant')
 */
async function signupParticipant(payload) {
  const full_name = String(payload.full_name || '').trim();
  const username = String(payload.username || '').trim().toLowerCase();
  const email = String(payload.email || '').trim().toLowerCase();
  const password = payload.password || '';
  const confirmPassword = payload.confirm_password !== undefined ? payload.confirm_password : payload.confirmPassword;
  const contact_number = String(payload.contact_number || '').trim();
  const school_id = String(payload.school_id || '').trim();
  const department_or_course = String(payload.department_or_course || '').trim();
  const year_level = String(payload.year_level || '').trim();
  const participant_type = ['STUDENT', 'FACULTY', 'STAFF'].includes(String(payload.participant_type || 'STUDENT').toUpperCase())
    ? String(payload.participant_type || 'STUDENT').toUpperCase()
    : 'STUDENT';

  if (!full_name || !username || !email || !school_id || !department_or_course || !year_level) {
    throw domainError('INVALID_INPUT', 'All required fields (full name, username, email, school/employee ID, department/course, year level) must be filled.', 400);
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw domainError('INVALID_USERNAME', 'Username must be 3-32 characters using letters, numbers, dots, underscores, or hyphens.', 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw domainError('INVALID_EMAIL', 'Please enter a valid email address.', 400);
  }
  validatePasswordPolicy(password);
  if (confirmPassword !== undefined && password !== confirmPassword) {
    throw domainError('PASSWORD_MISMATCH', 'Passwords do not match.', 400);
  }

  const existingUser = await query.get(`SELECT id FROM users WHERE lower(username) = ? OR lower(email) = ?`, [username, email]);
  if (existingUser) {
    throw domainError('DUPLICATE_ACCOUNT', 'An account with that username or email already exists.', 409);
  }

  const existingParticipant = await query.get(`SELECT id, user_id FROM participants WHERE school_id = ?`, [school_id]);
  if (existingParticipant && existingParticipant.user_id) {
    throw domainError('DUPLICATE_SCHOOL_ID', 'This school/employee ID is already linked to an account.', 409);
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const userId = uuidv4();
  const nowIso = new Date().toISOString();

  await query.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO users (id, full_name, username, email, password_hash, role, account_status, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 'participant', 'active', 0, ?)`,
      [userId, full_name, username, email, passwordHash, nowIso]
    );

    if (existingParticipant) {
      await tx.run(
        `UPDATE participants
         SET user_id = ?, full_name = ?, email = ?, contact_number = ?, department_or_course = ?, year_level = ?, role = ?
         WHERE id = ?`,
        [userId, full_name, email, contact_number, department_or_course, year_level, participant_type, existingParticipant.id]
      );
    } else {
      await tx.run(
        `INSERT INTO participants (id, user_id, school_id, full_name, email, contact_number, department_or_course, year_level, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), userId, school_id, full_name, email, contact_number, department_or_course, year_level, participant_type, nowIso]
      );
    }
  });

  const user = sanitizeUser(await query.get(`SELECT * FROM users WHERE id = ?`, [userId]));
  const participant = await query.get(`SELECT * FROM participants WHERE user_id = ?`, [userId]);
  await logActivity({
    userId,
    action: 'ACCOUNT_SIGNUP',
    description: `Participant ${username} (${school_id}) created an account.`
  });

  return { user, participant };
}

/**
 * Authenticate a user by username or email + password
 */
async function loginUser({ usernameOrEmail, password, ip = null, userAgent = null }) {
  const identifier = String(usernameOrEmail || '').trim().toLowerCase();
  if (!identifier || !password) {
    throw domainError('INVALID_INPUT', 'Username/email and password are required.', 400);
  }

  checkLoginRateLimit(ip, identifier);

  const userRow = await query.get(
    `SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?`,
    [identifier, identifier]
  );

  if (!userRow || !bcrypt.compareSync(password, userRow.password_hash)) {
    recordFailedLoginAttempt(ip, identifier);
    await logActivity({
      userId: userRow ? userRow.id : null,
      action: 'LOGIN_FAILED',
      description: `Failed login attempt for "${identifier}" from ${ip || 'unknown'}.`
    });
    throw domainError('INVALID_CREDENTIALS', 'Invalid username/email or password.', 401);
  }

  if (userRow.account_status !== 'active') {
    await logActivity({
      userId: userRow.id,
      action: 'LOGIN_BLOCKED',
      description: `Inactive account "${userRow.username}" attempted login.`
    });
    throw domainError('ACCOUNT_INACTIVE', 'This account has been deactivated. Contact an administrator.', 403);
  }

  clearLoginRateLimit(ip, identifier);
  const { sessionId, expiresAt } = await createSession(userRow.id, { ip, userAgent });
  const participant = (await query.get(`SELECT * FROM participants WHERE user_id = ?`, [userRow.id])) || null;

  await logActivity({
    userId: userRow.id,
    action: 'LOGIN',
    description: `${userRow.role} "${userRow.username}" logged in from ${ip || 'unknown'}.`
  });

  return {
    sessionId,
    expiresAt,
    user: sanitizeUser(userRow),
    participant
  };
}

/**
 * Create an Administrator account (only called by CLI script or existing Admin)
 */
async function createAdministrator({ full_name, username, email, password, actorUserId = null }) {
  const cleanName = String(full_name || username || 'Administrator').trim();
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanUser || !cleanEmail) {
    throw domainError('INVALID_INPUT', 'Username and email are required.', 400);
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(cleanUser)) {
    throw domainError('INVALID_USERNAME', 'Username must be 3-32 characters (letters, numbers, ., _, -).', 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw domainError('INVALID_EMAIL', 'Please enter a valid email address.', 400);
  }
  validatePasswordPolicy(password);

  const existing = await query.get(`SELECT id FROM users WHERE lower(username) = ? OR lower(email) = ?`, [cleanUser, cleanEmail]);
  if (existing) {
    throw domainError('DUPLICATE_ACCOUNT', 'An account with that username or email already exists.', 409);
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  await query.run(
    `INSERT INTO users (id, full_name, username, email, password_hash, role, account_status, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, 'administrator', 'active', 0, ?)`,
    [id, cleanName, cleanUser, cleanEmail, passwordHash, new Date().toISOString()]
  );

  await logActivity({
    userId: actorUserId || id,
    action: 'ADMIN_CREATED',
    description: `Administrator account "${cleanUser}" created.`
  });

  return sanitizeUser(await query.get(`SELECT * FROM users WHERE id = ?`, [id]));
}

async function listUsers({ role = null, status = null } = {}) {
  const conditions = [];
  const params = [];
  if (role) {
    conditions.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    conditions.push('u.account_status = ?');
    params.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query.all(
    `SELECT
      u.id, u.full_name, u.username, u.email, u.role, u.account_status, u.must_change_password, u.created_at,
      p.id AS participant_id, p.school_id, p.department_or_course, p.year_level, p.contact_number
    FROM users u
    LEFT JOIN participants p ON p.user_id = u.id
    ${where}
    ORDER BY u.created_at DESC`,
    params
  );

  return rows.map((r) => ({
    ...r,
    must_change_password: Boolean(r.must_change_password)
  }));
}

async function setAccountStatus(targetUserId, newStatus, actorUserId) {
  if (!['active', 'inactive'].includes(newStatus)) {
    throw domainError('INVALID_INPUT', 'account_status must be active or inactive.', 400);
  }
  if (targetUserId === actorUserId && newStatus === 'inactive') {
    throw domainError('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own active administrator account.', 400);
  }
  const target = await query.get(`SELECT * FROM users WHERE id = ?`, [targetUserId]);
  if (!target) {
    throw domainError('NOT_FOUND', 'Account not found.', 404);
  }
  await query.run(`UPDATE users SET account_status = ? WHERE id = ?`, [newStatus, targetUserId]);
  if (newStatus === 'inactive') {
    await deleteUserSessions(targetUserId);
  }
  await logActivity({
    userId: actorUserId,
    action: newStatus === 'active' ? 'ACCOUNT_REACTIVATED' : 'ACCOUNT_DEACTIVATED',
    description: `Set account "${target.username}" status to ${newStatus}.`
  });
  return sanitizeUser(await query.get(`SELECT * FROM users WHERE id = ?`, [targetUserId]));
}

async function resetUserPassword(targetUserId, tempPassword, actorUserId) {
  validatePasswordPolicy(tempPassword);
  const target = await query.get(`SELECT * FROM users WHERE id = ?`, [targetUserId]);
  if (!target) {
    throw domainError('NOT_FOUND', 'Account not found.', 404);
  }
  const hash = bcrypt.hashSync(tempPassword, BCRYPT_ROUNDS);
  await query.run(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`, [hash, targetUserId]);
  await deleteUserSessions(targetUserId);
  await logActivity({
    userId: actorUserId,
    action: 'PASSWORD_RESET',
    description: `Reset password for "${target.username}" (temporary password set).`
  });
  return sanitizeUser(await query.get(`SELECT * FROM users WHERE id = ?`, [targetUserId]));
}

async function changeOwnPassword(userId, currentPassword, newPassword) {
  const userRow = await query.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!userRow) {
    throw domainError('NOT_FOUND', 'User not found.', 404);
  }
  if (!bcrypt.compareSync(currentPassword || '', userRow.password_hash)) {
    throw domainError('INVALID_CREDENTIALS', 'Current password is incorrect.', 401);
  }
  validatePasswordPolicy(newPassword);
  const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  await query.run(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`, [hash, userId]);
  await logActivity({
    userId,
    action: 'PASSWORD_CHANGED',
    description: `User "${userRow.username}" updated their password.`
  });
  return sanitizeUser(await query.get(`SELECT * FROM users WHERE id = ?`, [userId]));
}

module.exports = {
  signupParticipant,
  loginUser,
  createAdministrator,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  purgeExpiredSessions,
  listUsers,
  setAccountStatus,
  resetUserPassword,
  changeOwnPassword,
  validatePasswordPolicy,
  failedLoginBuckets
};
