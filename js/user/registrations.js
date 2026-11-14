import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import { openQrModal } from '/js/user/qr-modal.js';

const { profile } = await boot('user', 'registrations');
let rows = [];

async function load() {
  const { data, error } = await supabase.from('registrations')
    .select('id,status,qr_token,registered_at,events(title,venue,starts_at,ends_at),attendance(checked_in_at)')
    .order('registered_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  rows = data; render();
}

function render() {
  if (!rows.length) { $('#list').innerHTML = '<div class="card empty" style="grid-column:1/-1">No registrations yet. <a href="/user/events">Browse events</a>.</div>'; return; }
  $('#list').innerHTML = rows.map(r => {
    const att = Array.isArray(r.attendance) ? r.attendance[0] : r.attendance;
    const started = r.events && new Date(r.events.starts_at) <= new Date();
    const label = r.status === 'cancelled' ? ['cancelled', 'Cancelled'] : att ? ['ok', `Attended · ${fmt(att.checked_in_at)}`] : ['registered', 'Registered'];
    const canCancel = r.status === 'registered' && !att && !started;
    return `<div class="card"><h2>${esc(r.events?.title)}</h2>
      <p class="muted sm">${fmt(r.events?.starts_at)}<br>📍 ${esc(r.events?.venue)}</p>
      <p><span class="badge ${label[0]}">${label[1]}</span></p>
      <div class="row">
        ${r.status === 'registered' ? `<button class="btn" data-qr="${r.id}">View QR</button>` : ''}
        ${r.status === 'registered' && !att ? `<button class="btn ghost" data-cancel="${r.id}" ${canCancel ? '' : 'disabled title="Cancellation closes when the event starts"'}>Cancel</button>` : ''}
      </div>
      ${r.status === 'registered' && !att && started ? '<p class="muted sm" style="margin:.4rem 0 0">Event started - cancellation is closed.</p>' : ''}</div>`;
  }).join('');
}

$('#list').onclick = async e => {
  const q = e.target.closest('button[data-qr]');
  if (q) {
    const r = rows.find(x => x.id === q.dataset.qr);
    return openQrModal({ token: r.qr_token, title: r.events?.title, startsAt: r.events?.starts_at, venue: r.events?.venue, name: profile.full_name || profile.email, schoolId: profile.school_id, course: profile.course });
  }
  const b = e.target.closest('button[data-cancel]'); if (!b || b.disabled || !confirm('Cancel this registration? Your seat will be released.')) return;
  b.disabled = true;
  const { error } = await supabase.rpc('cancel_registration', { p_registration_id: b.dataset.cancel });
  if (error) toast(errMsg(error), 'error'); else toast('Registration cancelled', 'success');
  load();
};

await load();
watch(['registrations', 'attendance', 'events'], load);   // badge flips to "Attended" live
