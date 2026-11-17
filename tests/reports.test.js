// Tests for the redesigned per-event attendance sheet (model, CSV, Excel .xlsx, and DB RPC).
//   $env:PGURL = '<postgres connection string>' ; npm test
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Client } = require('pg');

let S;
const load = async () => (S ||= await import('../js/shared/sheet.js'));

const sampleData = (overrides = {}) => ({
  event: {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Laag, Annual Meetup',
    starts_at: '2026-11-14T12:41:00.000Z',   // 8:41 PM Asia/Manila
    ends_at: '2026-11-14T15:41:00.000Z',     // 11:41 PM Asia/Manila
    venue: 'Ila Apple, Hall B'
  },
  filter: 'all',
  rows: [
    { full_name: 'Angeline Gwapa', school_id: '2023-001', department: 'School of Technology and Computer Studies', program: 'Bachelor of Science in Computer Science', major: null, year_level: 3, member_type: 'student', time_in: '2026-11-14T12:52:00.000Z', present: true },
    { full_name: 'Maria Clara De Los Santos-Villanueva Jr.', school_id: '2023-002', department: 'School of Engineering', program: 'Bachelor of Science in Civil Engineering', major: null, year_level: 4, member_type: 'student', time_in: null, present: false }
  ],
  totals: { registered: 2, present: 1, absent: 1 },
  ...overrides
});

test('sheet model: Asia/Manila dates, no status in header, 0% on zero registrations', async () => {
  const { buildSheetModel, attendanceRate } = await load();
  assert.equal(attendanceRate(0, 0), 0);
  assert.equal(attendanceRate(3, 2), 67);

  const m = buildSheetModel(sampleData(), new Date('2026-11-14T13:06:00.000Z'));
  assert.equal(m.title, 'EVENT ATTENDANCE SHEET');
  assert.ok(!m.header.some(([k]) => /status/i.test(k)), 'must not include event status');
  assert.equal(m.header.find(([k]) => k === 'Starts')[1], 'Nov 14, 2026, 8:41 PM');
  assert.equal(m.header.find(([k]) => k === 'Ends')[1], 'Nov 14, 2026, 11:41 PM');
  assert.equal(m.rows.length, 2);
  assert.equal(m.rows[0][5], '8:52 PM');
  assert.equal(m.rows[0][6], '-');
  assert.equal(m.rows[0][7], 'Present');
  assert.equal(m.rows[1][5], '-');
  assert.equal(m.rows[1][6], '-');
  assert.equal(m.rows[1][7], 'Absent');
  assert.deepEqual(m.totals, [
    ['Total Registered', 2], ['Total Present', 1], ['Total Late', 0], ['Total Timed Out', 0], ['Total Absent', 1], ['Attendance Rate', '50%']
  ]);

  const empty = buildSheetModel(sampleData({ rows: [], totals: { registered: 0, present: 0, absent: 0 } }));
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.totals.find(([k]) => k === 'Attendance Rate')[1], '0%');
});

test('CSV export: UTF-8 BOM, sections in order, quotes fields with commas', async () => {
  const { buildSheetModel, toCsv } = await load();
  const csv = toCsv(buildSheetModel(sampleData()));
  assert.ok(csv.startsWith('\ufeffEVENT ATTENDANCE SHEET'), 'must start with UTF-8 BOM + title');
  assert.ok(csv.includes('"Laag, Annual Meetup"'), 'event title with comma is quoted');
  assert.ok(csv.includes('"Ila Apple, Hall B"'), 'venue with comma is quoted');
  assert.ok(csv.includes('No.,Full Name,School ID,Program (Major) / Year,Role,Time In,Time Out,Attendance'));
  assert.ok(csv.includes('Total Registered,2'));
  assert.ok(csv.includes('Prepared by:'));
});

test('Excel (.xlsx): merged centered title, column widths fit long names/dates, borders, freeze & A4 landscape', async () => {
  const { buildSheetModel, buildWorkbook } = await load();
  const longName = 'Alexandria Constantino-Magtanggol de la Cruz III';
  const data = sampleData({
    rows: [
      { full_name: longName, school_id: '2024-00999', department: 'School of Nursing and Health Sciences', program: 'Bachelor of Science in Nursing', major: null, year_level: 2, member_type: 'student', time_in: '2026-11-14T12:52:00.000Z', present: true }
    ],
    totals: { registered: 1, present: 1, absent: 0 }
  });
  const m = buildSheetModel(data, new Date('2026-11-14T13:06:00.000Z'));
  const { workbook, headerRow } = buildWorkbook(ExcelJS, m);

  const buf = await workbook.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const ws = wb2.getWorksheet('Attendance');
  assert.ok(ws, 'Attendance worksheet exists');
  assert.equal(ws.getCell(1, 1).value, 'EVENT ATTENDANCE SHEET');
  assert.equal(ws.getCell(1, 1).alignment.horizontal, 'center');
  assert.equal(ws.getCell(1, 1).font.bold, true);
  assert.ok(ws.getColumn(2).width >= longName.length, `name column width (${ws.getColumn(2).width}) >= long name (${longName.length})`);
  assert.ok(ws.getCell(headerRow, 1).font.bold, 'table header row is bold');
  assert.ok(ws.getCell(headerRow, 1).border.top.style, 'table header has borders');
  assert.equal(ws.views[0].state, 'frozen');
  assert.equal(ws.views[0].ySplit, headerRow);
  assert.equal(ws.pageSetup.paperSize, 9);
  assert.equal(ws.pageSetup.orientation, 'landscape');
  assert.equal(ws.pageSetup.printTitlesRow, `${headerRow}:${headerRow}`);
});

/* ---------------- DB RPC tests ---------------- */
const skip = !process.env.PGURL && 'PGURL not set';
let c, adminId, users = [];

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role='admin' limit 1")).rows[0]?.id;
  users = (await c.query("select id from public.profiles where role='user' order by created_at limit 2")).rows.map(r => r.id);
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

test('DB attendance_sheet: totals match registered/present/absent, Present-only filter, zero-reg, admin-only, logged', { skip }, async t => {
  if (!adminId || users.length < 2) return t.skip('need 1 admin and 2 users');

  const ev = (await c.query(
    `insert into public.events(title,venue,starts_at,ends_at,capacity,status)
     values ('SHEET TEST','Main Hall',now()+interval '30 minutes',now()+interval '2 hours',10,'published') returning id`
  )).rows[0].id;

  // zero-registration event
  const empty = (await as(adminId, "select public.attendance_sheet($1, 'all', null) d", [ev]))[0].d;
  assert.equal(empty.rows.length, 0);
  assert.deepEqual(empty.totals, { registered: 0, present: 0, late: 0, timed_out: 0, absent: 0, pending: 0 });

  // register 2 users, check in 1 (inside 60m grace window)
  const r1 = (await as(users[0], 'select public.register_for_event($1) r', [ev]))[0].r;
  await as(users[1], 'select public.register_for_event($1) r', [ev]);
  await as(adminId, 'select public.verify_attendance($1)', [r1.qr_token]);

  // While ongoing, un-checked-in person is Pending (not Absent)
  const all = (await as(adminId, "select public.attendance_sheet($1, 'all', 'xlsx') d", [ev]))[0].d;
  assert.equal(all.rows.length, all.totals.registered);
  assert.deepEqual(all.totals, { registered: 2, present: 1, late: 0, timed_out: 0, absent: 0, pending: 1 });

  // After event ends, un-checked-in person is Absent
  const ended = (await as(adminId, "select public.attendance_sheet($1, 'all', null, false, now()+interval '4 hours') d", [ev]))[0].d;
  assert.deepEqual(ended.totals, { registered: 2, present: 1, late: 0, timed_out: 0, absent: 1, pending: 0 });

  const presentOnly = (await as(adminId, "select public.attendance_sheet($1, 'present', 'csv', false, now()+interval '4 hours') d", [ev]))[0].d;
  assert.equal(presentOnly.rows.length, 1);
  assert.equal(presentOnly.rows[0].present, true);
  assert.deepEqual(presentOnly.totals, { registered: 2, present: 1, late: 0, timed_out: 0, absent: 1, pending: 0 });

  // exports were logged
  const logs = (await c.query("select details from public.activity_logs where action='report.exported' and entity_id=$1 order by id", [ev])).rows;
  assert.equal(logs.length, 2);
  assert.equal(logs[0].details.format, 'xlsx');
  assert.equal(logs[1].details.format, 'csv');

  // non-admin cannot export
  await c.query('savepoint s');
  await assert.rejects(as(users[0], "select public.attendance_sheet($1, 'all', 'xlsx')", [ev]), /Only administrators/);
  await c.query('rollback to savepoint s');
});
