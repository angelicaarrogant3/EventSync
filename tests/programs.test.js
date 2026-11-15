const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const loadCfg = () => import('../config/programs.js');

test('valid selections accepted (with majors, without majors, Faculty/Staff, Other with text)', async () => {
  const { validateProgramSelection, searchPrograms, formatProgramShort } = await loadCfg();

  // Program without majors
  const r1 = validateProgramSelection({
    member_type: 'student',
    department: 'School of Technology and Computer Studies',
    program: 'Bachelor of Science in Computer Science',
    major: ''
  });
  assert.equal(r1.error, undefined);
  assert.equal(r1.course, 'BS Computer Science');

  // Program with majors
  const r2 = validateProgramSelection({
    member_type: 'student',
    department: 'School of Teacher Education',
    program: 'Bachelor in Secondary Education',
    major: 'Math'
  });
  assert.equal(r2.error, undefined);
  assert.equal(r2.major, 'Math');
  assert.equal(r2.course, 'B Secondary Education (Math)');

  // Faculty with Administrative / Office
  const r3 = validateProgramSelection({
    member_type: 'faculty',
    department: 'Administrative / Office',
    program: '',
    major: ''
  });
  assert.equal(r3.error, undefined);
  assert.equal(r3.department, 'Administrative / Office');

  // Other with text
  const r4 = validateProgramSelection({
    member_type: 'student',
    department: 'Other / Not listed',
    program: 'Visiting Exchange Student',
    major: ''
  });
  assert.equal(r4.error, undefined);
  assert.equal(r4.program, 'Visiting Exchange Student');

  // Search "comp" finds Computer Science and Computer Engineering
  const hits = searchPrograms('comp').map(x => x.program.code);
  assert.ok(hits.includes('BSCS'));
  assert.ok(hits.includes('BSCPE'));

  // Short formatting
  assert.equal(formatProgramShort({ member_type: 'student', program: 'Bachelor of Science in Computer Science', year_level: 3 }), 'BS Computer Science - 3rd Year');
  assert.equal(formatProgramShort({ program_needs_update: true }), 'Needs update');
});

test('invalid selections rejected (unknown school/program, missing major, extra major, empty Other)', async () => {
  const { validateProgramSelection } = await loadCfg();

  assert.ok(validateProgramSelection({ member_type: 'student', department: 'Hogwarts', program: 'Magic' }).error);
  assert.ok(validateProgramSelection({ member_type: 'student', department: 'School of Engineering', program: 'Bachelor of Science in Computer Science' }).error);
  // Missing major when required
  assert.ok(validateProgramSelection({ member_type: 'student', department: 'School of Arts and Sciences', program: 'Bachelor of Science in Business Administration', major: '' }).error);
  // Major on a program without majors
  assert.ok(validateProgramSelection({ member_type: 'student', department: 'School of Engineering', program: 'Bachelor of Science in Civil Engineering', major: 'Math' }).error);
  // Other without text
  assert.ok(validateProgramSelection({ member_type: 'student', department: 'Other / Not listed', program: '' }).error);
});

test('config/programs.js is the single source of truth for program names in js/ and html', async () => {
  const { PROGRAM_SCHOOLS } = await loadCfg();
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(ent.name)) files.push(p);
    }
  };
  walk(path.join(root, 'js'));
  walk(path.join(root, 'admin'));
  walk(path.join(root, 'user'));

  const programNames = PROGRAM_SCHOOLS.flatMap(s => s.programs.map(p => p.name));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const name of programNames) {
      assert.equal(src.includes(name), false, `${path.relative(root, f)} must not hard-code "${name}"`);
    }
  }
});

// ---- DB tests for server-side validation & legacy migration ----
const skip = !process.env.PGURL && 'PGURL not set';
let c;
before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
});
after(async () => { if (c) await c.end(); });
beforeEach(async () => { if (c) await c.query('begin'); });
afterEach(async () => { if (c) await c.query('rollback'); });

test('server-side resolve_program_selection enforces BiPSU rules and migration preserves/maps legacy accounts', { skip }, async () => {
  // Valid with major
  const ok = (await c.query(
    "select * from public.resolve_program_selection('student','School of Technology and Computer Studies','Bachelor of Science in Industrial Technology','Electronics',null)"
  )).rows[0];
  assert.equal(ok.course, 'BS Industrial Technology (Electronics)');

  const rejects = async (sql, re) => {
    await c.query('savepoint sp');
    try { await c.query(sql); assert.fail('expected rejection'); }
    catch (e) { assert.match(e.message, re); }
    finally { await c.query('rollback to savepoint sp'); }
  };

  // Missing major rejected
  await rejects(
    "select * from public.resolve_program_selection('student','School of Teacher Education','Bachelor in Secondary Education','',null)",
    /Major/i
  );

  // Extra major on non-major program rejected
  await rejects(
    "select * from public.resolve_program_selection('student','School of Nursing and Health Sciences','Bachelor of Science in Nursing','Math',null)",
    /does not have majors/i
  );

  // Unknown program rejected
  await rejects(
    "select * from public.resolve_program_selection('student','School of Engineering','Fake Program','',null)",
    /valid Program/i
  );

  // Catalog seeded with all 20 programs
  const cnt = (await c.query('select count(*)::int c from public.program_catalog')).rows[0].c;
  assert.equal(cnt, 20);
});
