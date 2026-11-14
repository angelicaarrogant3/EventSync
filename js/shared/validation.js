// Pure validation helpers (no DOM, no imports) - shared by the browser forms and the Node tests.
// The database repeats these checks server-side (validate_participant); never rely on the client alone.
export const PH_CONTACT = /^(09\d{9}|\+639\d{9})$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const SCHOOL_ID_RE = /^[A-Za-z0-9-]{4,20}$/;
export const MIN_PASSWORD = 8;

export function passwordIssues(pw) {
  const out = [];
  if (pw.length < MIN_PASSWORD) out.push(`At least ${MIN_PASSWORD} characters`);
  if (!/[A-Za-z]/.test(pw)) out.push('At least one letter');
  if (!/\d/.test(pw)) out.push('At least one number');
  return out;
}

/** Returns an object { fieldName: 'message' }; empty object = valid. */
export function validateParticipant(v, { requirePassword = true } = {}) {
  const e = {};
  const s = x => String(x ?? '').trim();
  if (s(v.full_name).length < 2) e.full_name = 'Full name is required';
  if (!SCHOOL_ID_RE.test(s(v.school_id))) e.school_id = 'School ID must be 4-20 letters, numbers or dashes';
  if (!EMAIL_RE.test(s(v.email))) e.email = 'Enter a valid email address';
  if (s(v.contact_number) && !PH_CONTACT.test(s(v.contact_number))) e.contact_number = 'Use 09XXXXXXXXX or +639XXXXXXXXX';
  if (!['student', 'faculty', 'staff'].includes(v.member_type)) e.member_type = 'Select Student, Faculty or Staff';
  if (!s(v.course)) e.course = 'Course / Department is required';
  if (s(v.course).length > 60) e.course = 'Course / Department is too long';
  if (v.member_type === 'student' && !/^[1-4]$/.test(String(v.year_level ?? ''))) e.year_level = 'Select a year level';
  if (s(v.section).length > 30) e.section = 'Section is too long';
  if (requirePassword) {
    const issues = passwordIssues(String(v.password ?? ''));
    if (issues.length) e.password = 'Password needs: ' + issues.join(', ').toLowerCase();
    if (String(v.password ?? '') !== String(v.confirm_password ?? '')) e.confirm_password = 'Passwords do not match';
  }
  if (!v.consent) e.consent = 'You must accept the privacy consent';
  return e;
}
