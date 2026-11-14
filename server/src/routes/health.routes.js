const express = require('express');
const router = express.Router();
const config = require('../config');
const { success } = require('../utils/response');
const { db } = require('../db/connection');

router.get('/health', (req, res) => {
  // Quick SQLite sanity check
  const dbCheck = db.prepare('SELECT 1 AS alive').get();

  return success(res, {
    status: 'ONLINE',
    nodeId: config.nodeId,
    role: config.nodeRole,
    database: dbCheck && dbCheck.alive === 1 ? 'CONNECTED (WAL MODE)' : 'ERROR',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;

