const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const loadCfg = () => import('../config/feedback.js');

test('validateFeedbackUrl accepts valid Google Form links and rejects http, javascript, data, other domains, look-alikes', async () => {
  const { validateFeedbackUrl } = await loadCfg();

  for (const good of [
    '',
    '  https://docs.google.com/forms/d/e/1FAIpQLScExample/viewform  ',
    'https://forms.gle/AbCdEf123456',
    'https://forms.google.com/myform'
  ]) {
    assert.equal(validateFeedbackUrl(good).ok, true, good);
  }

  for (const bad of [
    'http://docs.google.com/forms/d/e/123/viewform',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.com/forms/123',
    'https://docs.google.com.evil.com/forms/123',
    'https://myforms.gle/abc',
    'https://docs.google.com/spreadsheets/d/123',
    'https://forms.gle/' + 'a'.repeat(500)
  ]) {
    assert.equal(validateFeedbackUrl(bad).ok, false, `should reject: ${bad}`);
  }
});

// ---- Database + Server Visibility Tests ----
const skip = !process.env.PGURL && 'PGURL not set';
let c, adminId, user1, user2;

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role = 'admin' order by created_at limit 1")).rows[0]?.id;
  const us = (await c.query("select id from public.profiles where role = 'user' order by created_at limit 2")).rows;
  user1 = us[0]?.id; user2 = us[1]?.id;
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

test('server-side feedback validation, column protection, visibility rules, early open, voided/test exclusion', { skip }, async () => {
  const { parseManilaInput } = await import('../config/schedule.js');
  const formUrl = 'https://forms.gle/TestFeedback123';
  const startsAt = parseManilaInput('2026-11-25T08:00');
  const endsAt = parseManilaInput('2026-11-25T17:00');

  // Create event with valid feedback URL
  const evId = (await as(adminId,
    `insert into public.events(title,venue,starts_at,ends_at,status,created_by,feedback_url,feedback_audience)
     values ('Feedback Summit','Hall C',$1,$2,'published',$3,$4,'attended') returning id`,
    [startsAt, endsAt, adminId, formUrl]
  ))[0].id;

  // Server rejects invalid URLs on events
  await c.query('savepoint sp_bad');
  await assert.rejects(
    as(adminId, "update public.events set feedback_url = 'https://evil.com/form' where id = $1", [evId]),
    /Google Forms/i
  );
  await c.query('rollback to savepoint sp_bad');

  // Participant cannot update feedback_url or select feedback_url directly from events
  await c.query('savepoint sp_p1');
  const upd = await as(user1, "update public.events set feedback_url = 'https://forms.gle/hack' where id = $1", [evId]);
  // RLS silently blocks 0 rows or raises; either way feedback_url must stay formUrl
  await c.query('rollback to savepoint sp_p1');
  assert.equal((await c.query('select feedback_url from public.events where id=$1', [evId])).rows[0].feedback_url, formUrl);

  await c.query('savepoint sp_sel');
  await assert.rejects(
    as(user1, 'select feedback_url from public.events where id = $1', [evId]),
    /permission denied/i
  );
  await c.query('rollback to savepoint sp_sel');

  // Register user1 (attended) and user2 (absent)
  const r1 = (await as(user1, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-20T09:00')]))[0].r;
  await as(user2, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-20T09:05')]);
  await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'IN')", [r1.qr_token, evId, parseManilaInput('2026-11-25T08:05')]);

  // 1. Before end time -> NO url for anyone
  const beforeEnd = parseManilaInput('2026-11-25T16:00');
  const u1Before = (await as(user1, 'select public.my_registrations($1) r', [beforeEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1Before.feedback.available, false);
  assert.equal(u1Before.feedback.url, undefined);

  // 2. Open feedback early -> visible to attendee, hidden to absent; closing hides it again
  await as(adminId, 'select public.admin_set_feedback_early($1, true)', [evId]);
  const u1Early = (await as(user1, 'select public.my_registrations($1) r', [beforeEnd]))[0].r.find(x => x.event_id === evId);
  const u2Early = (await as(user2, 'select public.my_registrations($1) r', [beforeEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1Early.feedback.available, true);
  assert.equal(u1Early.feedback.url, formUrl);
  assert.equal(u2Early.feedback.available, false);
  assert.equal(u2Early.feedback.url, undefined);

  await as(adminId, 'select public.admin_set_feedback_early($1, false)', [evId]);
  const u1Closed = (await as(user1, 'select public.my_registrations($1) r', [beforeEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1Closed.feedback.available, false);

  // 3. After end time -> attendee gets URL, absent does not (attended mode), absent DOES in registered mode
  const afterEnd = parseManilaInput('2026-11-25T17:05');
  const u1After = (await as(user1, 'select public.my_registrations($1) r', [afterEnd]))[0].r.find(x => x.event_id === evId);
  const u2After = (await as(user2, 'select public.my_registrations($1) r', [afterEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1After.feedback.url, formUrl);
  assert.equal(u2After.feedback.url, undefined);

  await c.query("update public.events set feedback_audience = 'registered' where id = $1", [evId]);
  const u2RegMode = (await as(user2, 'select public.my_registrations($1) r', [afterEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u2RegMode.feedback.available, true);
  assert.equal(u2RegMode.feedback.url, formUrl);

  // 4. Voided or test check-in does NOT make user1 eligible in attended mode
  await c.query("update public.events set feedback_audience = 'attended' where id = $1", [evId]);
  await c.query('update public.attendance set voided = true where event_id = $1', [evId]);
  const u1Voided = (await as(user1, 'select public.my_registrations($1) r', [afterEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1Voided.feedback.available, false);

  await c.query('update public.attendance set voided = false, is_test = true where event_id = $1', [evId]);
  const u1Test = (await as(user1, 'select public.my_registrations($1) r', [afterEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1Test.feedback.available, false);

  // 5. Cancelled event or cancelled registration never gets URL
  await c.query('update public.attendance set is_test = false where event_id = $1', [evId]);
  await c.query("update public.events set status = 'cancelled' where id = $1", [evId]);
  const u1CancEv = (await as(user1, 'select public.my_registrations($1) r', [afterEnd]))[0].r.find(x => x.event_id === evId);
  assert.equal(u1CancEv.feedback.available, false);
});
