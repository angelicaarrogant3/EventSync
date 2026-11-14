const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { query } = require('../db/connection');
const { getEventById, listEvents } = require('./events.service');

/**
 * Fetch raw attendance report dataset for an event.
 * Participants are only marked ABSENT once the event is COMPLETED (or ENDED);
 * before completion, unchecked-in registrants are marked PENDING.
 */
async function getEventReportData(eventId) {
  const event = await getEventById(eventId);
  if (!event) return null;

  const isCompleted = ['COMPLETED', 'ENDED'].includes(event.status);
  const unvisitedLabel = isCompleted ? 'ABSENT' : 'PENDING';

  const attendees = await query.all(
    `SELECT
      p.school_id,
      p.full_name,
      p.email,
      p.contact_number,
      p.department_or_course,
      p.year_level,
      p.role,
      r.registered_at,
      r.registered_by_node,
      r.registered_by_user_id,
      a.id AS attendance_id,
      a.checked_in_at,
      a.scanned_by_node,
      a.verified_by_user_id,
      a.was_offline_sync,
      CASE WHEN a.id IS NOT NULL THEN 'PRESENT' ELSE ? END AS status
    FROM registrations r
    JOIN participants p ON r.participant_id = p.id
    LEFT JOIN attendance a ON r.id = a.registration_id
    WHERE r.event_id = ? AND r.status = 'REGISTERED'
    ORDER BY CASE WHEN a.id IS NOT NULL THEN 0 ELSE 1 END ASC, a.checked_in_at ASC, p.full_name ASC`,
    [unvisitedLabel, eventId]
  );

  const presentCount = attendees.filter(a => a.status === 'PRESENT').length;
  const absentCount = isCompleted ? attendees.filter(a => a.status === 'ABSENT').length : 0;
  const pendingCount = !isCompleted ? attendees.filter(a => a.status === 'PENDING').length : 0;
  const attendanceRate = attendees.length > 0
    ? Math.round((presentCount / attendees.length) * 1000) / 10
    : 0;

  return {
    event,
    summary: {
      capacity: event.capacity,
      totalRegistered: attendees.length,
      totalPresent: presentCount,
      totalAbsent: absentCount,
      totalPending: pendingCount,
      attendanceRate,
      isCompleted
    },
    attendees
  };
}

/**
 * Aggregate summary across events (with optional date range) matching dashboard totals
 */
async function getSummaryReport({ fromDate = null, toDate = null } = {}) {
  const allEvents = await listEvents(null, false);
  const filtered = allEvents.filter(ev => {
    if (fromDate && ev.event_date < fromDate) return false;
    if (toDate && ev.event_date > toDate) return false;
    return true;
  });

  let totalCapacity = 0;
  let totalRegistered = 0;
  let totalPresent = 0;
  let totalAbsent = 0;

  const events = filtered.map(ev => {
    const isCompleted = ['COMPLETED', 'ENDED'].includes(ev.status);
    const reg = ev.registered_count || 0;
    const pres = ev.checked_in_count || 0;
    const abs = isCompleted ? Math.max(0, reg - pres) : 0;
    const rate = reg > 0 ? Math.round((pres / reg) * 1000) / 10 : 0;

    totalCapacity += ev.capacity || 0;
    totalRegistered += reg;
    totalPresent += pres;
    totalAbsent += abs;

    return {
      id: ev.id,
      title: ev.title,
      category: ev.category || 'General',
      venue: ev.venue,
      event_date: ev.event_date,
      start_time: ev.start_time,
      end_time: ev.end_time,
      status: ev.status,
      capacity: ev.capacity,
      registered: reg,
      present: pres,
      absent: abs,
      attendanceRate: rate
    };
  });

  const overallAttendanceRate = totalRegistered > 0
    ? Math.round((totalPresent / totalRegistered) * 1000) / 10
    : 0;

  return {
    totals: {
      totalEvents: events.length,
      totalCapacity,
      totalRegistered,
      totalPresent,
      totalAbsent,
      overallAttendanceRate
    },
    events
  };
}

/**
 * Generate CSV Report string with UTF-8 BOM
 */
async function generateCsvReport(eventId) {
  const data = await getEventReportData(eventId);
  if (!data) return null;

  const headers = [
    'School ID',
    'Full Name',
    'Email',
    'Department / Course',
    'Year Level',
    'Role',
    'Attendance Status',
    'Check-in Time',
    'Scanned By Node',
    'Sync Mode',
    'Registered At',
    'Registered By Node'
  ];

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = [headers.join(',')];

  for (const item of data.attendees) {
    const syncMode = item.status === 'PRESENT'
      ? (item.was_offline_sync ? 'OFFLINE_SYNC' : 'REALTIME')
      : 'N/A';

    rows.push([
      escapeCsv(item.school_id),
      escapeCsv(item.full_name),
      escapeCsv(item.email),
      escapeCsv(item.department_or_course),
      escapeCsv(item.year_level),
      escapeCsv(item.role),
      escapeCsv(item.status),
      escapeCsv(item.checked_in_at || 'N/A'),
      escapeCsv(item.scanned_by_node || 'N/A'),
      escapeCsv(syncMode),
      escapeCsv(item.registered_at),
      escapeCsv(item.registered_by_node)
    ].join(','));
  }

  return '\uFEFF' + rows.join('\r\n');
}

/**
 * Generate Excel (.xlsx) Buffer using SheetJS
 */
async function generateXlsxReport(eventId) {
  const data = await getEventReportData(eventId);
  if (!data) return null;

  const wb = XLSX.utils.book_new();

  const summaryRows = [
    ['EventSync Attendance Report'],
    ['Event Title', data.event.title],
    ['Category', data.event.category || 'General'],
    ['Venue', data.event.venue],
    ['Date', data.event.event_date],
    ['Time', `${data.event.start_time} - ${data.event.end_time}`],
    ['Status', data.event.status],
    ['Capacity', data.summary.capacity],
    ['Total Registered', data.summary.totalRegistered],
    ['Total Present', data.summary.totalPresent],
    ['Total Absent', data.summary.totalAbsent],
    ['Attendance Rate (%)', data.summary.attendanceRate]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  const attendeeRows = data.attendees.map(item => ({
    'School ID': item.school_id,
    'Full Name': item.full_name,
    'Email': item.email,
    'Department / Course': item.department_or_course,
    'Year Level': item.year_level,
    'Role': item.role,
    'Attendance Status': item.status,
    'Check-in Time': item.checked_in_at || '',
    'Scanned By Node': item.scanned_by_node || '',
    'Sync Mode': item.status === 'PRESENT' ? (item.was_offline_sync ? 'OFFLINE_SYNC' : 'REALTIME') : '',
    'Registered At': item.registered_at
  }));
  const rosterSheet = XLSX.utils.json_to_sheet(attendeeRows);
  XLSX.utils.book_append_sheet(wb, rosterSheet, 'Attendees');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Stream formatted PDF Report using pdfkit
 */
async function streamPdfReport(eventId, writableStream) {
  const data = await getEventReportData(eventId);
  if (!data) return false;

  const doc = new PDFDocument({
    margin: 40,
    size: 'A4',
    info: {
      Title: `EventSync Attendance Report - ${data.event.title}`,
      Author: 'EventSync Attendance System',
      Subject: 'Official Attendance Report'
    }
  });

  doc.pipe(writableStream);

  const primaryColor = '#1e3a8a';
  const secondaryColor = '#475569';

  doc.fillColor(primaryColor)
    .fontSize(22)
    .font('Helvetica-Bold')
    .text('EventSync Attendance Report', 40, 40);

  doc.fillColor(secondaryColor)
    .fontSize(10)
    .font('Helvetica')
    .text(`Generated on ${new Date().toLocaleString()}`, 40, 68);

  doc.moveTo(40, 85).lineTo(555, 85).strokeColor('#cbd5e1').stroke();

  doc.rect(40, 95, 515, 65).fillAndStroke('#f8fafc', '#e2e8f0');
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(14).text(data.event.title, 50, 105);
  doc.fillColor(secondaryColor).font('Helvetica').fontSize(9)
    .text(`Venue: ${data.event.venue}   |   Date: ${data.event.event_date}   |   Time: ${data.event.start_time} - ${data.event.end_time}`, 50, 125)
    .text(`Status: ${data.event.status}   |   Total Capacity: ${data.event.capacity} seats`, 50, 140);

  const boxY = 170;
  const boxWidth = 120;
  const boxHeight = 50;

  doc.rect(40, boxY, boxWidth, boxHeight).fillAndStroke('#eff6ff', '#bfdbfe');
  doc.fillColor('#1e40af').font('Helvetica-Bold').fontSize(18).text(String(data.summary.totalRegistered), 50, boxY + 10);
  doc.fillColor('#3b82f6').font('Helvetica').fontSize(9).text('TOTAL REGISTERED', 50, boxY + 32);

  doc.rect(170, boxY, boxWidth, boxHeight).fillAndStroke('#ecfdf5', '#a7f3d0');
  doc.fillColor('#065f46').font('Helvetica-Bold').fontSize(18).text(String(data.summary.totalPresent), 180, boxY + 10);
  doc.fillColor('#10b981').font('Helvetica').fontSize(9).text('PRESENT', 180, boxY + 32);

  doc.rect(300, boxY, boxWidth, boxHeight).fillAndStroke('#fff1f2', '#fecdd3');
  doc.fillColor('#9f1239').font('Helvetica-Bold').fontSize(18).text(String(data.summary.totalAbsent), 310, boxY + 10);
  doc.fillColor('#f43f5e').font('Helvetica').fontSize(9).text(data.summary.isCompleted ? 'ABSENT' : 'PENDING', 310, boxY + 32);

  doc.rect(435, boxY, boxWidth, boxHeight).fillAndStroke('#f5f3ff', '#ddd6fe');
  doc.fillColor('#5b21b6').font('Helvetica-Bold').fontSize(18).text(`${data.summary.attendanceRate}%`, 445, boxY + 10);
  doc.fillColor('#8b5cf6').font('Helvetica').fontSize(9).text('ATTENDANCE RATE', 445, boxY + 32);

  let tableY = 240;
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(12).text('Participant Attendance Roster', 40, tableY);
  tableY += 18;

  const drawHeader = () => {
    doc.rect(40, tableY, 515, 20).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    doc.text('School ID', 45, tableY + 6, { width: 65 });
    doc.text('Full Name', 115, tableY + 6, { width: 110 });
    doc.text('Department / Course', 230, tableY + 6, { width: 110 });
    doc.text('Role', 345, tableY + 6, { width: 50 });
    doc.text('Status', 400, tableY + 6, { width: 50 });
    doc.text('Check-in Time', 455, tableY + 6, { width: 95 });
    tableY += 20;
  };

  drawHeader();
  doc.font('Helvetica').fontSize(8);
  let rowCount = 0;

  for (const att of data.attendees) {
    if (tableY > 750) {
      doc.addPage();
      tableY = 40;
      drawHeader();
    }

    if (rowCount % 2 === 0) {
      doc.rect(40, tableY, 515, 18).fill('#f8fafc');
    }

    doc.fillColor('#1e293b');
    doc.text(att.school_id, 45, tableY + 5, { width: 65 });
    doc.text(att.full_name, 115, tableY + 5, { width: 110, ellipsis: true });
    doc.text(att.department_or_course, 230, tableY + 5, { width: 110, ellipsis: true });
    doc.text(att.role, 345, tableY + 5, { width: 50 });

    if (att.status === 'PRESENT') {
      doc.fillColor('#059669').font('Helvetica-Bold').text('PRESENT', 400, tableY + 5);
      doc.fillColor('#475569').font('Helvetica');
      const checkInStr = att.was_offline_sync
        ? `${att.checked_in_at.substring(11, 19)} (Sync)`
        : att.checked_in_at.substring(11, 19);
      doc.text(checkInStr, 455, tableY + 5, { width: 95 });
    } else if (att.status === 'ABSENT') {
      doc.fillColor('#dc2626').font('Helvetica-Bold').text('ABSENT', 400, tableY + 5);
      doc.fillColor('#94a3b8').font('Helvetica').text('-', 455, tableY + 5);
    } else {
      doc.fillColor('#d97706').font('Helvetica-Bold').text('PENDING', 400, tableY + 5);
      doc.fillColor('#94a3b8').font('Helvetica').text('-', 455, tableY + 5);
    }

    tableY += 18;
    rowCount++;
  }

  doc.fontSize(7).fillColor('#94a3b8').text('EventSync Attendance System', 40, 785, { align: 'center', width: 515 });
  doc.end();
  return true;
}

module.exports = {
  getEventReportData,
  getSummaryReport,
  generateCsvReport,
  generateXlsxReport,
  streamPdfReport
};
