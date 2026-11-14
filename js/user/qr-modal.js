import QRCode from 'https://esm.sh/qrcode@1.5.3';
import { esc, fmt } from '/js/core/ui.js';

const cache = new Map();
export async function qrDataUrl(token, width = 320) {
  const k = token + width;
  if (!cache.has(k)) cache.set(k, await QRCode.toDataURL('EVENTSYNC:' + token, { width, margin: 2, errorCorrectionLevel: 'M' }));
  return cache.get(k);
}

/** Opens a modal with the participant's QR + details and a Download PNG button. */
export async function openQrModal({ token, title, startsAt, venue, name, schoolId, course }) {
  let dlg = document.getElementById('qrDlg');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'qrDlg'; dlg.style.textAlign = 'center';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }
  const img = await qrDataUrl(token, 320);
  dlg.innerHTML = `
    <h2>${esc(title)}</h2>
    <p class="muted sm">${fmt(startsAt)}<br>📍 ${esc(venue)}<br>👤 <b>${esc(name)}</b>${schoolId ? `<br><span class="ticket-id">ID: ${esc(schoolId)}${course ? ` · ${esc(course)}` : ''}</span>` : ''}</p>
    <div class="qrbox"><img alt="Your QR code" src="${img}"></div>
    <p class="muted sm">Show this code at the entrance.</p>
    <div class="row" style="justify-content:center;margin-top:.75rem">
      <button class="btn" id="qrDl">Download PNG</button>
      <button class="btn ghost" id="qrClose">Close</button>
    </div>`;
  dlg.querySelector('#qrClose').onclick = () => dlg.close();
  dlg.querySelector('#qrDl').onclick = async () => {
    const big = await qrDataUrl(token, 800);
    const a = document.createElement('a'); a.href = big;
    a.download = `eventsync-qr-${String(title).replace(/\W+/g, '_').slice(0, 40)}.png`; a.click();
  };
  if (!dlg.open) dlg.showModal();
}
