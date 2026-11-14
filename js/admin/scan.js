import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmtTime, toast, errMsg } from '/js/core/ui.js';

await boot('admin', 'scan');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let scanner = null, busy = false, last = { t: '', at: 0 };

async function verify(raw) {
  const m = String(raw).match(UUID);
  if (!m) return show({ status: 'invalid', message: 'Not an EventSync QR code' });
  const token = m[0].toLowerCase();
  if (busy || (token === last.t && Date.now() - last.at < 4000)) return;   // debounce same code & concurrent scans
  busy = true; last = { t: token, at: Date.now() };
  try {
    const { data, error } = await supabase.rpc('verify_attendance', { p_qr_token: token });
    if (error) throw error;
    show(data);
  } catch (e) { show({ status: 'error', message: errMsg(e) }); }
  finally { busy = false; }
}

function show(r) {
  const title = { ok: '✔ Checked in', duplicate: '⚠ Already checked in', invalid: '✖ Invalid QR', cancelled: '✖ Registration cancelled', error: '✖ Error' }[r.status] || r.status;
  $('#result').innerHTML = `<div class="result ${r.status}"><big>${title}</big>${r.participant ? esc(r.participant) + '<br>' : ''}${r.event ? esc(r.event) + '<br>' : ''}<small>${esc(r.message || '')}</small></div>`;
  if (navigator.vibrate) navigator.vibrate(r.status === 'ok' ? 120 : [80, 60, 80]);
  const li = document.createElement('li'); li.className = 'new';
  li.innerHTML = `<span>${esc(r.participant || 'Unknown')}<br><small class="muted">${esc(r.event || r.message || '')}</small></span><span class="badge ${r.status === 'ok' ? 'ok' : r.status === 'duplicate' ? 'dup' : 'cancelled'}">${r.status}</span><small class="muted">${fmtTime(new Date())}</small>`;
  $('#recent').prepend(li);
}

$('#start').onclick = async () => {
  $('#camErr').innerHTML = '';
  if (!window.isSecureContext) $('#camErr').innerHTML = '<div class="err">Camera requires HTTPS or localhost. Use the public HTTPS URL on phones (see README).</div>';
  try {
    scanner = scanner || new Html5Qrcode('reader');
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, txt => verify(txt), () => {});
    $('#start').disabled = true; $('#stop').disabled = false;
  } catch (e) { $('#camErr').innerHTML = `<div class="err">Cannot start camera: ${esc(errMsg(e))}</div>`; }
};
$('#stop').onclick = async () => { await scanner?.stop(); $('#start').disabled = false; $('#stop').disabled = true; };
$('#verify').onclick = () => { const v = $('#manual').value.trim(); if (v) { last = { t: '', at: 0 }; verify(v); $('#manual').value = ''; } };
$('#manual').addEventListener('keydown', e => { if (e.key === 'Enter') $('#verify').click(); });
