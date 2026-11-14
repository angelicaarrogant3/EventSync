import QRCode from 'https://esm.sh/qrcode@1.5.3';
import { esc, fmt } from '/js/core/ui.js';
import { ICONS } from '/js/shared/icons.js';
import { eventBannerHtml } from '/js/shared/event-images.js';

const cache = new Map();
export async function qrDataUrl(token, width = 320) {
  const k = token + width;
  if (!cache.has(k)) cache.set(k, await QRCode.toDataURL('EVENTSYNC:' + token, { width, margin: 2, errorCorrectionLevel: 'M' }));
  return cache.get(k);
}

/** Opens a modal with the participant's QR + details and a Download PNG button. */
export async function openQrModal({ token, title, startsAt, venue, name, schoolId, course, imagePath = null, imageUpdatedAt = null }) {
  let dlg = document.getElementById('qrDlg');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'qrDlg'; dlg.style.textAlign = 'center';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }
  const img = await qrDataUrl(token, 320);
  const banner = eventBannerHtml({ title, image_path: imagePath, image_updated_at: imageUpdatedAt }, { variant: 'ticket' });
  dlg.innerHTML = `
    <div class="ticket-head">
      <img class="es-logo" src="/assets/logo.png" alt="EventSync logo" width="38" height="25">
      <b>EventSync Pass</b>
    </div>
    ${banner}
    <h2>${esc(title)}</h2>
    <p class="muted sm">${ICONS.clock(14)} ${fmt(startsAt)}<br>${ICONS.pin(14)} ${esc(venue)}<br>${ICONS.user(14)} <b>${esc(name)}</b>${schoolId ? `<br><span class="ticket-id">ID: ${esc(schoolId)}${course ? ` · ${esc(course)}` : ''}</span>` : ''}</p>
    <div class="qrbox"><div class="qr-frame"><img alt="Your QR code" src="${img}"></div></div>
    <p class="muted sm">Show this code at the entrance.</p>
    <div class="row" style="justify-content:center;margin-top:.85rem">
      <button class="btn" id="qrDl">${ICONS.download(16)} Download PNG</button>
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
