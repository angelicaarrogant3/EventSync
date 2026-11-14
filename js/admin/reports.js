import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch, csvDownload } from '/js/core/ui.js';

await boot('admin', 'reports');
let stats = [], detail = [];

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
  const { data, error } = await supabase.from('registrations').select('status,registered_at,profiles(full_name,email),attendance(checked_in_at)').eq('event_id', id).order('registered_at');
  if (error) return toast(errMsg(error), 'error');
  detail = data.map(r => { const a = Array.isArray(r.attendance) ? r.attendance[0] : r.attendance; return { name: r.profiles?.full_name, email: r.profiles?.email, status: r.status, registered: r.registered_at, checkin: a?.checked_in_at }; });
  $('#detail').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Registration</th><th>Registered at</th><th>Checked in</th></tr></thead><tbody>${detail.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.email)}</td><td><span class="badge ${d.status}">${d.status}</span></td><td>${fmt(d.registered)}</td><td>${d.checkin ? fmt(d.checkin) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No registrations.</td></tr>'}</tbody></table></div>`;
}

$('#ev').onchange = loadDetail;
$('#print').onclick = () => window.print();
$('#csv').onclick = () => {
  if ($('#ev').value) {
    const t = stats.find(s => s.id === $('#ev').value)?.title || 'event';
    csvDownload(`attendance-${t.replace(/\W+/g, '_')}.csv`, [['Name', 'Email', 'Registration', 'Registered at', 'Checked in at'], ...detail.map(d => [d.name, d.email, d.status, d.registered, d.checkin || ''])]);
  } else {
    csvDownload('eventsync-summary.csv', [['Event', 'Starts', 'Status', 'Registered', 'Attended'], ...stats.map(e => [e.title, e.starts_at, e.status, e.registered_count, e.attended_count])]);
  }
};
const refresh = async () => { await loadEvents(); await loadDetail(); };
await refresh();
watch(['events', 'registrations', 'attendance'], refresh);
