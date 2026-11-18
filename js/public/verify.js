import { supabase } from '/js/core/supabase.js';
import { $, esc, fmt, errMsg } from '/js/core/ui.js';

function extractCodeFromLocation() {
  const params = new URLSearchParams(location.search);
  if (params.get('code')) return params.get('code').trim().toUpperCase();
  const m = location.pathname.match(/\/verify\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).trim().toUpperCase() : '';
}

async function runVerify(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const box = $('#resultBox');
  if (!code) { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="muted sm">Checking certificate record...</p>';

  const { data, error } = await supabase.rpc('verify_certificate_code', { p_code: code });
  if (error) {
    box.innerHTML = `<div style="padding:1rem;border-radius:10px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4)">
      <span class="badge dup">RATE LIMITED</span>
      <p class="sm" style="margin:.5rem 0 0">${esc(errMsg(error))}</p>
    </div>`;
    return;
  }

  const st = data?.status || 'not_found';
  if (st === 'valid') {
    box.innerHTML = `
      <div style="padding:1.15rem;border-radius:10px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.4)">
        <div class="row" style="justify-content:space-between;margin-bottom:.65rem">
          <span class="badge ok" style="font-size:.9rem">VALID CERTIFICATE</span>
          <code class="sm">${esc(data.certificate_code)}</code>
        </div>
        <div class="two sm" style="gap:.65rem">
          <div><span class="muted">Participant Name</span><br><b>${esc(data.participant_name)}</b></div>
          <div><span class="muted">Event Name</span><br><b>${esc(data.event_name)}</b></div>
          <div><span class="muted">Event Date</span><br><b>${esc(data.event_date)}</b></div>
          <div><span class="muted">Issuing Organizer</span><br><b>${esc(data.issuing_organizer)}</b></div>
        </div>
        <p class="muted sm" style="margin:.75rem 0 0">Issued on ${fmt(data.issued_at)}</p>
      </div>`;
  } else if (st === 'revoked') {
    box.innerHTML = `
      <div style="padding:1.15rem;border-radius:10px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4)">
        <div class="row" style="justify-content:space-between;margin-bottom:.65rem">
          <span class="badge cancelled" style="font-size:.9rem">REVOKED CERTIFICATE</span>
          <code class="sm">${esc(data.certificate_code)}</code>
        </div>
        <div class="two sm" style="gap:.65rem">
          <div><span class="muted">Participant Name</span><br><b>${esc(data.participant_name)}</b></div>
          <div><span class="muted">Event Name</span><br><b>${esc(data.event_name)}</b></div>
          <div><span class="muted">Event Date</span><br><b>${esc(data.event_date)}</b></div>
          <div><span class="muted">Issuing Organizer</span><br><b>${esc(data.issuing_organizer)}</b></div>
        </div>
        <p class="sm" style="margin:.75rem 0 0;color:#fca5a5"><b>Revoked${data.revoked_at ? ` on ${fmt(data.revoked_at)}` : ''}</b>${data.revoke_reason ? ` — Reason: ${esc(data.revoke_reason)}` : ''}</p>
      </div>`;
  } else {
    box.innerHTML = `
      <div style="padding:1.15rem;border-radius:10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35)">
        <span class="badge cancelled" style="font-size:.9rem">NOT FOUND</span>
        <p class="sm" style="margin:.55rem 0 0">No certificate matches <code>${esc(code)}</code>. Please check the code and try again.</p>
      </div>`;
  }
}

$('#verifyForm').onsubmit = e => {
  e.preventDefault();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) return;
  history.replaceState(null, '', `/verify/${encodeURIComponent(code)}`);
  runVerify(code);
};

const initial = extractCodeFromLocation();
if (initial) {
  $('#codeInput').value = initial;
  runVerify(initial);
}
