const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t = await c.query("select table_name, (select string_agg(column_name,',' order by ordinal_position) from information_schema.columns k where k.table_schema='public' and k.table_name=t.table_name) cols from information_schema.tables t where table_schema='public' order by 1");
  t.rows.forEach(r => console.log(r.table_name, '=>', r.cols));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
