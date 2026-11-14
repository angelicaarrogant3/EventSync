const { Client } = require('pg');
const fs = require('fs');
// usage: PGURL=... node tools/apply-migration.js supabase/migrations/002_registration_flow.sql
(async () => {
  const file = process.argv[2];
  if (!file || !process.env.PGURL) { console.error('usage: PGURL=<conn> node tools/apply-migration.js <file.sql>'); process.exit(1); }
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('begin');
  try { await c.query(fs.readFileSync(file, 'utf8')); await c.query('commit'); console.log('applied', file); }
  catch (e) { await c.query('rollback'); throw e; }
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
