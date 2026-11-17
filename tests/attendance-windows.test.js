const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const loadSched = () => import('../config/schedule.js');

test('getAttendanceState handles Nov 17 / Nov 25 scenario, exact boundaries, and cancelled events', async () => {
  const { getAttendanceState, getRegistrationState, getDerivedEventStatus, parseManilaInput, formatManila } = await loadSched();
  const startsAt = parseManilaInput('2026-11-25T08:00'); // Nov 25, 2026, 8:00 AM Manila
  const endsAt = parseManilaInput('2026-11-25T17:00');   // Nov 25, 2026, 5:00 PM Manila
  const ev = {
    status: 'published',
    starts_at: startsAt,
    ends_at: endsAt,
    registration_opens_at: parseManilaInput('2026-11-17T00:00'),
    registration_deadline: parseManilaInput('2026-11-23T23:59'),
    early_grace_minutes: 60,
    late_grace_minutes: 60
  };

  // Nov 17: registration open, attendance NOT_STARTED (opens Nov 25 7:00 AM)
  const nov17 = new Date(parseManilaInput('2026-11-17T10:00'));
  assert.equal(getRegistrationState(ev, nov17).open, true);
  const s1 = getAttendanceState(ev, nov17);
  assert.equal(s1.state, 'NOT_STARTED');
  assert.equal(formatManila(s1.opensAt), 'Nov 25, 2026, 7:00 AM');
  assert.equal(formatManila(s1.closesAt), 'Nov 25, 2026, 6:00 PM');
  assert.equal(getDerivedEventStatus(ev, nov17).label, 'Registration open');

  // Nov 24: registration closed, attendance still NOT_STARTED
  const nov24 = new Date(parseManilaInput('2026-11-24T12:00'));
  assert.equal(getRegistrationState(ev, nov24).open, false);
  assert.equal(getDerivedEventStatus(ev, nov24).label, 'Upcoming');

  // Exact open boundary: Nov 25, 7:00 AM
  const exactOpen = new Date(parseManilaInput('2026-11-25T07:00'));
  assert.equal(getAttendanceState(ev, exactOpen).state, 'OPEN');

  // During event: Nov 25, 10:00 AM
  const during = new Date(parseManilaInput('2026-11-25T10:00'));
  assert.equal(getAttendanceState(ev, during).state, 'OPEN');
  assert.equal(getDerivedEventStatus(ev, during).label, 'Ongoing');

  // After close: Nov 25, 6:01 PM
  const afterClose = new Date(parseManilaInput('2026-11-25T18:01'));
  assert.equal(getAttendanceState(ev, afterClose).state, 'ENDED');
  assert.equal(getDerivedEventStatus(ev, afterClose).label, 'Ended');

  // Cancelled
  assert.equal(getAttendanceState({ ...ev, status: 'cancelled' }, during).state, 'CANCELLED');
});

// ---- Database RPC tests (with fake clock p_now) ----
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

test('server-side attendance & registration windows + offline sync + test mode (Nov 17 / Nov 25)', { skip }, async () => {
  const { parseManilaInput } = await loadSched();
  const regOpens = parseManilaInput('2026-11-17T00:00');
  const regCloses = parseManilaInput('2026-11-23T23:59');
  const startsAt = parseManilaInput('2026-11-25T08:00');
  const endsAt = parseManilaInput('2026-11-25T17:00');

  const evId = (await c.query(
    `insert into public.events(title,venue,starts_at,ends_at,registration_opens_at,registration_deadline,status)
     values ('Nov 25 Summit','Main Hall',$1,$2,$3,$4,'published') returning id`,
    [startsAt, endsAt, regOpens, regCloses]
  )).rows[0].id;

  // Registration before opens -> rejected
  await c.query('savepoint s1');
  await assert.rejects(
    as(userId, 'select public.register_for_event($1, $2)', [evId, parseManilaInput('2026-11-16T23:00')]),
    /Registration opens on/
  );
  await c.query('rollback to savepoint s1');

  // Registration after deadline -> rejected (both self and admin)
  await c.query('savepoint s2');
  await assert.rejects(
    as(adminId, 'select public.admin_register_user_for_event($1, $2, $3)', [userId, evId, parseManilaInput('2026-11-24T08:00')]),
    /Registration is closed/
  );
  await c.query('rollback to savepoint s2');

  // Register inside window (Nov 17) -> succeeds
  const reg = (await as(userId, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-17T10:00')]))[0].r;

  // Scan on Nov 17 -> EVENT_NOT_STARTED, nothing written to attendance
  const early = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan') r", [reg.qr_token, evId, parseManilaInput('2026-11-17T10:05')]))[0].r;
  assert.equal(early.code, 'EVENT_NOT_STARTED');
  assert.match(early.message, /Nov 25, 2026, 7:00 AM/);
  assert.equal((await c.query('select count(*)::int c from public.attendance where event_id=$1', [evId])).rows[0].c, 0);

  // Manual check-in after window closes -> EVENT_ENDED
  const late = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'manual') r", [reg.qr_token, evId, parseManilaInput('2026-11-25T18:01')]))[0].r;
  assert.equal(late.code, 'EVENT_ENDED');

  // Offline sync: future timestamp rejected, pre-window scan rejected, in-window scan synced late -> accepted + clock_suspect!
  const syncRes = (await as(adminId, 'select public.sync_offline_attendance($1::jsonb, $2) r', [
    JSON.stringify([
      { qr_token: reg.qr_token, event_id: evId, scanned_at: parseManilaInput('2026-11-26T12:00') }, // future vs Nov 25 20:00
      { qr_token: reg.qr_token, event_id: evId, scanned_at: parseManilaInput('2026-11-17T10:00') }, // before window
      { qr_token: reg.qr_token, event_id: evId, scanned_at: parseManilaInput('2026-11-25T07:00') }  // exact open!
    ]),
    parseManilaInput('2026-11-25T20:00')
  ]))[0].r;
  assert.equal(syncRes[0].code, 'EVENT_NOT_STARTED');
  assert.equal(syncRes[1].status, 'ok');
  assert.equal(syncRes[1].clock_suspect, true);
  assert.equal(syncRes[2].code, 'FUTURE_TIMESTAMP');

  // Reports before event vs after event
  const repBefore = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, $2) r", [evId, parseManilaInput('2026-11-17T12:00')]))[0].r;
  assert.equal(repBefore.rows[0].status_label, 'Present'); // already checked in above, let's test test-mode + clear:

  // Enable test mode, clear, and record test check-in before event
  await c.query('delete from public.attendance where event_id=$1', [evId]);
  const repPending = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, $2) r", [evId, parseManilaInput('2026-11-17T12:00')]))[0].r;
  assert.equal(repPending.totals.present, 0);
  assert.equal(repPending.totals.absent, 0);
  assert.equal(repPending.rows[0].status_label, 'Pending');

  const repEnded = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, $2) r", [evId, parseManilaInput('2026-11-25T19:00')]))[0].r;
  assert.equal(repEnded.totals.absent, 1);
  assert.equal(repEnded.rows[0].status_label, 'Absent');

  // Test mode check-in on Nov 17
  await c.query('update public.events set allow_early_test_attendance = true where id = $1', [evId]);
  const testScan = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan') r", [reg.qr_token, evId, parseManilaInput('2026-11-17T10:15')]))[0].r;
  assert.equal(testScan.status, 'ok');
  assert.equal(testScan.is_test, true);

  // Excluded from default report, included when p_include_test = true
  const repExcl = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, $2) r", [evId, parseManilaInput('2026-11-17T12:00')]))[0].r;
  assert.equal(repExcl.totals.present, 0);
  const repIncl = (await as(adminId, "select public.attendance_sheet($1, 'all', null, true, $2) r", [evId, parseManilaInput('2026-11-17T12:00')]))[0].r;
  assert.equal(repIncl.totals.present, 1);

  // Clear test check-ins
  const cleared = (await as(adminId, 'select public.admin_clear_test_attendance($1) c', [evId]))[0].c;
  assert.equal(cleared, 1);
});

test('Late label: on time, exactly at limit, late, disabled, offline sync, and report totals', { skip }, async () => {
  const { isLateCheckIn, parseManilaInput } = await loadSched();
  const startsAt = parseManilaInput('2026-11-25T08:00');
  const endsAt = parseManilaInput('2026-11-25T17:00');
  const ev = { starts_at: startsAt, late_after_minutes: 15 };

  // Unit checks: on time, exactly at 15 min limit (not late), 16 min (late), disabled (0 / null)
  assert.equal(isLateCheckIn(ev, parseManilaInput('2026-11-25T08:10')), false);
  assert.equal(isLateCheckIn(ev, parseManilaInput('2026-11-25T08:15')), false);
  assert.equal(isLateCheckIn(ev, parseManilaInput('2026-11-25T08:16')), true);
  assert.equal(isLateCheckIn({ starts_at: startsAt, late_after_minutes: 0 }, parseManilaInput('2026-11-25T09:00')), false);
  assert.equal(isLateCheckIn({ starts_at: startsAt, late_after_minutes: null }, parseManilaInput('2026-11-25T09:00')), false);

  // DB + offline sync check: scan made at 08:20 (late) synced at 16:00 -> Present (Late), counts as Present
  const evId = (await c.query(
    `insert into public.events(title,venue,starts_at,ends_at,late_after_minutes,status)
     values ('Late Test Event','Hall A',$1,$2,15,'published') returning id`,
    [startsAt, endsAt]
  )).rows[0].id;
  const reg = (await as(userId, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-20T10:00')]))[0].r;

  const syncRes = (await as(adminId, 'select public.sync_offline_attendance($1::jsonb, $2) r', [
    JSON.stringify([{ qr_token: reg.qr_token, event_id: evId, scanned_at: parseManilaInput('2026-11-25T08:20') }]),
    parseManilaInput('2026-11-25T16:00')
  ]))[0].r;
  assert.equal(syncRes[0].status, 'ok');

  const sheet = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, $2) r", [evId, parseManilaInput('2026-11-25T16:00')]))[0].r;
  assert.equal(sheet.totals.present, 1);
  assert.equal(sheet.totals.late, 1);
  assert.equal(sheet.rows[0].status_label, 'Present (Late)');
});
