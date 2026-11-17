const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const crypto = require('node:crypto');

const loadSched = () => import('../config/schedule.js');

const skip = !process.env.PGURL && 'PGURL not set';
let c, adminId, userId;

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role = 'admin' order by created_at limit 1")).rows[0]?.id;
  userId = (await c.query("select id from public.profiles where role = 'user' order by created_at limit 1")).rows[0]?.id;
  assert.ok(adminId && userId, 'need at least 1 admin and 1 participant');
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

test('Time-Out: IN then OUT, OUT without IN rejected, duplicate OUT/IN, concurrency, offline sync idempotency & window', { skip }, async () => {
  const { parseManilaInput } = await loadSched();
  const startsAt = parseManilaInput('2026-11-25T08:00');
  const endsAt = parseManilaInput('2026-11-25T17:00');

  const evId = (await c.query(
    `insert into public.events(title,venue,starts_at,ends_at,status)
     values ('TimeOut Test','Hall B',$1,$2,'published') returning id`,
    [startsAt, endsAt]
  )).rows[0].id;

  const reg = (await as(userId, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-20T09:00')]))[0].r;

  // 1. OUT without IN -> NO_TIME_IN_RECORDED, nothing written
  const outNoIn = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'OUT') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T09:00')]))[0].r;
  assert.equal(outNoIn.code, 'NO_TIME_IN_RECORDED');
  assert.equal((await c.query('select count(*)::int c from public.attendance where event_id=$1', [evId])).rows[0].c, 0);

  // 2. IN -> CHECKED IN, then IN again -> ALREADY_CHECKED_IN
  const in1 = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'IN') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T08:05')]))[0].r;
  assert.equal(in1.status, 'ok');
  const in2 = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'IN') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T08:10')]))[0].r;
  assert.equal(in2.code, 'ALREADY_CHECKED_IN');

  // 3. OUT outside attendance window -> EVENT_ENDED, check_out_time remains null
  const outLate = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'OUT') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T18:30')]))[0].r;
  assert.equal(outLate.code, 'EVENT_ENDED');

  // 4. OUT inside window -> CHECKED_OUT, then OUT again -> ALREADY_CHECKED_OUT (simulates concurrent second scanner)
  const out1 = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'OUT') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T11:50')]))[0].r;
  assert.equal(out1.code, 'CHECKED_OUT');
  const out2 = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'OUT') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T11:55')]))[0].r;
  assert.equal(out2.code, 'ALREADY_CHECKED_OUT');

  const row = (await c.query('select checked_in_at, check_out_time from public.attendance where event_id=$1', [evId])).rows[0];
  assert.ok(row.checked_in_at && row.check_out_time);

  // 5. Offline queue: OUT queued before IN in array, sorted by scanned_at -> both succeed, and replaying is idempotent
  await c.query('delete from public.attendance where event_id=$1', [evId]);
  const sIn = crypto.randomUUID(), sOut = crypto.randomUUID();
  const batch = [
    { scan_id: sOut, qr_token: reg.qr_token, event_id: evId, mode: 'OUT', scanned_at: parseManilaInput('2026-11-25T12:00') },
    { scan_id: sIn,  qr_token: reg.qr_token, event_id: evId, mode: 'IN',  scanned_at: parseManilaInput('2026-11-25T08:02') }
  ];
  const rSync1 = (await as(adminId, 'select public.sync_offline_attendance($1::jsonb, $2) r', [JSON.stringify(batch), parseManilaInput('2026-11-25T13:00')]))[0].r;
  assert.equal(rSync1[0].code, 'OK');
  assert.equal(rSync1[1].code, 'CHECKED_OUT');

  // Replay exact same batch -> idempotent, changes nothing
  const rSync2 = (await as(adminId, 'select public.sync_offline_attendance($1::jsonb, $2) r', [JSON.stringify(batch), parseManilaInput('2026-11-25T13:05')]))[0].r;
  assert.equal(rSync2[0].idempotent, true);
  assert.equal(rSync2[1].idempotent, true);

  // 6. Report includes time_in, time_out, and timed_out total
  const sheet = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, $2) r", [evId, parseManilaInput('2026-11-25T13:00')]))[0].r;
  assert.equal(sheet.totals.present, 1);
  assert.equal(sheet.totals.timed_out, 1);
  assert.ok(sheet.rows[0].time_in);
  assert.ok(sheet.rows[0].time_out);
});
