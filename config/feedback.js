// Single config & validator for allowed Google Form feedback links.
export const ALLOWED_FEEDBACK_HOSTS = ['docs.google.com', 'forms.gle', 'forms.google.com'];
export const MAX_FEEDBACK_URL_LENGTH = 500;

/**
 * Validate an optional Google Form feedback URL.
 * Returns { ok: true, url: string | null } or { ok: false, error: string }.
 */
export function validateFeedbackUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, url: null };
  if (s.length > MAX_FEEDBACK_URL_LENGTH) {
    return { ok: false, error: `Feedback link must be at most ${MAX_FEEDBACK_URL_LENGTH} characters.` };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'Enter a valid Google Form https:// link.' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, error: 'Feedback link must start with https://' };
  }
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_FEEDBACK_HOSTS.includes(host)) {
    return { ok: false, error: 'Only Google Forms links (docs.google.com/forms, forms.gle, forms.google.com) are allowed.' };
  }
  if (host === 'docs.google.com' && !u.pathname.startsWith('/forms/')) {
    return { ok: false, error: 'docs.google.com links must point to /forms/.' };
  }
  return { ok: true, url: s };
}
