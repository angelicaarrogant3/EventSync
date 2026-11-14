const express = require('express');
const router = express.Router();
const nodesService = require('../services/nodes.service');
const { success, error } = require('../utils/response');
const { broadcastNodeStatus } = require('../sockets/socketManager');
const { requireRole } = require('../middleware/auth.middleware');

// GET /api/nodes (Admin only)
router.get('/nodes', requireRole('administrator'), (req, res, next) => {
  try {
    const nodes = nodesService.getAllNodes();
    return success(res, nodes);
  } catch (err) {
    next(err);
  }
});

// GET /api/nodes/summary (Admin only)
router.get('/nodes/summary', requireRole('administrator'), (req, res, next) => {
  try {
    const summary = nodesService.getNodesSummary();
    return success(res, summary);
  } catch (err) {
    next(err);
  }
});

// POST /api/nodes/heartbeat (Admin only)
router.post('/nodes/heartbeat', requireRole('administrator'), (req, res, next) => {
  try {
    const { nodeId, deviceId, role, deviceType, deviceName } = req.body;
    const finalId = deviceId || nodeId;

    if (!finalId || !role) {
      return error(res, 'INVALID_INPUT', 'deviceId and role are required', 400);
    }

    const clientIp = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
    nodesService.recordHeartbeat(finalId, role, clientIp, deviceType, deviceName);
    broadcastNodeStatus();
    return success(res, { acknowledged: true, deviceId: finalId, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
