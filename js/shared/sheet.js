// Attendance-sheet model + CSV / Excel generators. Pure (no DOM, no network) so it can be unit-tested in Node.
// The data comes from the admin-only RPC attendance_sheet(); totals are computed by the database.
import { formatProgramShort } from '../../config/programs.js';
import { isLateCheckIn } from '../../config/schedule.js';

export const TZ = 'Asia/Manila';
export const COLUMNS = ['No.', 'Full Name', 'School ID', 'Program (Major) / Year', 'Role', 'Time In', 'Attendance'];
const clean = s => s.replace(/[\u202f\u00a0]/g, ' ');

export const fmtDateTime = d => d ? clean(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d))) : '-';
export const fmtTime = d => d ? clean(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(d))) : '-';
export const fmtDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));   // YYYY-MM-DD

const ROLE = { student: 'Student', faculty: 'Faculty', staff: 'Staff' };

export const attendanceRate = (registered, present) => registered > 0 ? Math.round(present / registered * 100) : 0;   // never divides by zero

/** data = result of rpc('attendance_sheet') */
export function buildSheetModel(data, generatedAt = new Date()) {
  const t = data.totals, ev = data.event;
  const isEnded = ev.attendance_state ? ev.attendance_state === 'ENDED' : true;
  const header = [['Event', ev.title], ['Starts', fmtDateTime(ev.starts_at)], ['Ends', fmtDateTime(ev.ends_at)], ['Venue', ev.venue || '-'], ['Generated', fmtDateTime(generatedAt)]];
  if (data.filter === 'present') header.push(['Showing', 'Present only']);
  if (data.include_test) header.push(['Test records', 'Included']);

  const bySchool = new Map();
  for (const r of data.rows) {
    const sc = r.department || 'Unspecified';
    const cur = bySchool.get(sc) || { reg: 0, pres: 0, abs: 0 };
    cur.reg += 1;
    if (r.present) cur.pres += 1;
    else if (isEnded) cur.abs += 1;
    bySchool.set(sc, cur);
  }
  const schoolBreakdown = [...bySchool.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sc, v]) => [sc, v.reg, v.pres, v.abs]);

  const lateCount = t.late ?? data.rows.filter(r => r.present && (r.is_late || isLateCheckIn(ev, r.time_in))).length;
  const totals = [
    ['Total Registered', t.registered],
    ['Total Present', t.present],
    ['Total Late', lateCount],
    ['Total Absent', isEnded ? t.absent : 0]
  ];
  if (!isEnded && (t.pending ?? (t.registered - t.present)) > 0) {
    totals.push(['Total Pending', t.pending ?? (t.registered - t.present)]);
  }
  totals.push(['Attendance Rate', attendanceRate(t.registered, t.present) + '%']);

  return {
    title: 'EVENT ATTENDANCE SHEET', header, columns: COLUMNS,
    rows: data.rows.map((r, i) => {
      const late = r.present && (r.is_late || isLateCheckIn(ev, r.time_in));
      const baseStatus = r.status_label || (r.present ? (late ? 'Present (Late)' : 'Present') : (isEnded ? 'Absent' : 'Pending'));
      const status = r.present && r.is_test ? `${baseStatus} (Test)` : baseStatus;
      return [i + 1, r.full_name, r.school_id || '-', formatProgramShort(r), ROLE[r.member_type] || '-', r.present ? fmtTime(r.time_in) : '-', status];
    }),
    totals,
    schoolBreakdown,
    signatures: ['Prepared by: ______________________', 'Verified by: ______________________'],
    eventTitle: ev.title, eventStart: ev.starts_at, generatedAt
  };
}

/* ---------------- CSV ---------------- */
const q = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const line = a => a.map(q).join(',');

export function toCsv(m) {
  const lines = [line([m.title]), ...m.header.map(h => line(h)), '', line(m.columns), ...m.rows.map(line), '', ...m.totals.map(t => line(t)), '', line([m.signatures[0], '', '', m.signatures[1]])];
  return '\ufeff' + lines.join('\r\n') + '\r\n';       // UTF-8 BOM so Excel reads accents/Ñ correctly
}

/* ---------------- Excel (.xlsx) via ExcelJS ---------------- */
const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const MIN_W = [6, 24, 14, 26, 10, 10, 12];
const MAX_NAME_W = 60;

export function columnWidths(m) {
  const w = m.columns.map((c, i) => {
    const longest = Math.max(String(c).length, ...m.rows.map(r => String(r[i]).length));
    const cap = i === 1 ? MAX_NAME_W : i === 3 ? 52 : 40;
    return Math.max(MIN_W[i], Math.min(longest + 3, cap));
  });
  // header-block values live in merged C:G; widen D if they would not fit
  const need = Math.max(...m.header.map(h => String(h[1]).length)) + 3;
  const have = w.slice(2).reduce((a, b) => a + b, 0);
  if (have < need) w[3] += need - have;
  return w;
}

export function buildWorkbook(ExcelJS, m) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'EventSync'; wb.created = m.generatedAt;
  const ws = wb.addWorksheet('Attendance', { views: [], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .5, right: .5, top: .6, bottom: .6, header: .3, footer: .3 } } });
  const widths = columnWidths(m); widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const last = m.columns.length;                                            // 7

  let r = 1;
  ws.mergeCells(r, 1, r, last); const t = ws.getCell(r, 1);
  t.value = m.title; t.font = { bold: true, size: 16 }; t.alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(r).height = 28;
  r += 2;                                                                  // blank row
  for (const [label, value] of m.header) {
    ws.mergeCells(r, 1, r, 2); ws.mergeCells(r, 3, r, last);
    const a = ws.getCell(r, 1), b = ws.getCell(r, 3);
    a.value = label + ':'; a.font = { bold: true }; b.value = value; b.alignment = { horizontal: 'left' };
    r++;
  }
  r++;                                                                     // blank row
  const headerRow = r;
  m.columns.forEach((c, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = c; cell.font = { bold: true }; cell.border = BORDER;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E9F5' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  r++;
  for (const row of m.rows) {
    row.forEach((v, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = v; cell.border = BORDER;
      cell.alignment = { vertical: 'middle', horizontal: [0, 5, 6].includes(i) ? 'center' : 'left', wrapText: i === 1 };
    });
    r++;
  }
  r++;                                                                     // blank row
  for (const [label, value] of m.totals) {
    ws.mergeCells(r, 1, r, 2);
    const a = ws.getCell(r, 1), b = ws.getCell(r, 3);
    a.value = label + ':'; a.font = { bold: true }; b.value = value; b.alignment = { horizontal: 'left' }; b.font = { bold: true };
    r++;
  }
  if (m.schoolBreakdown?.length) {
    r++;
    ws.mergeCells(r, 1, r, 4);
    const sh = ws.getCell(r, 1); sh.value = 'Attendance by School / Office'; sh.font = { bold: true };
    r++;
    ['School / Office', 'Registered', 'Present', 'Absent'].forEach((h, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = h; c.font = { bold: true }; c.border = BORDER;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E9F5' } };
    });
    r++;
    for (const row of m.schoolBreakdown) {
      row.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; c.border = BORDER; });
      r++;
    }
  }
  r += 2;
  ws.mergeCells(r, 1, r, 3); ws.mergeCells(r, 4, r, last);
  ws.getCell(r, 1).value = m.signatures[0]; ws.getCell(r, 4).value = m.signatures[1];

  ws.views = [{ state: 'frozen', ySplit: headerRow, topLeftCell: `A${headerRow + 1}` }];     // header row stays visible while scrolling
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;                                    // repeated on every printed page
  ws.headerFooter.oddFooter = '&CPage &P of &N';
  return { workbook: wb, headerRow };
}

/* ---------------- Summary of all events ---------------- */
export const SUMMARY_COLUMNS = ['Event', 'Starts', 'Ends', 'Venue', 'Registered', 'Present', 'Absent', 'Attendance Rate'];
export function buildSummaryModel(stats, generatedAt = new Date()) {
  return {
    title: 'SUMMARY OF ALL EVENTS', generatedAt, columns: SUMMARY_COLUMNS,
    header: [['Generated', fmtDateTime(generatedAt)]],
    rows: stats.map(e => { const reg = e.registered_count, att = e.attended_count; return [e.title, fmtDateTime(e.starts_at), fmtDateTime(e.ends_at), e.venue || '-', reg, att, Math.max(reg - att, 0), attendanceRate(reg, att) + '%']; })
  };
}
export function summaryWorkbook(ExcelJS, m) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'EventSync';
  const ws = wb.addWorksheet('Summary', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const n = m.columns.length;
  m.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(Math.max(String(c).length, ...m.rows.map(r => String(r[i]).length)) + 3, 45); });
  ws.mergeCells(1, 1, 1, n); Object.assign(ws.getCell(1, 1), { value: m.title }); ws.getCell(1, 1).font = { bold: true, size: 16 }; ws.getCell(1, 1).alignment = { horizontal: 'center' };
  ws.getCell(3, 1).value = 'Generated:'; ws.getCell(3, 1).font = { bold: true }; ws.getCell(3, 2).value = m.header[0][1];
  const hr = 5;
  m.columns.forEach((c, i) => { const cell = ws.getCell(hr, i + 1); cell.value = c; cell.font = { bold: true }; cell.border = BORDER; cell.alignment = { horizontal: 'center' }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E9F5' } }; });
  m.rows.forEach((row, ri) => row.forEach((v, i) => { const cell = ws.getCell(hr + 1 + ri, i + 1); cell.value = v; cell.border = BORDER; }));
  ws.views = [{ state: 'frozen', ySplit: hr }]; ws.pageSetup.printTitlesRow = `${hr}:${hr}`;
  return wb;
}

/* ---------------- printable HTML (PDF + Print) ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderPrintHtml(m) {
  return `<div class="sheet">
    <div class="print-brand"><img src="/assets/logo.png" alt="EventSync logo" width="48" height="32"><b>EventSync</b></div>
    <h1 class="sheet-title">${esc(m.title)}</h1>
    <table class="sheet-head">${m.header.map(([k, v]) => `<tr><th>${esc(k)}:</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <table class="sheet-table"><thead><tr>${m.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${m.rows.map(r => `<tr>${r.map((v, i) => `<td class="${[0, 5, 6].includes(i) ? 'c' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${m.columns.length}" class="c">No attendees</td></tr>`}</tbody></table>
    <div class="sheet-totals">${m.totals.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')}</div>
    ${m.schoolBreakdown?.length ? `<h3 style="margin:.9rem 0 .4rem;font-size:.95rem">Attendance by School / Office</h3>
      <table class="sheet-table"><thead><tr><th>School / Office</th><th>Registered</th><th>Present</th><th>Absent</th></tr></thead>
      <tbody>${m.schoolBreakdown.map(([sc, reg, pres, abs]) => `<tr><td>${esc(sc)}</td><td class="c">${reg}</td><td class="c">${pres}</td><td class="c">${abs}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="sheet-sign"><span>${esc(m.signatures[0])}</span><span>${esc(m.signatures[1])}</span></div></div>`;
}
