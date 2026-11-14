const express = require('express');
const router = express.Router();
const config = require('../config');
const { success } = require('../utils/response');
const { query, isPostgres } = require('../db/connection');

router.get('/health', async (req, res, next) => {
  try {
    const dbCheck = await query.get('SELECT 1 AS alive');

    return success(res, {
      status: 'ONLINE',
      nodeId: config.nodeId,
      role: config.nodeRole,
      database: dbCheck && Number(dbCheck.alive) === 1
        ? (isPostgres ? 'CONNECTED (SUPABASE POSTGRESQL)' : 'CONNECTED (WAL MODE)')
        : 'ERROR',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

