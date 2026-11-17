// Maintenance script to delete all rows from public.activity_logs
// after interactive confirmation. Does not touch any other table.
// Usage: $env:PGURL = '<postgres-url>'; npm run clear-activity-logs

const readline = require('node:readline');
const { Client } = require('pg');

function dbLabel(connStr) {
  try {
    const u = new URL(connStr);
    const db = (u.pathname || '').replace(/^\/+/, '') || 'postgres';
    return `${u.hostname}/${db}`;
  } catch {
    return 'configured database';
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

(async () => {
  const conn = process.env.PGURL;
  if (!conn) {
    console.error('Missing PGURL environment variable.');
    process.exit(1);
  }
  const target = dbLabel(conn);
  console.log(`Target database: ${target}`);
  const answer = await ask('Type YES to delete all activity logs: ');
  if (answer !== 'YES') {
    console.log('Aborted. No rows were deleted.');
    process.exit(0);
  }

  const c = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const res = await c.query('delete from public.activity_logs');
    console.log(`Deleted ${res.rowCount} row(s) from public.activity_logs on ${target}.`);
  } finally {
    await c.end();
  }
})().catch(e => {
  console.error('ERR:', e.message);
  process.exit(1);
});
