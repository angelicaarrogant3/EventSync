import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import {
  buildSheetModel, buildWorkbook, renderPrintHtml, fmtDate,
  buildSummaryModel, summaryWorkbook, attendanceRate
} from '/js/shared/sheet.js';

await boot('admin', 'reports');
let stats = [];

function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

async function downloadXlsx(filename, wb) {
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(filename, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

async function loadEvents() {
  const { data, error } = await supabase.from('event_stats').select('*').order('starts_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  stats = data;
  $('#summary').innerHTML = stats.length ? `<div class="tablewrap"><table><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Registered</th><th>Attended</th><th>No-show</th><th>Rate</th></tr></thead><tbody>${stats.map(e => {
    const rate = attendanceRate(e.registered_count, e.attended_count);
    return `<tr><td data-label="Event">${esc(e.title)}</td><td data-label="Date">${fmt(e.starts_at)}</td><td data-label="Status"><span class="badge ${e.status}">${e.status}</span></td><td data-label="Registered">${e.registered_count}</td><td data-label="Attended">${e.attended_count}</td><td data-label="No-show">${Math.max(e.registered_count - e.attended_count, 0)}</td><td data-label="Rate">${rate}%</td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="card empty">No events.</div>';

  const cur = $('#ev').value;
  $('#ev').innerHTML = '<option value="">Select an event…</option>' + stats.map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#ev').value = cur;
}

function setExportEnabled(on) {
  ['#xlsx', '#pdf'].forEach(s => { $(s).disabled = !on; });
}

async function fetchSheet(format = null) {
  const id = $('#ev').value;
  if (!id) return null;
  const { data, error } = await supabase.rpc('attendance_sheet', { p_event_id: id, p_filter: $('#filter').value, p_format: format });
  if (error) throw error;
  return buildSheetModel(data);
}

async function loadDetail() {
  const id = $('#ev').value;
  setExportEnabled(!!id);
  if (!id) {
    $('#detail').innerHTML = '<div class="card empty noprint">Select an event above to preview and export its attendance sheet.</div>';
    return;
  }
  try {
    const model = await fetchSheet(null);
    $('#detail').innerHTML = `<div class="card sheet-wrap">${renderPrintHtml(model)}</div>`;
  } catch (e) { toast(errMsg(e), 'error'); }
}

async function exportEvent(format) {
  try {
    const model = await fetchSheet(format);
    if (!model) return;
    $('#detail').innerHTML = `<div class="card sheet-wrap">${renderPrintHtml(model)}</div>`;
    const slug = `${model.eventTitle.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'event'}-${fmtDate(model.eventStart)}`;
    if (format === 'xlsx') {
      if (!window.ExcelJS) throw new Error('Excel library failed to load. Check your connection and reload.');
      const { workbook } = buildWorkbook(window.ExcelJS, model);
      await downloadXlsx(`attendance-sheet-${slug}.xlsx`, workbook);
    } else {
      window.print();
    }
  } catch (e) { toast(errMsg(e), 'error'); }
}

async function exportSummary() {
  try {
    const m = buildSummaryModel(stats);
    const { error } = await supabase.rpc('log_export', { p_kind: 'summary_all_events', p_details: { format: 'xlsx', events: stats.length } });
    if (error) throw error;
    if (!window.ExcelJS) throw new Error('Excel library failed to load. Check your connection and reload.');
    await downloadXlsx('eventsync-summary-of-all-events.xlsx', summaryWorkbook(window.ExcelJS, m));
  } catch (e) { toast(errMsg(e), 'error'); }
}

$('#ev').onchange = loadDetail;
$('#filter').onchange = loadDetail;
$('#xlsx').onclick = () => exportEvent('xlsx');
$('#pdf').onclick = () => exportEvent('pdf');
$('#sumXlsx').onclick = () => exportSummary();

const refresh = async () => { await loadEvents(); await loadDetail(); };
await refresh();
watch(['events', 'registrations', 'attendance'], refresh);
