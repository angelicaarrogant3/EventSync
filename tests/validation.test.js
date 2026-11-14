// Client-side validation rules (pure functions). The same rules are enforced again by the database (see signup.db.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

let V;
const load = async () => (V ||= await import('../js/shared/validation.js'));
const good = () => ({
  full_name: 'Juan Dela Cruz', school_id: '2024-00123', email: 'juan@school.edu.ph', contact_number: '09171234567',
  member_type: 'student', course: 'BSIT', year_level: '2', section: 'A', password: 'Secret123', confirm_password: 'Secret123', consent: true
});

test('valid signup passes', async () => {
  const { validateParticipant } = await load();
  assert.deepEqual(validateParticipant(good()), {});
});

test('contact number: 09XXXXXXXXX and +639XXXXXXXXX accepted, others rejected, empty allowed', async () => {
  const { validateParticipant } = await load();
  for (const ok of ['09171234567', '+639171234567', '']) assert.equal(validateParticipant({ ...good(), contact_number: ok }).contact_number, undefined, ok);
  for (const bad of ['0917123456', '08171234567', '+649171234567', '0917-123-4567', 'abc']) assert.ok(validateParticipant({ ...good(), contact_number: bad }).contact_number, bad);
});

test('weak password: too short / no letter / no number rejected', async () => {
  const { validateParticipant } = await load();
  for (const pw of ['Ab1', 'Abcdef1', '12345678', 'abcdefgh']) {
    assert.ok(validateParticipant({ ...good(), password: pw, confirm_password: pw }).password, pw);
  }
  assert.equal(validateParticipant({ ...good(), password: 'Abcdefg1', confirm_password: 'Abcdefg1' }).password, undefined);
});

test('mismatched confirm password rejected', async () => {
  const { validateParticipant } = await load();
  assert.ok(validateParticipant({ ...good(), confirm_password: 'Different123' }).confirm_password);
});

test('missing required fields are all reported', async () => {
  const { validateParticipant } = await load();
  const e = validateParticipant({ contact_number: '', section: '', password: '', confirm_password: '' });
  for (const k of ['full_name', 'school_id', 'email', 'member_type', 'course', 'password', 'consent']) assert.ok(e[k], k + ' should be required');
  assert.ok(validateParticipant({ ...good(), consent: false }).consent, 'consent is required');
});

test('year level is required for students only', async () => {
  const { validateParticipant } = await load();
  assert.ok(validateParticipant({ ...good(), year_level: '' }).year_level);
  assert.equal(validateParticipant({ ...good(), member_type: 'faculty', year_level: '' }).year_level, undefined);
  assert.ok(validateParticipant({ ...good(), year_level: '5' }).year_level);
});

test('email format and school ID format', async () => {
  const { validateParticipant } = await load();
  assert.ok(validateParticipant({ ...good(), email: 'not-an-email' }).email);
  assert.ok(validateParticipant({ ...good(), school_id: 'ab' }).school_id);
  assert.ok(validateParticipant({ ...good(), school_id: 'has space' }).school_id);
});

test('the form never sends a role field to the server', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'signup.js'), 'utf8');
  assert.doesNotMatch(src, /\brole\s*:/, 'signup.js must not submit a role');
});
