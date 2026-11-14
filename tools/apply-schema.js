const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const names = ['activity_logs','attendance','audit_log','events','node_status','participants','registrations','sessions','users'];
  for (const n of names) { const r = await c.query(`select count(*) n from public.${n}`); console.log('dropping', n, 'rows:', r.rows[0].n); }
  await c.query('begin');
  try {
    for (const n of names) await c.query(`drop table if exists public.${n} cascade`);
    await c.query(fs.readFileSync(__dirname + '/../supabase/schema.sql', 'utf8'));
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; }
  const t = await c.query("select table_name from information_schema.tables where table_schema='public' order by 1");
  console.log('now:', t.rows.map(r => r.table_name).join(', '));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
