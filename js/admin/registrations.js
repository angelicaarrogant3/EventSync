import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import { mountParticipantForm } from '/js/shared/participant-form.js';

await boot('admin', 'registrations');
let rows = [];
const form = mountParticipantForm($('#pfields'), { consentLabel: 'Participant consent obtained: their information will be used for event registration and attendance.' });

async function loadEvents() {
  const { data } = await supabase.from('events').select('id,title,status').order('starts_at', { ascending: false });
  const cur = $('#ev').value, curP = $('#p_event').value;
  $('#ev').innerHTML = '<option value="">All events</option>' + (data || []).map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#p_event').innerHTML = '<option value="">— none —</option>' + (data || []).filter(e => e.status === 'published').map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#ev').value = cur; $('#p_event').value = curP;
}

async function load() {
  let q = supabase.from('registrations').select('id,status,registered_at,event_id,profiles(full_name,email,school_id,course,year_level,section,contact_number,member_type),events(title),attendance(checked_in_at)').order('registered_at', { ascending: false }).limit(1000);
  if ($('#ev').value) q = q.eq('event_id', $('#ev').value);
  const { data, error } = await q;
  if (error) return toast(errMsg(error), 'error');
  rows = data; render();
}

function render() {
  const s = $('#q').value.toLowerCase();
  const list = rows.filter(r => !s || Object.values(r.profiles || {}).join(' ').toLowerCase().includes(s));
  if (!list.length) { $('#list').innerHTML = '<div class="card empty">No registrations found.</div>'; return; }
  $('#list').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Participant</th><th>School ID</th><th>Course</th><th>Year</th><th>Section</th><th>Contact</th><th>Email</th><th>Event</th><th>Registered</th><th>Status</th><th>Attendance</th><th></th></tr></thead><tbody>${list.map(r => {
    const p = r.profiles || {}, att = Array.isArray(r.attendance) ? r.attendance[0] : r.attendance;
    return `<tr><td data-label="Participant">${esc(p.full_name)}<br><small class="muted">${esc(p.member_type || '')}</small></td><td data-label="School ID">${esc(p.school_id || '—')}</td><td data-label="Course">${esc(p.course || '—')}</td><td data-label="Year">${p.year_level ?? '—'}</td><td data-label="Section">${esc(p.section || '—')}</td><td data-label="Contact">${esc(p.contact_number || '—')}</td><td data-label="Email">${esc(p.email)}</td><td data-label="Event">${esc(r.events?.title)}</td><td data-label="Registered">${fmt(r.registered_at)}</td>
    <td data-label="Status"><span class="badge ${r.status}">${r.status}</span></td>
    <td data-label="Attendance">${att ? `<span class="badge ok">In ${fmt(att.checked_in_at)}</span>` : '<span class="badge">Not yet</span>'}</td>
    <td data-label="Action">${att ? '' : r.status === 'registered' ? `<button class="btn sm danger" data-id="${r.id}" data-s="cancelled">Cancel</button>` : `<button class="btn sm ok" data-id="${r.id}" data-s="registered">Reinstate</button>`}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

$('#list').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  b.disabled = true;
  const { error } = await supabase.rpc('admin_set_registration_status', { p_registration_id: b.dataset.id, p_status: b.dataset.s });
  if (error) { toast(errMsg(error), 'error'); b.disabled = false; } else { toast('Registration updated', 'success'); load(); }
};
$('#ev').onchange = load; $('#q').oninput = render;

/* ---- assisted registration ---- */
$('#newP').onclick = () => { $('#pmsg').innerHTML = ''; $('#pdlg').showModal(); };
$('#pcancel').onclick = () => $('#pdlg').close();
$('#pform').onsubmit = async ev => {
  ev.preventDefault(); $('#pmsg').innerHTML = '';
  if (!form.validate()) return;
  const v = form.values(); const btn = $('#psave'); btn.disabled = true;
  try {
    const { confirm_password, ...payload } = v;
    const { data, error } = await supabase.rpc('admin_register_participant', { p: payload });
    if (error) throw error;
    if ($('#p_event').value) {
      const r = await supabase.rpc('admin_register_user_for_event', { p_user_id: data.id, p_event_id: $('#p_event').value });
      if (r.error) toast('Participant created, but event registration failed: ' + errMsg(r.error), 'error', 6000);
    }
    toast(`Participant ${v.full_name} created`, 'success'); form.reset(); $('#pdlg').close(); load();
  } catch (e) {
    const m = errMsg(e);
    if (/school id is already/i.test(m)) form.showErrors({ school_id: 'This school ID is already registered' });
    else if (/email is already|already registered/i.test(m)) form.showErrors({ email: 'This email is already registered' });
    else $('#pmsg').innerHTML = `<div class="err">${esc(m)}</div>`;
  } finally { btn.disabled = false; }
};

await loadEvents(); await load();
watch(['registrations', 'attendance', 'events'], () => { loadEvents(); load(); });
