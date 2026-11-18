import { esc, fmt } from '/js/core/ui.js';
import { shortPassCode } from '/js/user/qr-modal.js';

/**
 * Renders a high-resolution Certificate of Attendance onto an offscreen canvas
 * and returns a PNG data URL for instant download on mobile & desktop.
 */
export function renderCertificateDataUrl({
  name,
  schoolId,
  program,
  eventTitle,
  venue,
  startsAt,
  checkedInAt,
  token
}) {
  const W = 2000, H = 1414; // A4 landscape ratio
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  // Cream / parchment background
  ctx.fillStyle = '#fdfbf7';
  ctx.fillRect(0, 0, W, H);

  // Outer crimson border
  ctx.strokeStyle = '#991b1b';
  ctx.lineWidth = 16;
  ctx.strokeRect(60, 60, W - 120, H - 120);

  // Inner gold accent border
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 4;
  ctx.strokeRect(86, 86, W - 172, H - 172);

  ctx.textAlign = 'center';

  // Institution header
  ctx.fillStyle = '#7f1d1d';
  ctx.font = 'bold 34px Georgia, serif';
  ctx.fillText('BILIRAN PROVINCE STATE UNIVERSITY — MAIN CAMPUS', W / 2, 200);

  ctx.fillStyle = '#57534e';
  ctx.font = '24px Arial, sans-serif';
  ctx.fillText('EventSync Attendance Management System', W / 2, 245);

  // Main Certificate Title
  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 74px Georgia, serif';
  ctx.fillText('CERTIFICATE OF ATTENDANCE', W / 2, 370);

  // Divider line
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 280, 405);
  ctx.lineTo(W / 2 + 280, 405);
  ctx.stroke();

  ctx.fillStyle = '#44403c';
  ctx.font = 'italic 30px Georgia, serif';
  ctx.fillText('This is to certify that', W / 2, 485);

  // Participant Name
  ctx.fillStyle = '#991b1b';
  ctx.font = 'bold 64px Georgia, serif';
  ctx.fillText(String(name || 'Participant').toUpperCase(), W / 2, 585);

  // Underline participant name
  ctx.strokeStyle = '#d6d3d1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 420, 608);
  ctx.lineTo(W / 2 + 420, 608);
  ctx.stroke();

  // School ID & Program subtitle
  const metaParts = [schoolId ? `ID: ${schoolId}` : '', program || ''].filter(Boolean);
  if (metaParts.length) {
    ctx.fillStyle = '#57534e';
    ctx.font = '26px Arial, sans-serif';
    ctx.fillText(metaParts.join('  ·  '), W / 2, 655);
  }

  ctx.fillStyle = '#44403c';
  ctx.font = 'italic 30px Georgia, serif';
  ctx.fillText('has actively participated in and attended', W / 2, 740);

  // Event Title
  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 48px Georgia, serif';
  ctx.fillText(String(eventTitle || 'University Event'), W / 2, 825);

  // Event date & venue
  ctx.fillStyle = '#44403c';
  ctx.font = '28px Arial, sans-serif';
  ctx.fillText(`Held on ${fmt(startsAt)} at ${venue || 'BiPSU Main Campus'}`, W / 2, 895);

  // Verification footer
  const code = shortPassCode(token);
  ctx.fillStyle = '#78716c';
  ctx.font = '22px Arial, sans-serif';
  ctx.fillText(
    `Verified Check-In: ${fmt(checkedInAt)}${code ? `   |   Verification Code: ${code}` : ''}`,
    W / 2,
    1160
  );

  // Signature lines
  ctx.strokeStyle = '#44403c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(360, 1060);
  ctx.lineTo(780, 1060);
  ctx.moveTo(W - 780, 1060);
  ctx.lineTo(W - 360, 1060);
  ctx.stroke();

  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 24px Arial, sans-serif';
  ctx.fillText('Event Organizer', 570, 1098);
  ctx.fillText('EventSync System Verification', W - 570, 1098);

  return c.toDataURL('image/png');
}

/** Opens a modal preview of the participant's Certificate of Attendance with Download & Print actions. */
export function openCertificateModal(opts) {
  let dlg = document.getElementById('certDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'certDlg';
    dlg.style.width = 'min(760px, 96vw)';
    dlg.style.textAlign = 'center';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }
  const dataUrl = renderCertificateDataUrl(opts);
  const code = shortPassCode(opts.token);
  dlg.innerHTML = `
    <div class="pagehead" style="margin-bottom:.65rem;text-align:left">
      <div>
        <h2 style="margin:0">Certificate of Attendance</h2>
        <p class="muted sm" style="margin:.15rem 0 0">${esc(opts.eventTitle)}${code ? ` · Code: ${esc(code)}` : ''}</p>
      </div>
    </div>
    <div style="background:#111;padding:.5rem;border-radius:10px;border:1px solid var(--line)">
      <img src="${dataUrl}" alt="Certificate of Attendance" style="width:100%;height:auto;border-radius:6px;display:block">
    </div>
    <div class="row" style="justify-content:center;margin-top:.9rem;gap:.5rem">
      <button type="button" class="btn" id="certDl">Download Certificate</button>
      <button type="button" class="btn ghost" id="certPrint">Print / Save PDF</button>
      <button type="button" class="btn ghost" id="certClose">Close</button>
    </div>`;

  dlg.querySelector('#certClose').onclick = () => dlg.close();
  dlg.querySelector('#certDl').onclick = () => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `eventsync-certificate-${String(opts.eventTitle || 'event').replace(/\W+/g, '_').slice(0, 40)}.png`;
    a.click();
  };
  dlg.querySelector('#certPrint').onclick = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><title>Certificate - ${esc(opts.eventTitle)}</title>
      <style>@page{size:A4 landscape;margin:0}html,body{margin:0;padding:0;height:100%;display:flex;align-items:center;justify-content:center;background:#fff}img{width:100%;max-height:100vh;object-fit:contain}</style>
      </head><body><img src="${dataUrl}" onload="window.focus();window.print()"></body></html>`);
    w.document.close();
  };
  if (!dlg.open) dlg.showModal();
}
