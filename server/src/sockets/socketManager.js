const { Server } = require('socket.io');
const config = require('../config');
const { recordHeartbeat, checkNodeTimeouts, getAllNodes, getNodesSummary } = require('../services/nodes.service');
const { getSession } = require('../services/auth.service');
const { parseCookies, SESSION_COOKIE_NAME } = require('../middleware/auth.middleware');

let io = null;
let healthCheckTimer = null;

// Track active socket IDs to device metadata
const socketToDeviceMap = new Map();

/**
 * Initialize Socket.IO server with session authentication and distributed device heartbeat supervision
 */
function initializeSockets(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingInterval: 5000,
    pingTimeout: 10000
  });

  // Authenticate every Socket.IO connection using the same database session cookie
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers?.cookie || '');
      const sid = cookies[SESSION_COOKIE_NAME] || socket.handshake.auth?.sessionId;
      if (!sid) {
        return next(new Error('UNAUTHORIZED'));
      }
      const sess = await getSession(sid, { touch: true });
      if (!sess || !sess.user) {
        return next(new Error('UNAUTHORIZED'));
      }
      socket.user = sess.user;
      socket.participant = sess.participant || null;
      return next();
    } catch {
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const rawIp = socket.handshake.address || socket.conn.remoteAddress || '127.0.0.1';
    const clientIp = rawIp.replace(/^.*:/, '');
    const user = socket.user;

    // Join role and user rooms
    socket.join(`role:${user.role}`);
    socket.join(`user:${user.id}`);

    // Only Administrator sockets can register as cluster stations and send heartbeats
    socket.on('node:identify', async (data) => {
      if (user.role !== 'administrator') return;
      const { nodeId, deviceId, role, deviceType, deviceName } = data || {};
      const finalId = deviceId || nodeId;
      if (finalId && role) {
        socketToDeviceMap.set(socket.id, { deviceId: finalId, role, deviceType, deviceName });
        socket.join(`station:${role}`);
        await recordHeartbeat(finalId, role, clientIp, deviceType, deviceName);
        await broadcastNodeStatus();
      }
    });

    socket.on('node:heartbeat', async (data) => {
      if (user.role !== 'administrator') return;
      const { nodeId, deviceId, role, deviceType, deviceName } = data || {};
      const finalId = deviceId || nodeId;
      if (finalId && role) {
        await recordHeartbeat(finalId, role, clientIp, deviceType, deviceName);
      }
    });

    socket.on('disconnect', () => {
      if (socketToDeviceMap.has(socket.id)) {
        socketToDeviceMap.delete(socket.id);
      }
    });
  });

  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(async () => {
    try {
      const { changed } = await checkNodeTimeouts(config.heartbeatTimeoutMs);
      if (changed) {
        await broadcastNodeStatus();
      }
    } catch {
      // Non-fatal background supervisor tick
    }
  }, 3000);

  console.log('[Socket] Socket.IO hub initialized with session auth & device health supervisor');
  return io;
}

async function broadcastNodeStatus() {
  if (!io) return;
  try {
    const nodes = await getAllNodes();
    const summary = await getNodesSummary();
    io.to('role:administrator').emit('node:status', {
      timestamp: new Date().toISOString(),
      nodes,
      summary
    });
  } catch {
    // Non-fatal
  }
}

function broadcastRegistrationCreated(data) {
  if (!io) return;
  const payload = {
    timestamp: new Date().toISOString(),
    ...data
  };
  // Full registration details only to Administrator sockets
  io.to('role:administrator').emit('registration:created', payload);

  // Notify only the owning participant if linked to a user account
  const targetUserId = data.participant?.user_id || data.participant?.userId;
  if (targetUserId) {
    io.to(`user:${targetUserId}`).emit('my:registration_updated', {
      timestamp: payload.timestamp,
      eventId: data.eventId,
      registrationId: data.registration?.id
    });
  }
}

function broadcastAttendanceCheckedIn(data) {
  if (!io) return;
  const payload = {
    timestamp: new Date().toISOString(),
    ...data
  };
  // Full check-in feed only to Administrator sockets
  io.to('role:administrator').emit('attendance:checked_in', payload);

  // Notify only the owning participant if linked to a user account
  const targetUserId = data.participant?.userId || data.participant?.user_id;
  if (targetUserId) {
    io.to(`user:${targetUserId}`).emit('my:attendance_updated', {
      timestamp: payload.timestamp,
      eventId: data.eventId,
      checkedInAt: data.attendance?.checked_in_at
    });
  }
}

function broadcastEventUpdated(data) {
  if (!io) return;
  const payload = {
    timestamp: new Date().toISOString(),
    ...data
  };
  io.to('role:administrator').emit('event:updated', payload);
  // Participants receive non-sensitive event availability updates
  io.to('role:participant').emit('event:updated', {
    timestamp: payload.timestamp,
    action: data.action,
    event: data.event ? {
      id: data.event.id,
      title: data.event.title,
      status: data.event.status,
      remaining_capacity: data.event.remaining_capacity
    } : null
  });
}

function broadcastEventDeleted(data) {
  if (!io) return;
  const payload = {
    timestamp: new Date().toISOString(),
    ...data
  };
  io.to('role:administrator').emit('event:deleted', payload);
  io.to('role:participant').emit('event:deleted', {
    timestamp: payload.timestamp,
    eventId: data.eventId,
    action: data.action
  });
}

module.exports = {
  initializeSockets,
  broadcastNodeStatus,
  broadcastRegistrationCreated,
  broadcastAttendanceCheckedIn,
  broadcastEventUpdated,
  broadcastEventDeleted,
  getIO: () => io
};
