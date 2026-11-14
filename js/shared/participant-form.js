import { COURSES, OTHER_COURSE, MEMBER_TYPES, YEAR_LEVELS, PRIVACY_TEXT, MIN_PASSWORD } from '/js/shared/participant-options.js';
import { validateParticipant, passwordIssues } from '/js/shared/validation.js';
import { esc } from '/js/core/ui.js';

const field = (id, label, control, hint = '') =>
  `<div class="fld" data-f="${id}"><label for="pf_${id}">${label}</label>${control}${hint ? `<small class="muted">${hint}</small>` : ''}<div class="ferr" id="err_${id}" role="alert"></div></div>`;

/**
 * Renders the shared participant fields (public sign-up AND admin "register a participant").
 * Returns { values(), validate(), showErrors(obj), reset() }.
 */
export function mountParticipantForm(root, { consentLabel = PRIVACY_TEXT } = {}) {
  root.innerHTML = `<div class="pf-grid">
    <div class="pf-span">${field('full_name', 'Full name *', '<input id="pf_full_name" autocomplete="name" maxlength="120">')}</div>
    ${field('school_id', 'School ID / student number *', '<input id="pf_school_id" autocomplete="off" maxlength="20">')}
    ${field('email', 'Email *', '<input id="pf_email" type="email" autocomplete="email" inputmode="email">')}
    ${field('contact_number', 'Contact number (optional)', '<input id="pf_contact_number" type="tel" inputmode="tel" placeholder="09XXXXXXXXX or +639XXXXXXXXX">')}
    ${field('member_type', 'I am a *', `<select id="pf_member_type"><option value="">Select…</option>${MEMBER_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}</select>`)}
    ${field('course', 'Course / Department *', `<select id="pf_course"><option value="">Select…</option>${COURSES.map(c => `<option>${esc(c)}</option>`).join('')}<option>${OTHER_COURSE}</option></select>
      <input id="pf_course_other" placeholder="Type your course / department" maxlength="60" hidden style="margin-top:.4rem">`)}
    <div id="pf_year_wrap" hidden>${field('year_level', 'Year level *', `<select id="pf_year_level"><option value="">Select…</option>${YEAR_LEVELS.map(y => `<option value="${y.value}">${y.label}</option>`).join('')}</select>`)}</div>
    ${field('section', 'Section (optional)', '<input id="pf_section" maxlength="30">')}
    <div class="pf-span">${field('password', 'Password *', `<div class="pwrow"><input id="pf_password" type="password" autocomplete="new-password"><button type="button" class="btn ghost sm" id="pf_toggle" aria-label="Show or hide password">Show</button></div>`,
      `Min ${MIN_PASSWORD} characters, with letters and numbers.`)}
    <ul class="pwrules" id="pf_rules"></ul></div>
    <div class="pf-span">${field('confirm_password', 'Confirm password *', '<input id="pf_confirm_password" type="password" autocomplete="new-password">')}</div>
    <div class="fld pf-span" data-f="consent"><label class="check"><input type="checkbox" id="pf_consent"> <span>${esc(consentLabel)} *</span></label><div class="ferr" id="err_consent" role="alert"></div></div></div>`;

  const $ = id => root.querySelector('#pf_' + id);
  const sync = () => {
    $('year_wrap').hidden = $('member_type').value !== 'student';
    $('course_other').hidden = $('course').value !== OTHER_COURSE;
  };
  const rules = () => {
    const pw = $('password').value, bad = passwordIssues(pw);
    const all = [`At least ${MIN_PASSWORD} characters`, 'At least one letter', 'At least one number'];
    root.querySelector('#pf_rules').innerHTML = all.map(r => `<li class="${pw && !bad.includes(r) ? 'ok' : ''}">${r}</li>`).join('');
  };
  $('member_type').onchange = sync; $('course').onchange = sync; $('password').oninput = rules;
  $('toggle').onclick = () => {
    const show = $('password').type === 'password';
    $('password').type = $('confirm_password').type = show ? 'text' : 'password';
    $('toggle').textContent = show ? 'Hide' : 'Show';
  };
  sync(); rules();

  const values = () => ({
    full_name: $('full_name').value.trim(), school_id: $('school_id').value.trim(), email: $('email').value.trim().toLowerCase(),
    contact_number: $('contact_number').value.trim(), member_type: $('member_type').value,
    course: $('course').value === OTHER_COURSE ? $('course_other').value.trim() : $('course').value,
    year_level: $('member_type').value === 'student' ? $('year_level').value : '',
    section: $('section').value.trim(), password: $('password').value, confirm_password: $('confirm_password').value,
    consent: $('consent').checked
  });
  const showErrors = errs => {
    root.querySelectorAll('.ferr').forEach(d => { d.textContent = ''; });
    root.querySelectorAll('.bad').forEach(d => d.classList.remove('bad'));
    let first = null;
    for (const [k, msg] of Object.entries(errs)) {
      const d = root.querySelector('#err_' + k); if (d) d.textContent = msg;
      const input = root.querySelector('#pf_' + (k === 'course' && $('course').value === OTHER_COURSE ? 'course_other' : k));
      if (input && !first) first = input; if (input) input.classList.add('bad');
    }
    first?.focus();
  };
  // instant feedback: re-validate a field once it has been touched
  root.addEventListener('focusout', e => {
    if (!e.target.id?.startsWith('pf_') || e.target.id === 'pf_toggle') return;
    const errs = validateParticipant(values());
    const key = e.target.id.slice(3).replace('_other', '');
    const d = root.querySelector('#err_' + key); if (d) d.textContent = errs[key] || '';
  });
  return {
    values,
    validate() { const e = validateParticipant(values()); showErrors(e); return Object.keys(e).length === 0; },
    showErrors,
    reset() { root.querySelectorAll('input').forEach(i => { i.type === 'checkbox' ? (i.checked = false) : (i.value = ''); }); root.querySelectorAll('select').forEach(s => (s.value = '')); sync(); rules(); }
  };
}
