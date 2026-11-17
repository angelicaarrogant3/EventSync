// Single configuration & schedule-window module for EventSync.
// Shared by browser pages and Node tests. All event times use Asia/Manila (+08:00).

export const EVENT_TZ = 'Asia/Manila';
export const DEFAULT_EARLY_GRACE_MINUTES = 60;
export const DEFAULT_LATE_GRACE_MINUTES = 60;

const cleanSpaces = s => String(s ?? '').replace(/[\u202f\u00a0]/g, ' ');

/** Format a UTC Date/ISO string in Asia/Manila (e.g. "Nov 25, 2026, 7:00 AM"). */
export function formatManila(d) {
  if (!d) return '-';
  return cleanSpaces(new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(d)));
}

/** Convert a UTC Date/ISO string to "YYYY-MM-DDTHH:mm" in Asia/Manila for <input type="datetime-local">. */
export function toManilaInput(d) {
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(d));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const hh = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hh}:${map.minute}`;
}

/** Parse a <input type="datetime-local"> value as Asia/Manila (+08:00) and return UTC ISO string. */
export function parseManilaInput(localStr) {
  const s = String(localStr ?? '').trim();
  if (!s) return null;
  // Append +08:00 if no timezone offset is present
  const iso = /[Z+-]\d{2}:?\d{2}$|Z$/i.test(s) ? s : `${s}:00+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Compute attendance window state for an event at a given clock instant.
 * Returns { state: 'NOT_STARTED' | 'OPEN' | 'ENDED' | 'CANCELLED', opensAt, closesAt }.
 */
export function getAttendanceState(event, now = new Date()) {
  if (!event) return { state: 'CANCELLED', opensAt: null, closesAt: null };
  const earlyMin = Number.isFinite(Number(event.early_grace_minutes))
    ? Number(event.early_grace_minutes)
    : DEFAULT_EARLY_GRACE_MINUTES;
  const lateMin = Number.isFinite(Number(event.late_grace_minutes))
    ? Number(event.late_grace_minutes)
    : DEFAULT_LATE_GRACE_MINUTES;

  const starts = new Date(event.starts_at).getTime();
  const ends = new Date(event.ends_at).getTime();
  const opensAt = new Date(starts - earlyMin * 60_000);
  const closesAt = new Date(ends + lateMin * 60_000);
  const t = new Date(now).getTime();

  if (event.status === 'cancelled') {
    return { state: 'CANCELLED', opensAt, closesAt };
  }
  if (t < opensAt.getTime()) {
    return { state: 'NOT_STARTED', opensAt, closesAt };
  }
  if (t > closesAt.getTime()) {
    return { state: 'ENDED', opensAt, closesAt };
  }
  return { state: 'OPEN', opensAt, closesAt };
}

/**
 * Compute registration window state for an event at a given clock instant.
 * Returns { open, reason, opensAt, closesAt }.
 */
export function getRegistrationState(event, now = new Date()) {
  const t = new Date(now).getTime();
  if (!event || event.status !== 'published') {
    return { open: false, reason: 'Registration is closed for this event.' };
  }
  if (event.registration_opens_at) {
    const opens = new Date(event.registration_opens_at);
    if (t < opens.getTime()) {
      return { open: false, reason: `Registration opens on ${formatManila(opens)}.`, opensAt: opens };
    }
  }
  if (event.registration_deadline) {
    const dl = new Date(event.registration_deadline);
    if (t > dl.getTime()) {
      return { open: false, reason: 'Registration is closed.', closesAt: dl };
    }
  }
  if (new Date(event.ends_at).getTime() < t) {
    return { open: false, reason: 'This event has already ended.' };
  }
  return { open: true, reason: null };
}

/** Derived schedule status badge for admin/participant views. */
export function getDerivedEventStatus(event, now = new Date()) {
  if (!event) return { code: 'closed', label: 'Closed' };
  if (event.status === 'cancelled') return { code: 'cancelled', label: 'Cancelled' };
  if (event.status === 'draft') return { code: 'draft', label: 'Draft' };
  const t = new Date(now).getTime();
  const att = getAttendanceState(event, now);
  if (att.state === 'ENDED') return { code: 'closed', label: 'Ended' };
  const starts = new Date(event.starts_at).getTime();
  const ends = new Date(event.ends_at).getTime();
  if (t >= starts && t <= ends) return { code: 'ok', label: 'Ongoing' };
  const reg = getRegistrationState(event, now);
  if (reg.open) return { code: 'published', label: 'Registration open' };
  return { code: 'registered', label: 'Upcoming' };
}
