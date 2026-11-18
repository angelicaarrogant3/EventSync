import QRCode from 'https://esm.sh/qrcode@1.5.3';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { supabase } from '/js/core/supabase.js';
import { esc, fmt, toast, errMsg } from '/js/core/ui.js';
import { PROGRAM_SCHOOLS } from '/js/shared/participant-options.js';

export const CERTIFICATE_TITLE = 'Certificate of Participation';
export const DEFAULT_TEMPLATE_ID = '00000000-0000-0000-0000-00000000ce01';
export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MIN_RECOMMENDED_WIDTH = 2000;

export const ALLOWED_FIELD_DEFS = [
  { type: 'participant_name', label: 'Participant full name', mandatory: true },
  { type: 'event_name', label: 'Event name', mandatory: false },
  { type: 'event_date', label: 'Event date', mandatory: false },
  { type: 'venue', label: 'Venue', mandatory: false },
  { type: 'organizing_office', label: 'Organizing office / org', mandatory: false },
  { type: 'program', label: 'Program', mandatory: false },
  { type: 'school', label: 'School / College', mandatory: false },
  { type: 'year_level', label: 'Year level', mandatory: false },
  { type: 'section', label: 'Section', mandatory: false },
  { type: 'issue_date', label: 'Issue date', mandatory: false },
  { type: 'signatory_1_name', label: 'Signatory 1 name', mandatory: false },
  { type: 'signatory_1_title', label: 'Signatory 1 title', mandatory: false },
  { type: 'signatory_2_name', label: 'Signatory 2 name', mandatory: false },
  { type: 'signatory_2_title', label: 'Signatory 2 title', mandatory: false },
  { type: 'certificate_id', label: 'Certificate ID (Required)', mandatory: true },
  { type: 'qr_code', label: 'Verification QR (Required)', mandatory: true }
];

export const DEFAULT_LAYOUT = [
  { type: 'participant_name', x: 250, y: 500, width: 1500, height: 90, font: 'serif', size: 62, color: '#991b1b', alignment: 'center', auto_shrink: true },
  { type: 'program', x: 350, y: 610, width: 1300, height: 42, font: 'sans', size: 26, color: '#57534e', alignment: 'center', auto_shrink: true },
  { type: 'event_name', x: 250, y: 760, width: 1500, height: 75, font: 'serif', size: 46, color: '#1c1917', alignment: 'center', auto_shrink: true },
  { type: 'event_date', x: 350, y: 855, width: 1300, height: 40, font: 'sans', size: 26, color: '#44403c', alignment: 'center', auto_shrink: true },
  { type: 'venue', x: 350, y: 900, width: 1300, height: 40, font: 'sans', size: 24, color: '#57534e', alignment: 'center', auto_shrink: true },
  { type: 'organizing_office', x: 350, y: 945, width: 1300, height: 38, font: 'sans', size: 22, color: '#78716c', alignment: 'center', auto_shrink: true },
  { type: 'signatory_1_name', x: 280, y: 1075, width: 560, height: 36, font: 'sans', size: 24, color: '#1c1917', alignment: 'center', auto_shrink: true },
  { type: 'signatory_1_title', x: 280, y: 1112, width: 560, height: 32, font: 'sans', size: 20, color: '#57534e', alignment: 'center', auto_shrink: true },
  { type: 'signatory_2_name', x: 1160, y: 1075, width: 560, height: 36, font: 'sans', size: 24, color: '#1c1917', alignment: 'center', auto_shrink: true },
  { type: 'signatory_2_title', x: 1160, y: 1112, width: 560, height: 32, font: 'sans', size: 20, color: '#57534e', alignment: 'center', auto_shrink: true },
  { type: 'issue_date', x: 700, y: 1215, width: 600, height: 32, font: 'sans', size: 20, color: '#57534e', alignment: 'center', auto_shrink: false },
  { type: 'certificate_id', x: 700, y: 1255, width: 600, height: 32, font: 'mono', size: 20, color: '#44403c', alignment: 'center', auto_shrink: false },
  { type: 'qr_code', x: 1680, y: 1090, width: 180, height: 180, font: 'sans', size: 16, color: '#000000', alignment: 'center', auto_shrink: false }
];

export const SAMPLE_DATA_NORMAL = {
  participant_name: 'Angeline Dela Cruz',
  event_name: 'Empowering Students Through Technology and Innovation',
  event_date: 'Nov 25, 2026',
  venue: 'BiPSU Main Campus Gymnasium',
  organizing_office: PROGRAM_SCHOOLS[0]?.name || 'University Department',
  program: PROGRAM_SCHOOLS[0]?.programs?.[0]?.name || 'Academic Program',
  school: PROGRAM_SCHOOLS[0]?.name || 'University School',
  year_level: 'Year 3',
  section: '3A',
  issue_date: 'Nov 25, 2026',
  signatory_1_name: 'Dr. Maria Santos',
  signatory_1_title: 'Event Organizer',
  signatory_2_name: 'Engr. Juan Reyes',
  signatory_2_title: 'College Dean',
  certificate_id: 'CERT-2026-K7M4Q9X2',
  qr_code: 'CERT-2026-K7M4Q9X2'
};

export const SAMPLE_DATA_LONG = {
  participant_name: 'Juan Carlos Miguel Dela Cruz-Montemayor III',
  event_name: '14th Annual Regional Symposium on Distributed Computing, Artificial Intelligence, and Sustainable Engineering',
  event_date: 'Nov 25, 2026 – Nov 27, 2026',
  venue: 'BiPSU Main Campus Multi-Purpose Auditorium & Convention Center',
  organizing_office: 'Supreme Student Government & Academic Affairs',
  program: PROGRAM_SCHOOLS[1]?.programs?.[0]?.name || 'Academic Degree Program',
  school: PROGRAM_SCHOOLS[1]?.name || 'University College',
  year_level: 'Year 4',
  section: '4B',
  issue_date: 'Nov 27, 2026',
  signatory_1_name: 'Prof. Alejandro Villanueva-Fernandez, PhD',
  signatory_1_title: 'Overall Symposium Chair & Faculty Adviser',
  signatory_2_name: 'Dr. Roberto Mendoza-Castillo',
  signatory_2_title: 'Vice President for Academic Affairs',
  certificate_id: 'CERT-2026-X9P2W8L4',
  qr_code: 'CERT-2026-X9P2W8L4'
};

/** Magic-byte file validation for PNG, JPG, or single-page PDF (max 10 MB). */
export async function validateTemplateFile(file) {
  if (!file) return { ok: false, error: 'No file selected.' };
  if (file.size > MAX_TEMPLATE_BYTES) {
    return { ok: false, error: 'File is too large (max 10 MB).' };
  }
  const buf = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const isJpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const isPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;

  if (!isPng && !isJpg && !isPdf) {
    return { ok: false, error: 'Unsupported file format. Upload a PNG, JPG, or single-page PDF.' };
  }

  if (isPdf) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await PDFDocument.load(bytes).catch(() => null);
    if (!doc) return { ok: false, error: 'Invalid or corrupted PDF file.' };
    if (doc.getPageCount() !== 1) {
      return { ok: false, error: `PDF must have exactly 1 page (found ${doc.getPageCount()} pages).` };
    }
    const { width, height } = doc.getPage(0).getSize();
    return { ok: true, mime: 'application/pdf', ext: 'pdf', width: Math.round(width * 2.38), height: Math.round(height * 2.38), warning: '' };
  }

  const dims = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
    img.src = url;
  }).catch(() => null);

  if (!dims) return { ok: false, error: 'Could not read image dimensions.' };
  const warning = dims.width < MIN_RECOMMENDED_WIDTH
    ? `Image is ${dims.width}×${dims.height}px. At least ${MIN_RECOMMENDED_WIDTH}px width is recommended for crisp A4 landscape printing.`
    : '';
  return {
    ok: true,
    mime: isPng ? 'image/png' : 'image/jpeg',
    ext: isPng ? 'png' : 'jpg',
    width: dims.width,
    height: dims.height,
    warning
  };
}

/** Draws the built-in blank certificate background (without participant details). */
export function drawDefaultBackgroundOnCanvas(ctx, W = 2000, H = 1414) {
  ctx.fillStyle = '#fdfbf7';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#991b1b';
  ctx.lineWidth = 16;
  ctx.strokeRect(60, 60, W - 120, H - 120);

  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 4;
  ctx.strokeRect(86, 86, W - 172, H - 172);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#7f1d1d';
  ctx.font = 'bold 34px Georgia, serif';
  ctx.fillText('BILIRAN PROVINCE STATE UNIVERSITY — MAIN CAMPUS', W / 2, 195);

  ctx.fillStyle = '#57534e';
  ctx.font = '24px Arial, sans-serif';
  ctx.fillText('Republic of the Philippines · Naval, Biliran', W / 2, 238);

  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 70px Georgia, serif';
  ctx.fillText(CERTIFICATE_TITLE.toUpperCase(), W / 2, 355);

  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 280, 388);
  ctx.lineTo(W / 2 + 280, 388);
  ctx.stroke();

  ctx.fillStyle = '#44403c';
  ctx.font = 'italic 30px Georgia, serif';
  ctx.fillText('This is to certify that', W / 2, 465);

  ctx.strokeStyle = '#d6d3d1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 460, 595);
  ctx.lineTo(W / 2 + 460, 595);
  ctx.stroke();

  ctx.fillStyle = '#44403c';
  ctx.font = 'italic 30px Georgia, serif';
  ctx.fillText('has participated in', W / 2, 715);

  // Signature lines
  ctx.strokeStyle = '#44403c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(300, 1060);
  ctx.lineTo(820, 1060);
  ctx.moveTo(1180, 1060);
  ctx.lineTo(1700, 1060);
  ctx.stroke();
}

/** Downloads a 2000×1414 blank sample certificate design PNG for organizers. */
export function downloadBlankSampleDesign() {
  const c = document.createElement('canvas');
  c.width = 2000;
  c.height = 1414;
  drawDefaultBackgroundOnCanvas(c.getContext('2d'), 2000, 1414);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = 'eventsync-blank-certificate-sample-2000x1414.png';
  a.click();
}

function cssFontFamily(fontKey) {
  if (fontKey === 'serif') return 'Georgia, "Times New Roman", serif';
  if (fontKey === 'script') return '"Brush Script MT", "Segoe Script", Georgia, cursive';
  if (fontKey === 'mono') return '"Courier New", monospace';
  return 'Arial, Helvetica, sans-serif';
}

/** Renders a layout_snapshot onto a canvas (used for preview & high-res download). */
export async function renderSnapshotToCanvas(snap, bgImage = null) {
  const W = Number(snap.width) || 2000;
  const H = Number(snap.height) || 1414;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, W, H);
  } else {
    drawDefaultBackgroundOnCanvas(ctx, W, H);
  }

  const values = snap.values || {};
  const fields = Array.isArray(snap.fields) ? snap.fields : DEFAULT_LAYOUT;

  for (const f of fields) {
    const type = String(f.type || '');
    const bx = Number(f.x) || 0;
    const by = Number(f.y) || 0;
    const bw = Number(f.width) || 400;
    const bh = Number(f.height) || 50;

    if (type === 'qr_code') {
      const code = values.certificate_id || values.qr_code || 'CERT-2026-SAMPLE';
      const verifyUrl = `${location.origin}/verify/${encodeURIComponent(code)}`;
      const qrUrl = await QRCode.toDataURL(verifyUrl, { width: Math.max(bw, 220), margin: 1 });
      const qrImg = await loadImg(qrUrl);
      if (qrImg) ctx.drawImage(qrImg, bx, by, bw, bh);
      continue;
    }

    const rawText = String(values[type] ?? '').trim();
    if (!rawText) continue;

    const weight = (type === 'participant_name' || type === 'event_name' || type.endsWith('_name')) ? 'bold ' : '';
    const style = f.font === 'script' ? 'italic ' : '';
    const family = cssFontFamily(f.font);
    let size = Number(f.size) || 28;

    ctx.font = `${style}${weight}${size}px ${family}`;
    if (f.auto_shrink !== false) {
      while (size > 11 && ctx.measureText(rawText).width > bw - 16) {
        size -= 1;
        ctx.font = `${style}${weight}${size}px ${family}`;
      }
    }

    ctx.fillStyle = f.color || '#1c1917';
    ctx.textBaseline = 'middle';
    const align = f.alignment || 'center';
    ctx.textAlign = align;
    const tx = align === 'left' ? bx + 6 : align === 'right' ? bx + bw - 6 : bx + bw / 2;
    ctx.fillText(rawText, tx, by + bh / 2);
  }

  return c;
}

function loadImg(src) {
  return new Promise(resolve => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function loadTemplateBackgroundImage(filePath, mimeType) {
  if (!filePath || mimeType === 'system/default' || mimeType === 'application/pdf') return null;
  const { data } = await supabase.storage.from('certificate-templates').createSignedUrl(filePath, 300);
  if (!data?.signedUrl) return null;
  return loadImg(data.signedUrl);
}

/** Generates an A4 landscape PDF byte array using pdf-lib with embedded standard fonts. */
export async function generateCertificatePdfBytes(cert) {
  const snap = cert.layout_snapshot || {};
  const W = Number(snap.width) || 2000;
  const H = Number(snap.height) || 1414;
  const values = snap.values || {};
  const fields = Array.isArray(snap.fields) ? snap.fields : DEFAULT_LAYOUT;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([W, H]);

  const fontSerifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontSerifItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const fontSans = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSansBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const parseHex = hex => {
    const m = String(hex || '#1c1917').replace('#', '');
    const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16) || 0;
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  let drewBg = false;
  if (snap.file_path && snap.mime_type !== 'system/default') {
    const { data: blob } = await supabase.storage.from('certificate-templates').download(snap.file_path);
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (snap.mime_type === 'application/pdf') {
        const tplPdf = await PDFDocument.load(bytes);
        const [embeddedPage] = await pdfDoc.embedPdf(tplPdf, [0]);
        page.drawPage(embeddedPage, { x: 0, y: 0, width: W, height: H });
        drewBg = true;
      } else {
        const img = snap.mime_type === 'image/png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        page.drawImage(img, { x: 0, y: 0, width: W, height: H });
        drewBg = true;
      }
    }
  }

  if (!drewBg) {
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = W;
    bgCanvas.height = H;
    drawDefaultBackgroundOnCanvas(bgCanvas.getContext('2d'), W, H);
    const bgB64 = bgCanvas.toDataURL('image/png').split(',')[1];
    const bgBytes = Uint8Array.from(atob(bgB64), ch => ch.charCodeAt(0));
    const bgImg = await pdfDoc.embedPng(bgBytes);
    page.drawImage(bgImg, { x: 0, y: 0, width: W, height: H });
  }

  for (const f of fields) {
    const type = String(f.type || '');
    const bx = Number(f.x) || 0;
    const by = Number(f.y) || 0;
    const bw = Number(f.width) || 400;
    const bh = Number(f.height) || 50;

    if (type === 'qr_code') {
      const verifyUrl = `${location.origin}/verify/${encodeURIComponent(cert.certificate_code)}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: Math.max(bw, 220), margin: 1 });
      const qrBytes = Uint8Array.from(atob(qrDataUrl.split(',')[1]), ch => ch.charCodeAt(0));
      const qrImg = await pdfDoc.embedPng(qrBytes);
      page.drawImage(qrImg, { x: bx, y: H - by - bh, width: bw, height: bh });
      continue;
    }

    const rawText = String(values[type] ?? '').trim();
    if (!rawText) continue;

    const font = f.font === 'serif' ? fontSerifBold
      : f.font === 'script' ? fontSerifItalic
        : f.font === 'mono' ? fontMono
          : (type === 'participant_name' || type === 'event_name' || type.endsWith('_name') ? fontSansBold : fontSans);

    let fontSize = Number(f.size) || 28;
    if (f.auto_shrink !== false) {
      while (fontSize > 10 && font.widthOfTextAtSize(rawText, fontSize) > bw - 14) {
        fontSize -= 1;
      }
    }

    const tw = font.widthOfTextAtSize(rawText, fontSize);
    const tx = f.alignment === 'left' ? bx + 4
      : f.alignment === 'right' ? bx + Math.max(bw - tw - 4, 0)
        : bx + Math.max((bw - tw) / 2, 0);
    const ty = H - by - (bh + fontSize * 0.72) / 2;

    page.drawText(rawText, {
      x: tx,
      y: ty,
      size: fontSize,
      font,
      color: parseHex(f.color || '#1c1917')
    });
  }

  return pdfDoc.save();
}

/**
 * Issues (or retrieves) the participant's certificate via transactional RPC
 * and opens the Certificate preview + PDF download modal.
 */
export async function openCertificateModal({ eventId }) {
  let dlg = document.getElementById('certDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'certDlg';
    dlg.style.width = 'min(780px, 96vw)';
    dlg.style.textAlign = 'center';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }
  dlg.innerHTML = '<p class="muted" style="padding:1.5rem">Preparing your certificate...</p>';
  if (!dlg.open) dlg.showModal();

  const { data: cert, error } = await supabase.rpc('issue_my_certificate', { p_event_id: eventId });
  if (error) {
    dlg.close();
    toast(errMsg(error), 'error');
    return;
  }

  const snap = cert.layout_snapshot || {};
  const bgImg = await loadTemplateBackgroundImage(snap.file_path, snap.mime_type);
  const canvas = await renderSnapshotToCanvas(snap, bgImg);
  const previewUrl = canvas.toDataURL('image/png');
  const verifyPath = `/verify/${encodeURIComponent(cert.certificate_code)}`;

  dlg.innerHTML = `
    <div class="pagehead" style="margin-bottom:.65rem;text-align:left">
      <div>
        <h2 style="margin:0">${esc(CERTIFICATE_TITLE)}</h2>
        <p class="muted sm" style="margin:.15rem 0 0">${esc(cert.event_name_at_issuance)} · ID: <code>${esc(cert.certificate_code)}</code></p>
      </div>
      <a class="btn ghost sm" href="${verifyPath}" target="_blank" rel="noopener">Verify page</a>
    </div>
    <div style="background:#111;padding:.5rem;border-radius:10px;border:1px solid var(--line)">
      <img src="${previewUrl}" alt="${esc(CERTIFICATE_TITLE)}" style="width:100%;height:auto;border-radius:6px;display:block">
    </div>
    <div class="row" style="justify-content:center;margin-top:.9rem;gap:.5rem">
      <button type="button" class="btn" id="certDlPdf">Download PDF</button>
      <button type="button" class="btn ghost" id="certDlPng">Download PNG</button>
      <button type="button" class="btn ghost" id="certClose">Close</button>
    </div>`;

  dlg.querySelector('#certClose').onclick = () => dlg.close();
  dlg.querySelector('#certDlPng').onclick = () => {
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = `${cert.certificate_code}.png`;
    a.click();
  };
  dlg.querySelector('#certDlPdf').onclick = async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Generating PDF...';
    try {
      const pdfBytes = await generateCertificatePdfBytes(cert);
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cert.certificate_code}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download PDF';
    }
  };
}

/**
 * Interactive Certificate Template Upload & Field Placement Editor Modal.
 */
export async function openTemplateEditorModal({ profile, initialTemplate = null, onSaved = null }) {
  let dlg = document.getElementById('tplEditorDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'tplEditorDlg';
    dlg.style.width = 'min(1040px, 98vw)';
    dlg.style.maxHeight = '94vh';
    dlg.style.overflow = 'auto';
    document.body.appendChild(dlg);
  }

  let tpl = initialTemplate ? structuredClone(initialTemplate) : {
    id: null,
    name: '',
    file_path: null,
    mime_type: 'system/default',
    width: 2000,
    height: 1414,
    is_global: profile.role === 'admin',
    is_active: true,
    layout: structuredClone(DEFAULT_LAYOUT)
  };
  let pendingFile = null;
  let bgPreviewUrl = null;
  let selectedIdx = 0;
  let useLongSample = false;

  if (tpl.file_path && tpl.mime_type !== 'system/default' && tpl.mime_type !== 'application/pdf') {
    const { data } = await supabase.storage.from('certificate-templates').createSignedUrl(tpl.file_path, 300);
    bgPreviewUrl = data?.signedUrl || null;
  }

  dlg.innerHTML = `
    <div class="pagehead" style="margin-bottom:.75rem">
      <div>
        <h2 style="margin:0">${tpl.id ? 'Edit Certificate Template' : 'New Certificate Template'}</h2>
        <p class="muted sm" style="margin:.15rem 0 0">Upload a blank design (without participant details) and drag or resize the field boxes below. Certificate ID and QR code are required.</p>
      </div>
      <div class="row">
        <button type="button" class="btn ghost sm" id="tplDlSample">Download blank sample design</button>
        <button type="button" class="btn ghost sm" id="tplToggleSample">Preview: Standard sample</button>
      </div>
    </div>
    <div class="two" style="margin-bottom:.75rem">
      <div>
        <label for="tplName">Template name</label>
        <input id="tplName" required minlength="2" placeholder="e.g., College of Engineering 2026 Certificate" value="${esc(tpl.name)}">
      </div>
      <div>
        <label for="tplFile">Background design (PNG, JPG, or 1-page PDF · max 10 MB)</label>
        <input id="tplFile" type="file" accept="image/png,image/jpeg,application/pdf">
        <p class="muted sm" id="tplFileWarn" style="margin:.2rem 0 0;color:#f59e0b"></p>
      </div>
    </div>
    ${profile.role === 'admin' ? `<div class="row" style="margin-bottom:.75rem;gap:1rem">
      <label class="check" style="margin:0"><input type="checkbox" id="tplGlobal" ${tpl.is_global ? 'checked' : ''}> <span>Global template (available to all organizers)</span></label>
      <label class="check" style="margin:0"><input type="checkbox" id="tplActive" ${tpl.is_active !== false ? 'checked' : ''}> <span>Active</span></label>
    </div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 290px;gap:1rem;align-items:start">
      <div>
        <div id="tplStageWrap" style="position:relative;width:100%;aspect-ratio:${tpl.width}/${tpl.height};background:#fdfbf7;border:1px solid var(--line);border-radius:8px;overflow:hidden;user-select:none">
          <canvas id="tplBgCanvas" width="${tpl.width}" height="${tpl.height}" style="width:100%;height:100%;display:block"></canvas>
          <div id="tplBoxesLayer" style="position:absolute;inset:0"></div>
        </div>
      </div>
      <div class="card" style="padding:.85rem">
        <h3 style="margin:0 0 .5rem;font-size:.95rem">Field Placement</h3>
        <div class="row" style="margin-bottom:.6rem">
          <select id="tplAddField" style="flex:1">
            ${ALLOWED_FIELD_DEFS.map(d => `<option value="${d.type}">${esc(d.label)}</option>`).join('')}
          </select>
          <button type="button" class="btn sm ghost" id="tplAddFieldBtn">+ Add</button>
        </div>
        <div id="tplPropPanel"></div>
      </div>
    </div>

    <div class="row" style="justify-content:flex-end;margin-top:1rem;gap:.5rem">
      <button type="button" class="btn ghost" id="tplCancelBtn">Cancel</button>
      <button type="button" class="btn" id="tplSaveBtn">Save template</button>
    </div>`;

  if (!dlg.open) dlg.showModal();

  const stageWrap = dlg.querySelector('#tplStageWrap');
  const bgCanvas = dlg.querySelector('#tplBgCanvas');
  const boxesLayer = dlg.querySelector('#tplBoxesLayer');
  const propPanel = dlg.querySelector('#tplPropPanel');

  async function drawBg() {
    bgCanvas.width = tpl.width;
    bgCanvas.height = tpl.height;
    stageWrap.style.aspectRatio = `${tpl.width}/${tpl.height}`;
    const ctx = bgCanvas.getContext('2d');
    if (bgPreviewUrl) {
      const img = await loadImg(bgPreviewUrl);
      if (img) { ctx.drawImage(img, 0, 0, tpl.width, tpl.height); return; }
    }
    drawDefaultBackgroundOnCanvas(ctx, tpl.width, tpl.height);
  }

  function renderBoxes() {
    const sample = useLongSample ? SAMPLE_DATA_LONG : SAMPLE_DATA_NORMAL;
    boxesLayer.innerHTML = tpl.layout.map((f, idx) => {
      const leftPct = (f.x / tpl.width) * 100;
      const topPct = (f.y / tpl.height) * 100;
      const wPct = (f.width / tpl.width) * 100;
      const hPct = (f.height / tpl.height) * 100;
      const isSel = idx === selectedIdx;
      const txt = f.type === 'qr_code' ? '[QR CODE]' : (sample[f.type] || f.type);
      return `<div data-box="${idx}" style="position:absolute;left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;border:2px ${isSel ? 'solid #ef4444' : 'dashed rgba(153,27,27,.65)'};background:${isSel ? 'rgba(239,68,68,.14)' : 'rgba(255,255,255,.45)'};color:${esc(f.color || '#1c1917')};display:flex;align-items:center;justify-content:${f.alignment === 'left' ? 'flex-start' : f.alignment === 'right' ? 'flex-end' : 'center'};padding:2px 6px;font-family:${cssFontFamily(f.font)};font-size:clamp(9px,1.1vw,15px);font-weight:700;cursor:move;box-sizing:border-box;overflow:hidden;white-space:nowrap">
        <span style="pointer-events:none;overflow:hidden;text-overflow:ellipsis">${esc(txt)}</span>
        <span data-resize="${idx}" style="position:absolute;right:0;bottom:0;width:12px;height:12px;background:#ef4444;cursor:nwse-resize"></span>
      </div>`;
    }).join('');
    renderProps();
  }

  function renderProps() {
    const f = tpl.layout[selectedIdx];
    if (!f) { propPanel.innerHTML = '<p class="muted sm">Select a box on the canvas.</p>'; return; }
    const def = ALLOWED_FIELD_DEFS.find(d => d.type === f.type);
    const isMandatory = def?.mandatory;
    propPanel.innerHTML = `
      <div class="sm" style="margin-bottom:.45rem"><b>${esc(def?.label || f.type)}</b></div>
      <div class="two">
        <div><label>Font</label>
          <select id="pFont">
            <option value="serif" ${f.font === 'serif' ? 'selected' : ''}>Serif</option>
            <option value="sans" ${f.font === 'sans' ? 'selected' : ''}>Sans-serif</option>
            <option value="script" ${f.font === 'script' ? 'selected' : ''}>Script</option>
            <option value="mono" ${f.font === 'mono' ? 'selected' : ''}>Monospace</option>
          </select>
        </div>
        <div><label>Size (px)</label><input id="pSize" type="number" min="10" max="120" value="${Number(f.size) || 28}"></div>
        <div><label>Color</label><input id="pColor" type="color" value="${esc(f.color || '#1c1917')}"></div>
        <div><label>Align</label>
          <select id="pAlign">
            <option value="left" ${f.alignment === 'left' ? 'selected' : ''}>Left</option>
            <option value="center" ${(!f.alignment || f.alignment === 'center') ? 'selected' : ''}>Center</option>
            <option value="right" ${f.alignment === 'right' ? 'selected' : ''}>Right</option>
          </select>
        </div>
      </div>
      <label class="check" style="margin-top:.45rem"><input type="checkbox" id="pShrink" ${f.auto_shrink !== false ? 'checked' : ''}> <span>Auto-shrink to fit long text</span></label>
      <button type="button" class="btn sm danger" id="pRemoveBox" style="margin-top:.6rem;width:100%" ${isMandatory ? 'disabled title="Required field cannot be removed"' : ''}>
        ${isMandatory ? 'Required field (cannot delete)' : 'Remove field box'}
      </button>`;

    propPanel.querySelector('#pFont').onchange = e => { f.font = e.target.value; renderBoxes(); };
    propPanel.querySelector('#pSize').oninput = e => { f.size = Number(e.target.value) || 28; };
    propPanel.querySelector('#pColor').oninput = e => { f.color = e.target.value; renderBoxes(); };
    propPanel.querySelector('#pAlign').onchange = e => { f.alignment = e.target.value; renderBoxes(); };
    propPanel.querySelector('#pShrink').onchange = e => { f.auto_shrink = e.target.checked; };
    propPanel.querySelector('#pRemoveBox').onclick = () => {
      if (isMandatory) return;
      tpl.layout.splice(selectedIdx, 1);
      selectedIdx = Math.max(0, selectedIdx - 1);
      renderBoxes();
    };
  }

  // Drag & resize interaction on boxesLayer
  let dragState = null;
  boxesLayer.onpointerdown = ev => {
    const resizeEl = ev.target.closest('[data-resize]');
    const boxEl = ev.target.closest('[data-box]');
    if (!boxEl) return;
    selectedIdx = Number(boxEl.dataset.box);
    const f = tpl.layout[selectedIdx];
    const rect = stageWrap.getBoundingClientRect();
    dragState = {
      mode: resizeEl ? 'resize' : 'move',
      startX: ev.clientX,
      startY: ev.clientY,
      origX: f.x,
      origY: f.y,
      origW: f.width,
      origH: f.height,
      scaleX: tpl.width / rect.width,
      scaleY: tpl.height / rect.height,
      f
    };
    boxesLayer.setPointerCapture(ev.pointerId);
    renderBoxes();
  };
  boxesLayer.onpointermove = ev => {
    if (!dragState) return;
    const dx = (ev.clientX - dragState.startX) * dragState.scaleX;
    const dy = (ev.clientY - dragState.startY) * dragState.scaleY;
    const f = dragState.f;
    if (dragState.mode === 'move') {
      f.x = Math.round(Math.max(0, Math.min(tpl.width - f.width, dragState.origX + dx)));
      f.y = Math.round(Math.max(0, Math.min(tpl.height - f.height, dragState.origY + dy)));
    } else {
      f.width = Math.round(Math.max(80, Math.min(tpl.width - f.x, dragState.origW + dx)));
      f.height = Math.round(Math.max(28, Math.min(tpl.height - f.y, dragState.origH + dy)));
    }
    renderBoxes();
  };
  boxesLayer.onpointerup = () => { dragState = null; };

  dlg.querySelector('#tplAddFieldBtn').onclick = () => {
    const type = dlg.querySelector('#tplAddField').value;
    const existing = tpl.layout.findIndex(x => x.type === type);
    if (existing >= 0) {
      selectedIdx = existing;
      renderBoxes();
      return toast('Field is already on the canvas (selected)', 'info');
    }
    tpl.layout.push({
      type, x: 400, y: 400, width: type === 'qr_code' ? 180 : 900, height: type === 'qr_code' ? 180 : 50,
      font: 'sans', size: 28, color: '#1c1917', alignment: 'center', auto_shrink: true
    });
    selectedIdx = tpl.layout.length - 1;
    renderBoxes();
  };

  dlg.querySelector('#tplDlSample').onclick = downloadBlankSampleDesign;
  dlg.querySelector('#tplToggleSample').onclick = e => {
    useLongSample = !useLongSample;
    e.currentTarget.textContent = useLongSample ? 'Preview: Long name & event' : 'Preview: Standard sample';
    renderBoxes();
  };

  dlg.querySelector('#tplFile').onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const v = await validateTemplateFile(file);
    const warnEl = dlg.querySelector('#tplFileWarn');
    if (!v.ok) {
      warnEl.textContent = v.error;
      toast(v.error, 'error');
      e.target.value = '';
      return;
    }
    warnEl.textContent = v.warning || '';
    pendingFile = { file, ...v };
    tpl.width = v.width;
    tpl.height = v.height;
    tpl.mime_type = v.mime;
    if (v.mime !== 'application/pdf') {
      if (bgPreviewUrl && bgPreviewUrl.startsWith('blob:')) URL.revokeObjectURL(bgPreviewUrl);
      bgPreviewUrl = URL.createObjectURL(file);
    }
    await drawBg();
    renderBoxes();
  };

  dlg.querySelector('#tplCancelBtn').onclick = () => dlg.close();
  dlg.querySelector('#tplSaveBtn').onclick = async e => {
    const btn = e.currentTarget;
    const name = dlg.querySelector('#tplName').value.trim();
    if (name.length < 2) return toast('Enter a template name', 'error');
    const hasId = tpl.layout.some(x => x.type === 'certificate_id');
    const hasQr = tpl.layout.some(x => x.type === 'qr_code');
    if (!hasId || !hasQr) {
      return toast('Certificate ID and QR code boxes are mandatory and must be placed', 'error');
    }

    btn.disabled = true;
    try {
      let filePath = tpl.file_path;
      let mimeType = tpl.mime_type || 'system/default';
      if (pendingFile) {
        filePath = `${profile.id}/${crypto.randomUUID()}.${pendingFile.ext}`;
        const { error: upErr } = await supabase.storage
          .from('certificate-templates')
          .upload(filePath, pendingFile.file, { contentType: pendingFile.mime, upsert: false });
        if (upErr) throw upErr;
        mimeType = pendingFile.mime;
      }

      const payload = {
        name,
        file_path: filePath,
        mime_type: mimeType,
        width: tpl.width,
        height: tpl.height,
        layout: tpl.layout,
        is_global: profile.role === 'admin' ? !!dlg.querySelector('#tplGlobal')?.checked : false,
        is_active: profile.role === 'admin' ? !!dlg.querySelector('#tplActive')?.checked : true
      };

      const q = tpl.id && tpl.id !== DEFAULT_TEMPLATE_ID
        ? supabase.from('certificate_templates').update(payload).eq('id', tpl.id).select('*').single()
        : supabase.from('certificate_templates').insert({ ...payload, owner_id: profile.id }).select('*').single();

      const { data: saved, error } = await q;
      if (error) throw error;
      toast('Certificate template saved', 'success');
      dlg.close();
      onSaved?.(saved);
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      btn.disabled = false;
    }
  };

  await drawBg();
  renderBoxes();
}
