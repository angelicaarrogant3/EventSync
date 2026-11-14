const { query } = require('../db/connection');
const config = require('../config');

/**
 * Record a heartbeat from any physical device (laptop, phone, tablet).
 * Dynamically binds or updates the device's role, type, and name.
 */
async function recordHeartbeat(deviceId, role, ipAddress, deviceType = 'laptop', deviceName = null) {
  const finalDeviceName = deviceName || `${deviceType.charAt(0).toUpperCase() + deviceType.slice(1)} (${deviceId.substring(0, 6)})`;
  const nowIso = new Date().toISOString();

  await query.run(
    `INSERT INTO node_status (node_id, role, device_type, device_name, last_seen, status, ip_address)
     VALUES (?, ?, ?, ?, ?, 'ONLINE', ?)
     ON CONFLICT(node_id) DO UPDATE SET
       role = excluded.role,
       device_type = COALESCE(excluded.device_type, node_status.device_type),
       device_name = COALESCE(excluded.device_name, node_status.device_name),
       last_seen = excluded.last_seen,
       status = 'ONLINE',
       ip_address = COALESCE(excluded.ip_address, node_status.ip_address)`,
    [deviceId, role, deviceType, finalDeviceName, nowIso, ipAddress || '127.0.0.1']
  );
}

/**
 * Marks a node or device offline explicitly
 */
async function markNodeOffline(deviceId) {
  await query.run(
    `UPDATE node_status SET status = 'OFFLINE' WHERE node_id = ?`,
    [deviceId]
  );
}

/**
 * Scans for devices that have not sent a heartbeat for > timeoutMs.
 * Transitions them to OFFLINE. Server itself is excluded.
 */
async function checkNodeTimeouts(timeoutMs = config.heartbeatTimeoutMs) {
  const onlineNodes = await query.all(
    `SELECT node_id, last_seen
     FROM node_status
     WHERE node_id != ?
       AND role != 'SERVER'
       AND status = 'ONLINE'`,
    [config.nodeId]
  );

  const now = Date.now();
  const timedOutNodes = onlineNodes.filter((n) => {
    const parsed = Date.parse(n.last_seen);
    if (Number.isNaN(parsed)) return false;
    return (now - parsed) > timeoutMs;
  });

  if (timedOutNodes.length > 0) {
    await query.transaction(async (tx) => {
      for (const n of timedOutNodes) {
        await tx.run(`UPDATE node_status SET status = 'OFFLINE' WHERE node_id = ?`, [n.node_id]);
      }
    });
    return { changed: true, timedOutCount: timedOutNodes.length };
  }

  return { changed: false, timedOutCount: 0 };
}

/**
 * Retrieve all registered cluster devices with current status
 */
async function getAllNodes() {
  const rows = await query.all(
    `SELECT
      node_id,
      node_id AS device_id,
      role,
      device_type,
      device_name,
      last_seen,
      status,
      ip_address
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
      last_seen DESC`
  );

  const now = Date.now();
  return rows.map((r) => {
    const parsed = Date.parse(r.last_seen);
    const seconds = Number.isNaN(parsed) ? 0 : Math.max(0, Math.floor((now - parsed) / 1000));
    return { ...r, seconds_since_last_seen: seconds };
  });
}

/**
 * Aggregated summary of connected cluster devices per role.
 * Identifies if any required role currently lacks an active online device.
 */
async function getNodesSummary() {
  const all = await getAllNodes();
  const online = all.filter((n) => n.status === 'ONLINE');

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

  return {
    totalRegisteredDevices: all.length,
    totalOnlineDevices: online.length,
    countsByRole,
    serverOnline: countsByRole.SERVER > 0,
    isClusterComplete: missingRoles.length === 0,
    missingRoles,
    devices: all
  };
}

module.exports = {
  recordHeartbeat,
  markNodeOffline,
  checkNodeTimeouts,
  getAllNodes,
  getNodesSummary
};
