import { CONFIG } from '../config.js';

export const EVENT_IMAGES_BUCKET = 'event-images';
export const MAX_EVENT_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Sniff real image MIME type from magic bytes (rejects SVG, GIF, text renamed to .png, etc.). */
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}

/** Validate raw bytes + size. Returns { ok, mime } or { ok: false, status, error }. */
export function validateImageBuffer(bytes, totalSize = bytes?.byteLength ?? 0) {
  if (!totalSize || totalSize <= 0) {
    return { ok: false, status: 400, error: 'Image file is empty.' };
  }
  if (totalSize > MAX_EVENT_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'Image is too large. Maximum size is 5 MB.' };
  }
  const mime = sniffImageMime(bytes);
  if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) {
    return { ok: false, status: 415, error: 'Unsupported file type. Please choose a JPEG, PNG, or WebP image.' };
  }
  return { ok: true, mime };
}

/** Validate a browser File/Blob by size and magic bytes. */
export async function validateImageFile(file) {
  if (!file) return { ok: false, status: 400, error: 'No image selected.' };
  if (file.size > MAX_EVENT_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'Image is too large. Maximum size is 5 MB.' };
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return validateImageBuffer(head, file.size);
}

/** Prevent path traversal or unexpected characters in storage keys. */
export function isSafeImagePath(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('..') && !p.startsWith('/') && !p.includes('\\') && /^[a-zA-Z0-9._/-]+$/.test(p);
}

/** Server-safe unique storage filename; never uses the uploaded file's name. */
export function makeEventImagePath(eventId, mime) {
  const cleanId = String(eventId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36) || 'evt';
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
  const rand = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36))
    .replace(/-/g, '')
    .slice(0, 12);
  return `evt_${cleanId}_${rand}.${ext}`;
}

/** Build public cache-busted URL from events.image_path + image_updated_at, or null. */
export function eventImageUrl(ev, baseUrl = CONFIG.SUPABASE_URL) {
  const p = ev?.image_path;
  if (!p || !isSafeImagePath(p) || !baseUrl || baseUrl.includes('YOUR_')) return null;
  const ver = ev.image_updated_at ? new Date(ev.image_updated_at).getTime() : 0;
  const cleanBase = String(baseUrl).replace(/\/+$/, '');
  return `${cleanBase}/storage/v1/object/public/${EVENT_IMAGES_BUCKET}/${p}${ver ? `?v=${ver}` : ''}`;
}

/** Up to 2 uppercase initials from an event title. */
export function eventInitials(title) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'ES';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Render an event banner/thumbnail with 16:9 placeholder fallback (dark surface,
 * red gradient, low-opacity EventSync logo, event initials).
 * If the image is missing or fails to load (e.g. offline), falls back cleanly.
 */
export function eventBannerHtml(ev, { variant = 'card', alt } = {}) {
  const url = eventImageUrl(ev);
  const title = ev?.title || 'Event';
  const initials = escHtml(eventInitials(title));
  const ph = `<div class="evt-ph" aria-hidden="true"><img class="evt-ph-logo" src="/assets/logo.png" alt=""><span class="evt-ph-init">${initials}</span></div>`;
  const img = url
    ? `<img class="evt-img" src="${escHtml(url)}" alt="${escHtml(alt || title)}" loading="lazy" decoding="async" onerror="this.remove()">`
    : '';
  return `<div class="evt-media evt-media-${escHtml(variant)}">${ph}${img}</div>`;
}

/**
 * Client-side 16:9 crop + resize to max 1600px wide, re-encoded as WebP (fallback JPEG)
 * at quality 0.82. Re-encoding on canvas also strips EXIF metadata.
 */
export async function processEventImage(file, { zoom = 1, panX = 0.5, panY = 0.5, maxWidth = 1600, quality = 0.82 } = {}) {
  const check = await validateImageFile(file);
  if (!check.ok) {
    const err = new Error(check.error);
    err.status = check.status;
    throw err;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode image file.'));
      i.src = url;
    });
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const targetAspect = 16 / 9;

    // Base 16:9 crop fitting inside source image
    let baseW = sw;
    let baseH = sw / targetAspect;
    if (baseH > sh) {
      baseH = sh;
      baseW = sh * targetAspect;
    }
    const z = Math.max(1, Math.min(3, Number(zoom) || 1));
    const cropW = baseW / z;
    const cropH = baseH / z;
    const maxOffsetX = Math.max(0, sw - cropW);
    const maxOffsetY = Math.max(0, sh - cropH);
    const sx = Math.max(0, Math.min(maxOffsetX, maxOffsetX * (Number(panX) ?? 0.5)));
    const sy = Math.max(0, Math.min(maxOffsetY, maxOffsetY * (Number(panY) ?? 0.5)));

    const outW = Math.min(maxWidth, Math.max(320, Math.round(cropW)));
    const outH = Math.round(outW / targetAspect);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, outW, outH);

    let blob = await new Promise(res => canvas.toBlob(res, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') {
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    }
    if (!blob) throw new Error('Failed to encode image.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload an image to Supabase Storage, update events.image_path + image_updated_at, and delete old file. */
export async function uploadEventImage(supabase, eventId, blobOrBytes, oldImagePath = null) {
  let bytes;
  if (blobOrBytes instanceof Uint8Array) {
    bytes = blobOrBytes;
  } else if (typeof Blob !== 'undefined' && blobOrBytes instanceof Blob) {
    bytes = new Uint8Array(await blobOrBytes.arrayBuffer());
  } else if (blobOrBytes?.buffer) {
    bytes = new Uint8Array(blobOrBytes.buffer, blobOrBytes.byteOffset || 0, blobOrBytes.byteLength);
  } else {
    const err = new Error('Invalid image payload.');
    err.status = 400;
    throw err;
  }

  const check = validateImageBuffer(bytes, bytes.byteLength);
  if (!check.ok) {
    const err = new Error(check.error);
    err.status = check.status;
    throw err;
  }

  const path = makeEventImagePath(eventId, check.mime);
  const { error: upErr } = await supabase.storage
    .from(EVENT_IMAGES_BUCKET)
    .upload(path, bytes, { contentType: check.mime, cacheControl: '31536000', upsert: false });
  if (upErr) throw upErr;

  const updatedAt = new Date().toISOString();
  const { error: dbErr } = await supabase
    .from('events')
    .update({ image_path: path, image_updated_at: updatedAt })
    .eq('id', eventId);

  if (dbErr) {
    // Roll back uploaded file so no orphan/partial file remains
    await supabase.storage.from(EVENT_IMAGES_BUCKET).remove([path]).catch(() => {});
    throw dbErr;
  }

  if (oldImagePath && oldImagePath !== path && isSafeImagePath(oldImagePath)) {
    await supabase.storage.from(EVENT_IMAGES_BUCKET).remove([oldImagePath]).catch(() => {});
  }

  return {
    imagePath: path,
    imageUpdatedAt: updatedAt,
    imageUrl: eventImageUrl({ image_path: path, image_updated_at: updatedAt })
  };
}

/** Clear events.image_path and delete the file from Supabase Storage. */
export async function removeEventImage(supabase, eventId, oldImagePath) {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase
    .from('events')
    .update({ image_path: null, image_updated_at: updatedAt })
    .eq('id', eventId);
  if (error) throw error;

  if (oldImagePath && isSafeImagePath(oldImagePath)) {
    await supabase.storage.from(EVENT_IMAGES_BUCKET).remove([oldImagePath]).catch(() => {});
  }
  return { imagePath: null, imageUrl: null };
}

/** Delete an image file from storage (used when permanently deleting an event). */
export async function deleteEventStorageFile(supabase, imagePath) {
  if (!imagePath || !isSafeImagePath(imagePath)) return;
  await supabase.storage.from(EVENT_IMAGES_BUCKET).remove([imagePath]).catch(() => {});
}
