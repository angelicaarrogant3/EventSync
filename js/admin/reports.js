import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch, csvDownload, excelDownload } from '/js/core/ui.js';

await boot('admin', 'reports');
let stats = [], detail = [];
const HEAD = ['Name', 'School ID', 'Type', 'Course / Department', 'Year', 'Section', 'Contact', 'Email', 'Registration', 'Registered at', 'Checked in at'];
const asRow = d => [d.name, d.school_id, d.type, d.course, d.year, d.section, d.contact, d.email, d.status, d.registered ? fmt(d.registered) : '', d.checkin ? fmt(d.checkin) : ''];

async function loadEvents() {
  const { data, error } = await supabase.from('event_stats').select('*').order('starts_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  stats = data;
  $('#summary').innerHTML = stats.length ? `<div class="tablewrap"><table><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Registered</th><th>Attended</th><th>No-show</th><th>Rate</th></tr></thead><tbody>${stats.map(e => {
    const rate = e.registered_count ? Math.round(e.attended_count / e.registered_count * 100) : 0;
    return `<tr><td>${esc(e.title)}</td><td>${fmt(e.starts_at)}</td><td><span class="badge ${e.status}">${e.status}</span></td><td>${e.registered_count}</td><td>${e.attended_count}</td><td>${Math.max(e.registered_count - e.attended_count, 0)}</td><td>${rate}%</td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="card empty">No events.</div>';
  const cur = $('#ev').value;
  $('#ev').innerHTML = '<option value="">Select an event for attendee detail</option>' + stats.map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#ev').value = cur;
}

async function loadDetail() {
  const id = $('#ev').value;
  if (!id) { detail = []; $('#detail').innerHTML = ''; return; }
  const { data, error } = await supabase.from('registrations')
    .select('status,registered_at,profiles(full_name,email,school_id,member_type,course,year_level,section,contact_number),attendance(checked_in_at)')
    .eq('event_id', id).order('registered_at');
  if (error) return toast(errMsg(error), 'error');
  detail = data.map(r => {
    const a = Array.isArray(r.attendance) ? r.attendance[0] : r.attendance, p = r.profiles || {};
    return { name: p.full_name, school_id: p.school_id || '', type: p.member_type || '', course: p.course || '', year: p.year_level ?? '', section: p.section || '',
             contact: p.contact_number || '', email: p.email, status: r.status, registered: r.registered_at, checkin: a?.checked_in_at };
  });
  $('#detail').innerHTML = `<div class="tablewrap"><table><thead><tr>${HEAD.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${detail.map(d => `<tr>${asRow(d).map((v, i) => `<td>${i === 8 ? `<span class="badge ${d.status}">${d.status}</span>` : esc(v || '—')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${HEAD.length}" class="empty">No registrations.</td></tr>`}</tbody></table></div>`;
}

function exportRows() {
  const sel = $('#ev').value, ev = stats.find(s => s.id === sel);
  if (sel) return { name: `attendance-${(ev?.title || 'event').replace(/\W+/g, '_')}`, rows: [HEAD, ...detail.map(asRow)] };
  return { name: 'eventsync-summary', rows: [['Event', 'Starts', 'Status', 'Registered', 'Attended'], ...stats.map(e => [e.title, e.starts_at, e.status, e.registered_count, e.attended_count])] };
}
$('#ev').onchange = loadDetail;
$('#print').onclick = () => window.print();                       // choose "Save as PDF" in the print dialog
$('#csv').onclick = () => { const x = exportRows(); csvDownload(x.name + '.csv', x.rows); };
$('#xls').onclick = () => { const x = exportRows(); excelDownload(x.name + '.xls', x.rows); };
const refresh = async () => { await loadEvents(); await loadDetail(); };
await refresh();
watch(['events', 'registrations', 'attendance'], refresh);
