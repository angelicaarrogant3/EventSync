// Tests for Admin Users management: permissions (anon/participant/admin), summary counts,
// deactivation blocking login, self-deactivation blocked, password reset, and live admin updates.
//   $env:PGURL = '<postgres connection string>' ; npm test
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const skip = !process.env.PGURL && 'PGURL not set';
const cfg = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
const URL_ = (cfg.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1];
const KEY = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1];

let c, adminId, userId;

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role='admin' and status='active' limit 1")).rows[0]?.id;
  userId = (await c.query("select id from public.profiles where role='user' limit 1")).rows[0]?.id;
});
after(async () => { if (c) await c.end(); });
beforeEach(async () => { if (c) await c.query('begin'); });
afterEach(async () => { if (c) await c.query('rollback'); });

async function as(uid, sql, params) {
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await c.query('set local role authenticated');
  const rows = (await c.query(sql, params)).rows;
  await c.query('reset role');
  return rows;
}

test('HTTP permission checks: anonymous gets 401/403, participant gets rejected', { skip }, async () => {
  const rAnon = await fetch(`${URL_}/rest/v1/rpc/admin_list_users`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.ok([401, 403].includes(rAnon.status), `expected 401/403 for anon, got ${rAnon.status}`);

  await c.query('savepoint s');
  await assert.rejects(as(userId, 'select public.admin_list_users()'), /Admin only/);
  await c.query('rollback to savepoint s');
  await c.query('savepoint s2');
  await assert.rejects(as(userId, 'select public.admin_set_user_status($1, $2)', [userId, 'inactive']), /Admin only/);
  await c.query('rollback to savepoint s2');
  await c.query('savepoint s3');
  await assert.rejects(as(userId, 'select public.admin_create_admin($1, $2, $3)', ['Evil', 'evil@test.ph', 'Secret123']), /Admin only/);
  await c.query('rollback to savepoint s3');
});

test('admin_list_users: summary counts match DB and no password/session fields exposed', { skip }, async t => {
  if (!adminId) return t.skip('no admin');
  const res = (await as(adminId, 'select public.admin_list_users() d'))[0].d;
  const dbCounts = (await c.query(`
    select count(*)::int total,
           count(*) filter (where role='user')::int participants,
           count(*) filter (where role='admin')::int administrators,
           count(*) filter (where status='active')::int active,
           count(*) filter (where created_at >= now() - interval '7 days')::int new_this_week
    from public.profiles`)).rows[0];
  assert.deepEqual(res.summary, dbCounts);
  assert.equal(res.users.length, dbCounts.total);
  for (const u of res.users) {
    assert.equal('encrypted_password' in u, false);
    assert.equal('password_hash' in u, false);
    assert.equal('session' in u, false);
  }
});

test('self-deactivation is blocked; deactivating/reactivating another user works and logs', { skip }, async t => {
  if (!adminId || !userId) return t.skip('need admin and user');
  await c.query('savepoint s');
  await assert.rejects(as(adminId, 'select public.admin_set_user_status($1, $2)', [adminId, 'inactive']), /own account/i);
  await c.query('rollback to savepoint s');

  await as(adminId, 'select public.admin_set_user_status($1, $2)', [userId, 'inactive']);
  assert.equal((await c.query('select status from public.profiles where id=$1', [userId])).rows[0].status, 'inactive');
  await as(adminId, 'select public.admin_set_user_status($1, $2)', [userId, 'active']);
  assert.equal((await c.query('select status from public.profiles where id=$1', [userId])).rows[0].status, 'active');

  const logs = (await c.query("select action from public.activity_logs where entity_id=$1 order by id", [userId])).rows.map(r => r.action);
  assert.ok(logs.includes('user.deactivated') && logs.includes('user.reactivated'));
});

test('deactivated user cannot log in; reactivated user can log in; admin live update on new signup', { skip, timeout: 40000 }, async t => {
  if (!adminId) return t.skip('no admin');
  // Create temporary admin + user outside rolled-back transaction so GoTrue + Realtime see them, then clean up
  const db = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const pw = 'TestUsr#123';
  const admEmail = `adm-u-${Date.now()}@eventsync.test`;
  const usrEmail = `usr-u-${Date.now()}@eventsync.test`;
  const createdIds = [];
  const mk = async (email, role) => {
    const id = (await db.query(
      `insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,
         created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
       values ('00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',$1,crypt($2,gen_salt('bf')),now(),
         '{"provider":"email","providers":["email"],"created_by":"trusted_tool"}','{"full_name":"Users Test"}',now(),now(),'','','','') returning id`,
      [email, pw])).rows[0].id;
    await db.query(`insert into auth.identities(id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
      values (gen_random_uuid(),$1::uuid,jsonb_build_object('sub',$3::text,'email',$2::text),'email',$3::text,now(),now(),now())`, [id, email, String(id)]);
    if (role === 'admin') await db.query("update public.profiles set role='admin' where id=$1", [id]);
    createdIds.push(id);
    return id;
  };

  let sbAdmin, sbUser;
  try {
    await mk(admEmail, 'admin');
    const uid = await mk(usrEmail, 'user');

    sbAdmin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    assert.ifError((await sbAdmin.auth.signInWithPassword({ email: admEmail, password: pw })).error);

    // Deactivate user via admin RPC -> login must fail
    assert.ifError((await sbAdmin.rpc('admin_set_user_status', { p_user_id: uid, p_status: 'inactive' })).error);
    sbUser = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const badLogin = await sbUser.auth.signInWithPassword({ email: usrEmail, password: pw });
    assert.ok(badLogin.error, 'deactivated user must not be able to log in');

    // Reactivate -> login succeeds
    assert.ifError((await sbAdmin.rpc('admin_set_user_status', { p_user_id: uid, p_status: 'active' })).error);
    assert.ifError((await sbUser.auth.signInWithPassword({ email: usrEmail, password: pw })).error);

    // Live update: admin subscribed to profiles receives INSERT when a new user signs up
    const seen = [];
    const ch = sbAdmin.channel('admin-users-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'profiles' }, p => seen.push(p.new.email));
    await new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('realtime timeout')), 15000);
      ch.subscribe(s => { if (s === 'SUBSCRIBED') { clearTimeout(tm); res(); } });
    });
    const liveEmail = `live-${Date.now()}@eventsync.test`;
    await mk(liveEmail, 'user');
    for (let i = 0; i < 100 && !seen.includes(liveEmail); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(seen.includes(liveEmail), `admin should receive new signup ${liveEmail} live (saw ${JSON.stringify(seen)})`);
  } finally {
    if (sbAdmin) await sbAdmin.removeAllChannels();
    if (sbUser) await sbUser.removeAllChannels();
    if (createdIds.length) await db.query('delete from auth.users where id = any($1)', [createdIds]);
    await db.end();
  }
});
