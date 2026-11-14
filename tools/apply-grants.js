const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query(`
    grant usage on schema public to authenticated;
    grant select on public.events, public.registrations, public.attendance, public.activity_logs to authenticated;
    grant select, update on public.profiles to authenticated;
    grant insert, update, delete on public.events to authenticated;   -- RLS restricts to admins
    revoke all on all tables in schema public from anon;
    revoke truncate, references, trigger on all tables in schema public from authenticated;
    notify pgrst, 'reload schema';`);
  const r = await c.query("select grantee, table_name, string_agg(privilege_type, ',') p from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') group by 1,2 order by 1,2");
  r.rows.forEach(x => console.log(x.grantee, x.table_name, x.p));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
