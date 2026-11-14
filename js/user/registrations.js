import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import QRCode from 'https://esm.sh/qrcode@1.5.3';

await boot('user', 'registrations');
const qrCache = new Map();

async function qr(token) {
  if (!qrCache.has(token)) qrCache.set(token, await QRCode.toDataURL('EVENTSYNC:' + token, { width: 320, margin: 1, errorCorrectionLevel: 'M' }));
  return qrCache.get(token);
}

async function load() {
  const { data, error } = await supabase.from('registrations').select('id,status,qr_token,registered_at,events(title,venue,starts_at,ends_at),attendance(checked_in_at)').order('registered_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  if (!data.length) { $('#list').innerHTML = '<div class="card empty" style="grid-column:1/-1">No registrations yet. <a href="/user/events">Browse events</a>.</div>'; return; }
  const cards = await Promise.all(data.map(async r => {
    const att = Array.isArray(r.attendance) ? r.attendance[0] : r.attendance;
    const active = r.status === 'registered';
    return `<div class="card qrbox"><h2>${esc(r.events?.title)}</h2>
      <p class="muted sm">${fmt(r.events?.starts_at)}<br>📍 ${esc(r.events?.venue)}</p>
      <p><span class="badge ${r.status}">${r.status}</span> ${att ? `<span class="badge ok">Checked in ${fmt(att.checked_in_at)}</span>` : ''}</p>
      ${active ? `<img alt="QR code" src="${await qr(r.qr_token)}"><p class="muted sm">Show this code at the entrance</p>` : ''}
      ${active && !att ? `<button class="btn sm danger" data-id="${r.id}">Cancel registration</button>` : ''}</div>`;
  }));
  $('#list').innerHTML = cards.join('');
}

$('#list').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b || !confirm('Cancel this registration?')) return;
  b.disabled = true;
  const { error } = await supabase.rpc('cancel_registration', { p_registration_id: b.dataset.id });
  if (error) toast(errMsg(error), 'error'); else toast('Registration cancelled', 'success');
  load();
};

await load();
watch(['registrations', 'attendance'], load);   // QR flips to "Checked in" live
