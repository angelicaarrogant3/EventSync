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

export const SIMPLE_UPLOAD_LAYOUT = [
  { type: 'participant_name', x: 300, y: 620, width: 1400, height: 100, font: 'script', size: 68, color: '#991b1b', alignment: 'center', auto_shrink: true },
  { type: 'certificate_id', x: 1560, y: 1320, width: 380, height: 34, font: 'mono', size: 18, color: '#44403c', alignment: 'center', auto_shrink: true },
  { type: 'qr_code', x: 1680, y: 1145, width: 165, height: 165, font: 'sans', size: 16, color: '#000000', alignment: 'center', auto_shrink: false }
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

const QR_CORNER_PRESETS = {
  'bottom-right': {
    qr: { x: 1700, y: 1125, width: 155, height: 155 },
    id: { x: 1560, y: 1290, width: 390, height: 32 }
  },
  'bottom-left': {
    qr: { x: 145, y: 1125, width: 155, height: 155 },
    id: { x: 100, y: 1290, width: 390, height: 32 }
  },
  'bottom-center': {
    qr: { x: 922, y: 1125, width: 155, height: 155 },
    id: { x: 700, y: 1290, width: 600, height: 32 }
  }
};

/**
 * One-Click Certificate Template Upload & Name Placement Editor Modal.
 */
export async function openTemplateEditorModal({ profile, initialTemplate = null, onSaved = null }) {
  let dlg = document.getElementById('tplEditorDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'tplEditorDlg';
    dlg.style.width = 'min(1020px, 98vw)';
    dlg.style.maxHeight = '94vh';
    dlg.style.overflow = 'auto';
    document.body.appendChild(dlg);
  }

  const isCustomInit = initialTemplate && initialTemplate.id !== DEFAULT_TEMPLATE_ID;
  let tpl = isCustomInit ? structuredClone(initialTemplate) : {
    id: null,
    name: '',
    file_path: null,
    mime_type: 'system/default',
    width: 2000,
    height: 1414,
    is_global: profile.role === 'admin',
    is_active: true,
    layout: structuredClone(SIMPLE_UPLOAD_LAYOUT)
  };
  tpl.width = 2000;
  tpl.height = 1414;

  let nameBox = (tpl.layout || []).find(f => f.type === 'participant_name') || {
    type: 'participant_name', x: 300, y: 610, width: 1400, height: 100,
    font: 'script', size: 68, color: '#991b1b', alignment: 'center', auto_shrink: true
  };
  let qrCorner = 'bottom-right';
  const existingQr = (tpl.layout || []).find(f => f.type === 'qr_code');
  if (existingQr) {
    if (existingQr.x < 500) qrCorner = 'bottom-left';
    else if (existingQr.x < 1200) qrCorner = 'bottom-center';
  }

  let pendingFile = null;
  let bgImageObj = null;
  let useLongSample = false;

  if (tpl.file_path && tpl.mime_type !== 'system/default' && tpl.mime_type !== 'application/pdf') {
    const { data } = await supabase.storage.from('certificate-templates').createSignedUrl(tpl.file_path, 300);
    if (data?.signedUrl) bgImageObj = await loadImg(data.signedUrl);
  }

  function buildCleanLayout() {
    const corner = QR_CORNER_PRESETS[qrCorner] || QR_CORNER_PRESETS['bottom-right'];
    return [
      { ...nameBox, type: 'participant_name', auto_shrink: true },
      { type: 'certificate_id', ...corner.id, font: 'mono', size: 18, color: '#44403c', alignment: 'center', auto_shrink: true },
      { type: 'qr_code', ...corner.qr, font: 'sans', size: 16, color: '#000000', alignment: 'center', auto_shrink: false }
    ];
  }

  const centerX = () => Math.round((nameBox.x + nameBox.width / 2) / 20);
  const centerY = () => Math.round((nameBox.y + nameBox.height / 2) / 14.14);
  const hasSavedFile = !!(tpl.file_path && tpl.mime_type !== 'system/default');

  dlg.innerHTML = `
    <div class="pagehead" style="margin-bottom:.65rem">
      <div>
        <h2 style="margin:0">${tpl.id ? 'Edit Certificate Design' : 'Upload Certificate Design'}</h2>
        <p class="muted sm" style="margin:.15rem 0 0"><b>Reminder:</b> Upload your complete certificate image (with event title, date, venue, and signatures already included) and leave <b>only the Participant's Name blank</b>. Click on the blank line below to position the participant's name.</p>
      </div>
      <div class="row">
        <button type="button" class="btn ghost sm" id="tplDlSample">Download blank sample</button>
        <button type="button" class="btn ghost sm" id="tplToggleSample">Test: Normal name</button>
      </div>
    </div>
    <div class="two" style="margin-bottom:.75rem">
      <div>
        <label for="tplName">Template name</label>
        <input id="tplName" required minlength="2" placeholder="e.g., Seminar 2026 Certificate" value="${esc(tpl.name)}">
      </div>
      <div>
        <label for="tplFile">${hasSavedFile ? 'Replace certificate image (optional)' : 'Upload certificate image (PNG, JPG, or 1-page PDF · max 10 MB)'}</label>
        ${hasSavedFile ? `<p class="sm" id="tplSavedFileStatus" style="margin:.15rem 0 .35rem;color:#22c55e"><b>✓ Certificate image already uploaded</b> — choose a file below only if you want to replace it.</p>` : ''}
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
        <div id="tplStageWrap" title="Click anywhere on the certificate to place the Participant Name here" style="position:relative;width:100%;aspect-ratio:2000/1414;background:#fdfbf7;border:2px solid var(--line);border-radius:10px;overflow:hidden;cursor:crosshair;user-select:none">
          <canvas id="tplBgCanvas" width="2000" height="1414" style="width:100%;height:100%;display:block"></canvas>
        </div>
        <p class="muted sm" style="margin:.4rem 0 0;text-align:center">Tip: Click or drag anywhere on the certificate preview to move the Participant Name.</p>
      </div>

      <div class="card" style="padding:.9rem">
        <h3 style="margin:0 0 .65rem;font-size:.98rem">Participant Name Style</h3>

        <label for="pPosY">Vertical Position (Up ↔ Down): <b id="pPosYVal">${centerY()}%</b></label>
        <input id="pPosY" type="range" min="15" max="85" step="1" value="${centerY()}">

        <div class="row" style="justify-content:space-between;margin-top:.45rem">
          <label for="pPosX" style="margin:0">Horizontal: <b id="pPosXVal">${centerX()}%</b></label>
          <button type="button" class="btn ghost sm" id="pCenterBtn" style="padding:.15rem .5rem;font-size:.75rem">Center</button>
        </div>
        <input id="pPosX" type="range" min="20" max="80" step="1" value="${centerX()}">

        <label for="pFont" style="margin-top:.55rem">Font Style</label>
        <select id="pFont">
          <option value="script" ${nameBox.font === 'script' ? 'selected' : ''}>Script (Cursive)</option>
          <option value="serif" ${nameBox.font === 'serif' ? 'selected' : ''}>Serif (Formal)</option>
          <option value="sans" ${nameBox.font === 'sans' ? 'selected' : ''}>Sans-serif (Modern)</option>
        </select>

        <label for="pSize" style="margin-top:.55rem">Font Size: <b id="pSizeVal">${Number(nameBox.size) || 68}px</b></label>
        <input id="pSize" type="range" min="28" max="110" step="2" value="${Number(nameBox.size) || 68}">

        <label for="pColor" style="margin-top:.55rem">Text Color</label>
        <div class="row" style="gap:.4rem;align-items:center">
          <input id="pColor" type="color" value="${esc(nameBox.color || '#991b1b')}" style="width:46px;height:34px;padding:2px">
          <button type="button" class="btn ghost sm" data-swatch="#1c1917" style="padding:.25rem .5rem">Black</button>
          <button type="button" class="btn ghost sm" data-swatch="#991b1b" style="padding:.25rem .5rem">Crimson</button>
          <button type="button" class="btn ghost sm" data-swatch="#1e3a8a" style="padding:.25rem .5rem">Navy</button>
          <button type="button" class="btn ghost sm" data-swatch="#92400e" style="padding:.25rem .5rem">Gold</button>
        </div>

        <div style="margin-top:.85rem;padding-top:.75rem;border-top:1px solid var(--line)">
          <label for="pQrCorner">Verification QR &amp; ID Stamp</label>
          <select id="pQrCorner">
            <option value="bottom-right" ${qrCorner === 'bottom-right' ? 'selected' : ''}>Bottom-Right Corner</option>
            <option value="bottom-left" ${qrCorner === 'bottom-left' ? 'selected' : ''}>Bottom-Left Corner</option>
            <option value="bottom-center" ${qrCorner === 'bottom-center' ? 'selected' : ''}>Bottom-Center</option>
          </select>
        </div>
      </div>
    </div>

    <div class="row" style="justify-content:space-between;align-items:center;margin-top:1rem;gap:.75rem">
      <span id="tplSaveErr" role="alert" style="color:#fca5a5;font-size:.85rem"></span>
      <div class="row" style="gap:.5rem">
        <button type="button" class="btn ghost" id="tplCancelBtn">Cancel</button>
        <button type="button" class="btn" id="tplSaveBtn">Save template</button>
      </div>
    </div>`;

  if (!dlg.open) dlg.showModal();

  const stageWrap = dlg.querySelector('#tplStageWrap');
  const bgCanvas = dlg.querySelector('#tplBgCanvas');
  let renderPending = false;

  async function refreshPreview() {
    if (renderPending) return;
    renderPending = true;
    try {
      tpl.layout = buildCleanLayout();
      const sample = useLongSample ? SAMPLE_DATA_LONG : SAMPLE_DATA_NORMAL;
      const rendered = await renderSnapshotToCanvas({
        width: 2000,
        height: 1414,
        fields: tpl.layout,
        values: sample
      }, bgImageObj);
      const ctx = bgCanvas.getContext('2d');
      ctx.clearRect(0, 0, 2000, 1414);
      ctx.drawImage(rendered, 0, 0);

      ctx.save();
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.strokeRect(nameBox.x, nameBox.y, nameBox.width, nameBox.height);
      ctx.restore();
    } finally {
      renderPending = false;
    }
  }

  function moveNameToPercent(px, py) {
    const clampedX = Math.max(15, Math.min(85, Math.round(px)));
    const clampedY = Math.max(12, Math.min(88, Math.round(py)));
    nameBox.x = Math.round((clampedX / 100) * 2000 - nameBox.width / 2);
    nameBox.y = Math.round((clampedY / 100) * 1414 - nameBox.height / 2);
    dlg.querySelector('#pPosX').value = clampedX;
    dlg.querySelector('#pPosXVal').textContent = `${clampedX}%`;
    dlg.querySelector('#pPosY').value = clampedY;
    dlg.querySelector('#pPosYVal').textContent = `${clampedY}%`;
    refreshPreview();
  }

  let pointerDown = false;
  const handleStagePointer = ev => {
    const rect = stageWrap.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * 100;
    const py = ((ev.clientY - rect.top) / rect.height) * 100;
    moveNameToPercent(px, py);
  };
  stageWrap.onpointerdown = ev => {
    pointerDown = true;
    stageWrap.setPointerCapture(ev.pointerId);
    handleStagePointer(ev);
  };
  stageWrap.onpointermove = ev => { if (pointerDown) handleStagePointer(ev); };
  stageWrap.onpointerup = () => { pointerDown = false; };

  dlg.querySelector('#pPosY').oninput = e => moveNameToPercent(centerX(), Number(e.target.value));
  dlg.querySelector('#pPosX').oninput = e => moveNameToPercent(Number(e.target.value), centerY());
  dlg.querySelector('#pCenterBtn').onclick = () => moveNameToPercent(50, centerY());
  dlg.querySelector('#pFont').onchange = e => { nameBox.font = e.target.value; refreshPreview(); };
  dlg.querySelector('#pSize').oninput = e => {
    nameBox.size = Number(e.target.value) || 68;
    dlg.querySelector('#pSizeVal').textContent = `${nameBox.size}px`;
    refreshPreview();
  };
  dlg.querySelector('#pColor').oninput = e => { nameBox.color = e.target.value; refreshPreview(); };
  dlg.querySelectorAll('[data-swatch]').forEach(btn => {
    btn.onclick = () => {
      nameBox.color = btn.dataset.swatch;
      dlg.querySelector('#pColor').value = nameBox.color;
      refreshPreview();
    };
  });
  dlg.querySelector('#pQrCorner').onchange = e => { qrCorner = e.target.value; refreshPreview(); };

  dlg.querySelector('#tplDlSample').onclick = downloadBlankSampleDesign;
  dlg.querySelector('#tplToggleSample').onclick = e => {
    useLongSample = !useLongSample;
    e.currentTarget.textContent = useLongSample ? 'Test: Very long name' : 'Test: Normal name';
    refreshPreview();
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
    tpl.mime_type = v.mime;
    if (!dlg.querySelector('#tplName').value.trim()) {
      dlg.querySelector('#tplName').value = file.name.replace(/\.[^.]+$/, '');
    }
    if (v.mime !== 'application/pdf') {
      const url = URL.createObjectURL(file);
      bgImageObj = await loadImg(url);
      URL.revokeObjectURL(url);
    }
    await refreshPreview();
  };

  dlg.querySelector('#tplCancelBtn').onclick = () => dlg.close();
  dlg.querySelector('#tplSaveBtn').onclick = async e => {
    const btn = e.currentTarget;
    const errEl = dlg.querySelector('#tplSaveErr');
    if (errEl) errEl.textContent = '';

    const nameInput = dlg.querySelector('#tplName');
    const name = nameInput.value.trim();
    if (name.length < 2) {
      if (errEl) errEl.textContent = 'Please enter a template name at the top first.';
      nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nameInput.focus();
      toast('Enter a template name', 'error');
      return;
    }

    tpl.layout = buildCleanLayout();
    btn.disabled = true;
    btn.textContent = 'Saving...';
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
        width: 2000,
        height: 1414,
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
      const msg = errMsg(err);
      if (errEl) errEl.textContent = msg;
      toast(msg, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save template';
    }
  };

  await refreshPreview();
}
