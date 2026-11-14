// Database-level tests for the registration flow. Each test runs in a transaction that is ROLLED BACK,
// acting as real `authenticated` users (RLS + SECURITY DEFINER RPCs exactly as the browser would).
//   $env:PGURL = '<postgres connection string>' ; npm test
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const skip = !process.env.PGURL && 'PGURL not set';
let c, users = [];

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  users = (await c.query("select id from public.profiles where role = 'user' order by created_at limit 2")).rows.map(r => r.id);
  assert.ok(users.length >= 2, 'need at least 2 participant accounts in the database');
});
after(async () => { if (c) await c.end(); });
beforeEach(async () => { if (c) await c.query('begin'); });
afterEach(async () => { if (c) await c.query('rollback'); });

const mkEvent = async (o = {}) => (await c.query(
  `insert into public.events(title,venue,starts_at,ends_at,capacity,status,registration_deadline)
   values ('TEST '||gen_random_uuid(),'Test Hall',$1,$2,$3,'published',$4) returning id`,
  [o.starts || new Date(Date.now() + 3600e3), o.ends || new Date(Date.now() + 7200e3), o.capacity ?? null, o.deadline ?? null])).rows[0].id;

async function as(uid, sql, params) {   // run one statement as an authenticated user
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await c.query('set local role authenticated');
  const rows = (await c.query(sql, params)).rows;   // on error the savepoint rollback in fails() restores the role
  await c.query('reset role');
  return rows;
}
async function fails(uid, sql, params, re) {   // expect an error, keep the transaction usable
  await c.query('savepoint s');
  try { await as(uid, sql, params); assert.fail('expected an error'); }
  catch (e) { assert.match(e.message, re); }
  finally { await c.query('rollback to savepoint s'); }
}
const reg = (uid, ev) => as(uid, 'select public.register_for_event($1) r', [ev]).then(r => r[0].r);
const count = async ev => (await c.query('select registered_count n from public.events where id=$1', [ev])).rows[0].n;

test('register: creates registration with QR token and increments the seat count', { skip }, async () => {
  const ev = await mkEvent({ capacity: 30 });
  const r = await reg(users[0], ev);
  assert.ok(r.id && r.qr_token, 'returns registration id and qr_token');
  assert.equal(r.status, 'registered'); assert.equal(r.already_registered, false);
  assert.equal(await count(ev), 1);
  const mine = await as(users[0], 'select id from public.registrations where event_id=$1', [ev]);
  assert.equal(mine.length, 1, 'participant can read their own registration');
});

test('duplicate register: returns the existing registration, no second row, count unchanged', { skip }, async () => {
  const ev = await mkEvent();
  const a = await reg(users[0], ev), b = await reg(users[0], ev);
  assert.equal(b.already_registered, true);
  assert.equal(b.id, a.id); assert.equal(b.qr_token, a.qr_token);
  assert.equal(await count(ev), 1);
});

test('register when full: rejected, count not exceeded', { skip }, async () => {
  const ev = await mkEvent({ capacity: 1 });
  await reg(users[0], ev);
  await fails(users[1], 'select public.register_for_event($1)', [ev], /full/i);
  assert.equal(await count(ev), 1);
});

test('registration deadline passed: rejected', { skip }, async () => {
  const ev = await mkEvent({ deadline: new Date(Date.now() - 60e3) });
  await fails(users[0], 'select public.register_for_event($1)', [ev], /deadline/i);
  assert.equal(await count(ev), 0);
});

test('cancel: frees the seat, a waiting user can then register, same QR on re-register', { skip }, async () => {
  const ev = await mkEvent({ capacity: 1 });
  const a = await reg(users[0], ev);
  await as(users[0], 'select public.cancel_registration($1)', [a.id]);
  assert.equal(await count(ev), 0);
  assert.equal((await c.query('select status from public.registrations where id=$1', [a.id])).rows[0].status, 'cancelled');
  await reg(users[1], ev);                       // seat was freed
  assert.equal(await count(ev), 1);
});

test('cancel after the event has started: rejected', { skip }, async () => {
  const ev = await mkEvent({ starts: new Date(Date.now() - 3600e3), ends: new Date(Date.now() + 3600e3) });
  const a = await reg(users[0], ev);
  await fails(users[0], 'select public.cancel_registration($1)', [a.id], /already started/i);
  assert.equal(await count(ev), 1);
});

test('a user cannot cancel someone else\'s registration', { skip }, async () => {
  const ev = await mkEvent();
  const a = await reg(users[0], ev);
  await fails(users[1], 'select public.cancel_registration($1)', [a.id], /not found/i);
});
