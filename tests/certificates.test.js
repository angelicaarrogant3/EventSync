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

test('Certificates: issuance, event-not-ended block, duplicate prevention, frozen snapshot on template edit, RLS, revocation, and verify RPC', { skip }, async () => {
  const { parseManilaInput } = await import('../config/schedule.js');

  await c.query(
    "update public.profiles set full_name='Maria Clara Delos Santos', school_id='21-1-8801', member_type='student', department='School of Engineering', program='BS in Computer Engineering', year_level=3, section='3A' where id=$1",
    [user1]
  );
  await c.query(
    "update public.profiles set full_name='Jose Protacio Rizal', school_id='21-1-8802', member_type='student', department='School of Engineering', program='BS in Computer Engineering', year_level=4, section='4B' where id=$1",
    [user2]
  );

  // 1. Template validation: blocks missing QR/Certificate ID and blocks prohibited PII fields (school_id, email, phone)
  await fails(adminId, `
    insert into public.certificate_templates(owner_id, name, layout, is_global)
    values ($1, 'Missing QR Template', '[{"type":"participant_name","x":100,"y":100,"width":500,"height":60}]'::jsonb, false)
  `, [adminId], /Certificate ID and QR code boxes are mandatory/i);

  await fails(adminId, `
    insert into public.certificate_templates(owner_id, name, layout, is_global)
    values ($1, 'Forbidden PII Template', '[
      {"type":"participant_name","x":100,"y":100,"width":500,"height":60},
      {"type":"school_id","x":100,"y":200,"width":400,"height":40},
      {"type":"certificate_id","x":100,"y":300,"width":400,"height":40},
      {"type":"qr_code","x":600,"y":300,"width":150,"height":150}
    ]'::jsonb, false)
  `, [adminId], /not allowed on certificates/i);

  // 2. Create a valid custom template
  const tplRow = (await as(adminId, `
    insert into public.certificate_templates(owner_id, name, layout, is_global)
    values ($1, 'Engineering Custom Template', '[
      {"type":"participant_name","x":250,"y":500,"width":1500,"height":90,"font":"serif","size":62,"color":"#991b1b","alignment":"center","auto_shrink":true},
      {"type":"event_name","x":250,"y":760,"width":1500,"height":75,"font":"serif","size":46,"color":"#1c1917","alignment":"center","auto_shrink":true},
      {"type":"certificate_id","x":700,"y":1255,"width":600,"height":32,"font":"mono","size":20,"color":"#44403c","alignment":"center","auto_shrink":false},
      {"type":"qr_code","x":1680,"y":1090,"width":180,"height":180,"font":"sans","size":16,"color":"#000000","alignment":"center","auto_shrink":false}
    ]'::jsonb, false)
    returning *
  `, [adminId]))[0];
  assert.equal(tplRow.version, 1);

  // RLS: Participant (user1) cannot read admin's private non-global template
  const pTemplates = await as(user1, 'select id from public.certificate_templates where id = $1', [tplRow.id]);
  assert.equal(pTemplates.length, 0, 'participant must not read private templates');

  // 3. Create event using this template
  const startsAt = parseManilaInput('2026-11-25T08:00');
  const endsAt = parseManilaInput('2026-11-25T12:00');
  const evId = (await as(adminId, `
    insert into public.events(title, venue, starts_at, ends_at, status, created_by, certificates_enabled, certificate_template_id, organizing_office)
    values ('BiPSU AI & Cloud Summit', 'Main Auditorium', $1, $2, 'published', $3, true, $4, 'School of Engineering')
    returning id
  `, [startsAt, endsAt, adminId, tplRow.id]))[0].id;

  // Register user1 and user2
  const r1 = (await as(user1, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-20T09:00')]))[0].r;
  await as(user2, 'select public.register_for_event($1, $2) r', [evId, parseManilaInput('2026-11-20T09:05')]);

  // Check in user1 only
  await as(adminId, "select public.verify_attendance($1, $2, $3, 'scan', 'IN')", [
    r1.qr_token, evId, parseManilaInput('2026-11-25T08:15')
  ]);

  // 4. Event-not-ended block: user1 cannot get certificate before ends_at (12:00 PM)
  await fails(
    user1,
    'select public.issue_my_certificate($1, $2)',
    [evId, parseManilaInput('2026-11-25T11:30')],
    /Certificates become available after the event ends/i
  );

  // Unattended participant (user2) cannot get certificate even after event ends
  await fails(
    user2,
    'select public.issue_my_certificate($1, $2)',
    [evId, parseManilaInput('2026-11-25T13:00')],
    /No valid attendance record found/i
  );

  // 5. Participant corrects their profile name BEFORE first download -> uses corrected name
  const longCorrectedName = 'Maria Clara Concepcion Delos Santos-Montemayor';
  await as(user1, 'update public.profiles set full_name = $1 where id = $2', [longCorrectedName, user1]);

  const cert1 = (await as(user1, 'select public.issue_my_certificate($1, $2) r', [
    evId, parseManilaInput('2026-11-25T13:00')
  ]))[0].r;
  assert.match(cert1.certificate_code, /^CERT-2026-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  assert.equal(cert1.name_at_issuance, longCorrectedName);
  assert.equal(cert1.template_version, 1);

  // 6. Duplicate prevention: calling issue_my_certificate again returns the exact same certificate
  //    and profile name changes AFTER issuance do NOT alter the already-issued certificate
  await as(user1, "update public.profiles set full_name = 'Changed After Issuance' where id = $1", [user1]);
  const cert1Again = (await as(user1, 'select public.issue_my_certificate($1, $2) r', [
    evId, parseManilaInput('2026-11-25T14:00')
  ]))[0].r;
  assert.equal(cert1Again.id, cert1.id);
  assert.equal(cert1Again.certificate_code, cert1.certificate_code);
  assert.equal(cert1Again.name_at_issuance, longCorrectedName);

  // 7. Editing the template bumps version to 2 and does NOT change the issued certificate's snapshot
  const updatedTpl = (await as(adminId, `
    update public.certificate_templates
       set layout = '[
         {"type":"participant_name","x":100,"y":100,"width":1200,"height":80,"font":"sans","size":40,"color":"#000000","alignment":"left","auto_shrink":true},
         {"type":"certificate_id","x":700,"y":1255,"width":600,"height":32},
         {"type":"qr_code","x":1680,"y":1090,"width":180,"height":180}
       ]'::jsonb
     where id = $1
     returning version
  `, [tplRow.id]))[0];
  assert.equal(updatedTpl.version, 2);

  const storedCert = (await as(user1, 'select * from public.certificates where id = $1', [cert1.id]))[0];
  assert.equal(storedCert.template_version, 1);
  assert.equal(storedCert.layout_snapshot.fields[0].x, 250);

  // Blocking deletion of a template in use
  await fails(adminId, 'delete from public.certificate_templates where id = $1', [tplRow.id], /in use by existing events or certificates/i);

  // Turning off certificates_enabled on the event keeps already-issued certificates valid
  await as(adminId, 'update public.events set certificates_enabled = false where id = $1', [evId]);
  const stillValid = (await as(user1, 'select public.issue_my_certificate($1, $2) r', [
    evId, parseManilaInput('2026-11-25T15:00')
  ]))[0].r;
  assert.equal(stillValid.id, cert1.id);

  // 8. RLS: user2 cannot read user1's certificate, and nobody can insert directly into certificates
  const otherCerts = await as(user2, 'select id from public.certificates where id = $1', [cert1.id]);
  assert.equal(otherCerts.length, 0, 'participant cannot read another participant certificate');

  await fails(user1, `
    insert into public.certificates(certificate_code, user_id, event_id, layout_snapshot, name_at_issuance, event_name_at_issuance, event_date_at_issuance)
    values ('CERT-2026-FAKECODE', $1, $2, '{}'::jsonb, 'Fake', 'Fake', 'Nov 25, 2026')
  `, [user1, evId], /permission denied/i);

  // 9. Public verification RPC: valid -> revoked -> reissued (never exposes school_id, email, or program)
  const vValid = (await as(user2, 'select public.verify_certificate_code($1) r', [cert1.certificate_code]))[0].r;
  assert.equal(vValid.status, 'valid');
  assert.equal(vValid.participant_name, longCorrectedName);
  assert.equal(vValid.event_name, 'BiPSU AI & Cloud Summit');
  assert.equal(vValid.school_id, undefined);
  assert.equal(vValid.email, undefined);
  assert.equal(vValid.program, undefined);

  // Admin revokes certificate -> verify page shows 'revoked'
  await as(adminId, 'select public.admin_revoke_certificate($1, $2)', [cert1.id, 'Incorrect name reported']);
  const vRevoked = (await as(user2, 'select public.verify_certificate_code($1) r', [cert1.certificate_code]))[0].r;
  assert.equal(vRevoked.status, 'revoked');
  assert.equal(vRevoked.revoke_reason, 'Incorrect name reported');

  // Admin reissues certificate -> updates name_at_issuance to current profile name and restores status='valid'
  await as(adminId, 'select public.admin_reissue_certificate($1)', [cert1.id]);
  const vReissued = (await as(user2, 'select public.verify_certificate_code($1) r', [cert1.certificate_code]))[0].r;
  assert.equal(vReissued.status, 'valid');
  assert.equal(vReissued.participant_name, 'Changed After Issuance');

  // 10. Organizer-own-event rule: an organizer cannot get an attendee certificate for their own event
  await c.query("select set_config('eventsync.allow_role_change', '1', true)");
  await c.query("update public.profiles set role = 'organizer' where id = $1", [user2]);
  await c.query("select set_config('eventsync.allow_role_change', '0', true)");

  const orgEvId = (await as(user2, `
    insert into public.events(title, venue, starts_at, ends_at, status, created_by)
    values ('Organizer Hosted Workshop', 'Lab 1', $1, $2, 'published', $3)
    returning id
  `, [startsAt, endsAt, user2]))[0].id;

  await fails(
    user2,
    'select public.issue_my_certificate($1, $2)',
    [orgEvId, parseManilaInput('2026-11-25T15:00')],
    /Organizers cannot receive an attendee certificate for their own event/i
  );
});
