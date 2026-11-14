const { db } = require('../db/connection');
const config = require('../config');

/**
 * Record a heartbeat from any physical device (laptop, phone, tablet).
 * Dynamically binds or updates the device's role, type, and name.
 */
function recordHeartbeat(deviceId, role, ipAddress, deviceType = 'laptop', deviceName = null) {
  const finalDeviceName = deviceName || `${deviceType.charAt(0).toUpperCase() + deviceType.slice(1)} (${deviceId.substring(0, 6)})`;

  const stmt = db.prepare(`
    INSERT INTO node_status (node_id, role, device_type, device_name, last_seen, status, ip_address)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'), 'ONLINE', ?)
    ON CONFLICT(node_id) DO UPDATE SET
      role = excluded.role,
      device_type = COALESCE(excluded.device_type, node_status.device_type),
      device_name = COALESCE(excluded.device_name, node_status.device_name),
      last_seen = datetime('now', 'localtime'),
      status = 'ONLINE',
      ip_address = COALESCE(excluded.ip_address, node_status.ip_address)
  `);

  stmt.run(deviceId, role, deviceType, finalDeviceName, ipAddress || '127.0.0.1');
}

/**
 * Marks a node or device offline explicitly
 */
function markNodeOffline(deviceId) {
  const stmt = db.prepare(`
    UPDATE node_status
    SET status = 'OFFLINE'
    WHERE node_id = ?
  `);
  stmt.run(deviceId);
}

/**
 * Scans for devices that have not sent a heartbeat for > timeoutMs.
 * Transitions them to OFFLINE. Server itself is excluded.
 */
function checkNodeTimeouts(timeoutMs = config.heartbeatTimeoutMs) {
  const timeoutSec = Math.floor(timeoutMs / 1000);

  const findTimedOut = db.prepare(`
    SELECT node_id, role, device_type, device_name, last_seen, status
    FROM node_status
    WHERE node_id != ?
      AND role != 'SERVER'
      AND status = 'ONLINE'
      AND (strftime('%s', 'now', 'localtime') - strftime('%s', last_seen)) > ?
  `);

  const timedOutNodes = findTimedOut.all(config.nodeId, timeoutSec);

  if (timedOutNodes.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE node_status
      SET status = 'OFFLINE'
      WHERE node_id = ?
    `);

    const updateTx = db.transaction((nodes) => {
      for (const n of nodes) {
        updateStmt.run(n.node_id);
      }
    });

    updateTx(timedOutNodes);
    return { changed: true, timedOutCount: timedOutNodes.length };
  }

  return { changed: false, timedOutCount: 0 };
}

/**
 * Retrieve all registered cluster devices with current status
 */
function getAllNodes() {
  const stmt = db.prepare(`
    SELECT 
      node_id,
      node_id AS device_id,
      role,
      device_type,
      device_name,
      last_seen,
      status,
      ip_address,
      (strftime('%s', 'now', 'localtime') - strftime('%s', last_seen)) AS seconds_since_last_seen
    FROM node_status
    ORDER BY 
      CASE role 
        WHEN 'SERVER' THEN 1 
        WHEN 'REGISTRATION' THEN 2 
        WHEN 'SCANNER' THEN 3 
        WHEN 'ORGANIZER' THEN 4 
        ELSE 5 
      END ASC,
      status DESC,
      last_seen DESC
  `);

  return stmt.all();
}

/**
 * Aggregated summary of connected cluster devices per role.
 * Identifies if any required role currently lacks an active online device.
 */
function getNodesSummary() {
  const all = getAllNodes();
  const online = all.filter(n => n.status === 'ONLINE');

  const countsByRole = {
    SERVER: 0,
    REGISTRATION: 0,
    SCANNER: 0,
    ORGANIZER: 0
  };

  for (const n of online) {
    if (countsByRole[n.role] !== undefined) {
      countsByRole[n.role]++;
    }
  }

  // Check required roles
  const requiredRoles = [
    { role: 'REGISTRATION', label: 'Node 2 (Registration)' },
    { role: 'SCANNER', label: 'Node 3 (Scanner)' },
    { role: 'ORGANIZER', label: 'Node 4 (Organizer)' }
  ];

  const missingRoles = [];
  for (const r of requiredRoles) {
    if (countsByRole[r.role] === 0) {
      missingRoles.push(r);
    }
  }

  const isClusterComplete = missingRoles.length === 0;

  return {
    totalRegisteredDevices: all.length,
    totalOnlineDevices: online.length,
    countsByRole,
    serverOnline: countsByRole.SERVER > 0,
    isClusterComplete,
    missingRoles,
    warningMessage: isClusterComplete 
      ? null 
      : `${missingRoles.map(m => m.label).join(' and ')} has no active online device connected!`
  };
}

module.exports = {
  recordHeartbeat,
  markNodeOffline,
  checkNodeTimeouts,
  getAllNodes,
  getNodesSummary
};
