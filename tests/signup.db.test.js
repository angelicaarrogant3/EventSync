// Server-side signup validation. Rows are inserted into auth.users exactly like GoTrue does, so the
// handle_new_user trigger (account + profile in ONE transaction) runs. Every test is rolled back.
//   $env:PGURL = '<postgres connection string>' ; npm test
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const skip = !process.env.PGURL && 'PGURL not set';
let c, adminId, userId;
const rnd = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role='admin' limit 1")).rows[0]?.id;
  userId = (await c.query("select id from public.profiles where role='user' limit 1")).rows[0]?.id;
});
after(async () => { if (c) await c.end(); });
beforeEach(async () => { if (c) await c.query('begin'); });
afterEach(async () => { if (c) await c.query('rollback'); });

const base = () => ({
  full_name: 'Test Person', school_id: 'T-' + rnd(), member_type: 'student',
  department: 'School of Technology and Computer Studies',
  program: 'Bachelor of Science in Computer Science', major: '',
  year_level: '2', section: 'A', contact_number: '09171234567', consent: 'true'
});

async function signup(meta, email = `t-${rnd()}@school.test`, appMeta = '{"provider":"email","providers":["email"]}') {
  const id = (await c.query(
    `insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,
       created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
     values ('00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',$1,'x',now(),$2::jsonb,$3::jsonb,now(),now(),'','','','')
     returning id`, [email, appMeta, JSON.stringify(meta)])).rows[0].id;
  return { id, email };
}
async function rejects(meta, re, email, appMeta) {
  await c.query('savepoint s');
  try { await signup(meta, email, appMeta); assert.fail('expected the server to reject this signup'); }
  catch (e) { assert.match(e.message, re); }
  finally { await c.query('rollback to savepoint s'); }
}
const profile = async id => (await c.query('select * from public.profiles where id=$1', [id])).rows[0];

test('valid signup: account + profile created together with all fields, role = participant', { skip }, async () => {
  const m = base(), { id, email } = await signup(m);
  const p = await profile(id);
  assert.equal(p.role, 'user'); assert.equal(p.email, email);
  assert.equal(p.school_id, m.school_id); assert.equal(p.course, 'BS Computer Science'); assert.equal(p.year_level, 2);
  assert.equal(p.department, 'School of Technology and Computer Studies');
  assert.equal(p.program, 'Bachelor of Science in Computer Science');
  assert.equal(p.member_type, 'student'); assert.equal(p.section, 'A'); assert.equal(p.contact_number, '09171234567');
  assert.ok(p.consent_at, 'consent timestamp stored');
});

test('faculty signup needs no year level (stored as null)', { skip }, async () => {
  const { id } = await signup({ ...base(), member_type: 'faculty', year_level: '3' });
  assert.equal((await profile(id)).year_level, null);
});

test('duplicate email is rejected', { skip }, async () => {
  const { email } = await signup(base());
  await rejects(base(), /already|duplicate/i, email.toUpperCase());
});

test('duplicate school ID is rejected with a clear message', { skip }, async () => {
  const m = base(); await signup(m);
  await rejects({ ...base(), school_id: m.school_id.toLowerCase() }, /This school ID is already registered/);
});

test('missing / invalid required fields are rejected by the server', { skip }, async () => {
  await rejects({ ...base(), full_name: '' }, /Full name/);
  await rejects({ ...base(), school_id: '' }, /School ID/);
  await rejects({ ...base(), member_type: '' }, /Student, Faculty or Staff/);
  await rejects({ ...base(), member_type: 'admin' }, /Student, Faculty or Staff/);
  await rejects({ ...base(), department: '' }, /School/i);
  await rejects({ ...base(), program: '' }, /Program/i);
  await rejects({ ...base(), year_level: '' }, /Year level/);
  await rejects({ ...base(), consent: 'false' }, /consent/i);
  await rejects({ ...base(), contact_number: '12345' }, /Contact number/);
  await rejects(base(), /valid email/i, 'not-an-email');
});

test('"administrator" can never be set from the public form', { skip }, async () => {
  for (const evil of [{ role: 'admin' }, { role: 'administrator' }, { is_admin: true }, { member_type: 'student', role: 'admin' }]) {
    const { id } = await signup({ ...base(), ...evil });
    assert.equal((await profile(id)).role, 'user', JSON.stringify(evil));
  }
  // clients also cannot spoof the "trusted tool" marker: it lives in app_metadata, which GoTrue only lets the service role write
  const gotrue = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'signup.js'), 'utf8');
  assert.doesNotMatch(gotrue, /app_metadata/);
});

test('a participant cannot change role, school ID or email on their own profile', { skip }, async () => {
  const run = async sql => {
    await c.query('savepoint s');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    try { await c.query(sql); return 'ok'; } catch (e) { return e.message; } finally { await c.query('rollback to savepoint s'); }
  };
  assert.match(await run("update public.profiles set role='admin' where id=auth.uid()"), /permission denied/i);
  assert.match(await run("update public.profiles set school_id='HACK-1' where id=auth.uid()"), /permission denied/i);
  assert.match(await run("update public.profiles set email='x@y.zz' where id=auth.uid()"), /permission denied/i);
  assert.equal(await run("update public.profiles set section='B' where id=auth.uid()"), 'ok');
  assert.match(await run("update public.profiles set contact_number='123' where id=auth.uid()"), /Contact number/);
});

test('signup_availability reports taken school ID / email', { skip }, async () => {
  const m = base(), { email } = await signup(m);
  const r = (await c.query('select public.signup_availability($1,$2) a', [m.school_id, email])).rows[0].a;
  assert.equal(r.school_id_taken, true); assert.equal(r.email_taken, true);
  const f = (await c.query("select public.signup_availability('NOPE-9999','nobody@nowhere.test') a")).rows[0].a;
  assert.equal(f.school_id_taken, false); assert.equal(f.email_taken, false);
});

test('admin_register_participant: admins can create a full participant; participants cannot', { skip }, async t => {
  if (!adminId) return t.skip('no admin account in database');
  const as = async (uid, sql, params) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const rows = (await c.query(sql, params)).rows;
    await c.query('reset role');
    return rows;
  };
  const payload = { ...base(), email: `adm-${rnd()}@school.test`, password: 'Secret123' };
  const out = (await as(adminId, 'select public.admin_register_participant($1::jsonb) r', [JSON.stringify(payload)]))[0].r;
  const p = await profile(out.id);
  assert.equal(p.role, 'user'); assert.equal(p.school_id, payload.school_id); assert.equal(p.course, 'BS Computer Science');

  await c.query('savepoint s');
  await assert.rejects(as(userId, 'select public.admin_register_participant($1::jsonb)', [JSON.stringify({ ...base(), email: `x-${rnd()}@school.test`, password: 'Secret123' })]), /Admin only/);
  await c.query('rollback to savepoint s');

  await c.query('savepoint s2');
  await assert.rejects(as(adminId, 'select public.admin_register_participant($1::jsonb)', [JSON.stringify({ ...payload, email: `y-${rnd()}@school.test` })]), /This school ID is already registered/);
  await c.query('rollback to savepoint s2');
});
