const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('events', JSON.stringify(await q('select id,title,status,capacity,starts_at,ends_at from public.events')));
  console.log('regs', JSON.stringify(await q('select id,event_id,user_id,status from public.registrations')));
  console.log('profiles', JSON.stringify(await q('select id,email,role from public.profiles')));
  console.log('stats', JSON.stringify(await q('select id,registered_count,attended_count from public.event_stats')));
  console.log('fn', JSON.stringify(await q("select pg_get_functiondef('public.register_for_event(uuid)'::regprocedure) d")).slice(0, 200));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
