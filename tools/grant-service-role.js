const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query(`grant usage on schema public to service_role;
    grant all on all tables in schema public to service_role;
    grant execute on all functions in schema public to service_role;
    notify pgrst, 'reload schema';`);
  const r = await c.query('select email, role from public.profiles');
  console.log(JSON.stringify(r.rows));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
