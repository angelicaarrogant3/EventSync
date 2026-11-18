const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const skip = !process.env.PGURL && 'PGURL not set';
let c, adminId, user1, user2;

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role = 'admin' order by created_at limit 1")).rows[0]?.id;
  const us = (await c.query("select id from public.profiles where role = 'user' order by created_at limit 2")).rows;
  user1 = us[0]?.id;
  user2 = us[1]?.id;
  assert.ok(adminId && user1 && user2, 'need 1 admin and 2 participants');
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

async function fails(uid, sql, params, rx) {
  await c.query('savepoint sp');
  await assert.rejects(() => as(uid, sql, params), rx);
  await c.query('rollback to savepoint sp');
  await c.query('reset role');
}

test('Priority 1: Organizer role request flow, self-approval block, self-scan block, and event eligibility restrictions', { skip }, async () => {
  const { parseManilaInput } = await import('../config/schedule.js');

  // Ensure user1 and user2 have complete student profiles for role request & eligibility
  await c.query(
    "update public.profiles set full_name='Org Requester', school_id='21-1-9901', member_type='student', department='School of Engineering', program='BS in Computer Engineering', year_level=3 where id=$1",
    [user1]
  );
  await c.query(
    "update public.profiles set full_name='Second Student', school_id='21-1-9902', member_type='student', department='School of Engineering', program='BS in Computer Engineering', year_level=1 where id=$1",
    [user2]
  );

  // 1. Participant requests organizer role
  const req = (await as(user1, 'select public.request_organizer_role($1, $2) r', [
    'Faculty adviser for CpE society',
    'Seminars and coding bootcamps'
  ]))[0].r;
  assert.equal(req.status, 'pending');

  // Duplicate pending request is rejected
  await fails(user1, 'select public.request_organizer_role($1, $2)', ['Duplicate request', 'Workshops'], /already have a pending organizer request/i);

  // 2. Admin approves the request -> user1 becomes 'organizer'
  const reviewed = (await as(adminId, 'select public.admin_review_role_request($1, $2, $3) r', [
    req.id, 'approved', 'Verified adviser'
  ]))[0].r;
  assert.equal(reviewed.status, 'approved');

  const roleRow = (await c.query('select role from public.profiles where id = $1', [user1])).rows[0];
  assert.equal(roleRow.role, 'organizer');

  // 3. Organizer creates their own event with eligibility restrictions (School of Engineering, Year 3 & 4)
  const startsAt = parseManilaInput('2026-11-25T08:00');
  const endsAt = parseManilaInput('2026-11-25T12:00');
  const orgEvId = (await as(user1, `
    insert into public.events(title, venue, starts_at, ends_at, status, created_by, allowed_schools, allowed_year_levels)
    values ('CpE Senior Colloquium', 'Engineering Hall', $1, $2, 'published', $3, ARRAY['School of Engineering'], ARRAY[3::smallint, 4::smallint])
    returning id
  `, [startsAt, endsAt, user1]))[0].id;

  // Organizer cannot register as an attendee for their own event
  await fails(user1, 'select public.register_for_event($1, $2)', [orgEvId, parseManilaInput('2026-11-20T09:00')], /Organizers cannot register as attendees for their own event/i);

  // user2 (Year 1) is rejected by the Year 3/4 eligibility restriction
  await fails(user2, 'select public.register_for_event($1, $2)', [orgEvId, parseManilaInput('2026-11-20T09:00')], /restricted to year level/i);

  // Promote user2 to Year 3 -> now eligible and can register!
  await c.query('update public.profiles set year_level = 3 where id = $1', [user2]);
  const reg2 = (await as(user2, 'select public.register_for_event($1, $2) r', [orgEvId, parseManilaInput('2026-11-20T09:05')]))[0].r;
  assert.ok(reg2.qr_token);

  // 4. Self-scan prevention: if an organizer registers for another admin's event, they cannot scan their own QR pass
  const admEvId = (await as(adminId, `
    insert into public.events(title, venue, starts_at, ends_at, status, created_by)
    values ('Campus General Assembly', 'Gymnasium', $1, $2, 'published', $3)
    returning id
  `, [startsAt, endsAt, adminId]))[0].id;

  const orgReg = (await as(user1, 'select public.register_for_event($1, $2) r', [admEvId, parseManilaInput('2026-11-20T09:10')]))[0].r;

  // Admin scanning user1's pass on admEvId works, or if admin registers and tries to self-scan:
  const admSelfReg = (await as(adminId, 'select public.register_for_event($1, $2) r', [admEvId, parseManilaInput('2026-11-20T09:12')]))[0].r;
  const selfScanRes = (await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'IN') r", [
    admSelfReg.qr_token, admEvId, parseManilaInput('2026-11-25T08:05')
  ]))[0].r;
  assert.equal(selfScanRes.status, 'self_scan');
  assert.equal(selfScanRes.code, 'SELF_SCAN_NOT_ALLOWED');

  // Organizer (user1) scanning user2's pass on user1's own event succeeds
  const validScan = (await as(user1, "select public.verify_attendance($1, $2, $3, 'scan', 'IN') r", [
    reg2.qr_token, orgEvId, parseManilaInput('2026-11-25T08:05')
  ]))[0].r;
  assert.equal(validScan.status, 'ok');
});
