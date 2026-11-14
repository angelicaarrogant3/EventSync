const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where email = 'delacruzangeline071905@gmail.com' returning email, email_confirmed_at");
  console.log(JSON.stringify(r.rows));
  const p = await c.query("select email, role from public.profiles");
  console.log(JSON.stringify(p.rows));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
