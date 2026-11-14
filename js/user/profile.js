import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch, initPasswordEyes } from '/js/core/ui.js';
import { COURSES, OTHER_COURSE, MEMBER_TYPES, YEAR_LEVELS } from '/js/shared/participant-options.js';
import { PH_CONTACT, passwordIssues } from '/js/shared/validation.js';

const { profile } = await boot('user', 'profile');
initPasswordEyes();

$('#name').value = profile.full_name || ''; $('#school_id').value = profile.school_id || '(not set - ask an administrator)';
$('#email').value = profile.email; $('#contact').value = profile.contact_number || ''; $('#section').value = profile.section || '';
$('#member_type').innerHTML = '<option value="">Select…</option>' + MEMBER_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
$('#member_type').value = profile.member_type || '';
$('#course').innerHTML = '<option value="">Select…</option>' + COURSES.concat(OTHER_COURSE).map(c => `<option>${esc(c)}</option>`).join('');
$('#year_level').innerHTML = '<option value="">Select…</option>' + YEAR_LEVELS.map(y => `<option value="${y.value}">${y.label}</option>`).join('');
if (profile.course && COURSES.includes(profile.course)) $('#course').value = profile.course;
else if (profile.course) { $('#course').value = OTHER_COURSE; $('#course_other').value = profile.course; }
$('#year_level').value = profile.year_level || '';

const sync = () => { $('#year_wrap').hidden = $('#member_type').value !== 'student'; $('#course_other').hidden = $('#course').value !== OTHER_COURSE; };
$('#member_type').onchange = sync; $('#course').onchange = sync; sync();

$('#form').onsubmit = async e => {
  e.preventDefault();
  ['e_contact', 'e_course', 'e_year'].forEach(i => ($('#' + i).textContent = ''));
  const contact = $('#contact').value.trim(), mt = $('#member_type').value;
  const course = $('#course').value === OTHER_COURSE ? $('#course_other').value.trim() : $('#course').value;
  let bad = false;
  if (contact && !PH_CONTACT.test(contact)) { $('#e_contact').textContent = 'Use 09XXXXXXXXX or +639XXXXXXXXX'; bad = true; }
  if (!course) { $('#e_course').textContent = 'Course / Department is required'; bad = true; }
  if (mt === 'student' && !$('#year_level').value) { $('#e_year').textContent = 'Select a year level'; bad = true; }
  if (bad) return;
  const { error } = await supabase.from('profiles').update({   // only whitelisted columns are writable (see migration 003)
    full_name: $('#name').value.trim(), contact_number: contact || null, member_type: mt || null, course,
    year_level: mt === 'student' ? Number($('#year_level').value) : null, section: $('#section').value.trim() || null
  }).eq('id', profile.id);
  if (error) toast(errMsg(error), 'error'); else toast('Profile saved', 'success');
};

$('#pwform').onsubmit = async e => {
  e.preventDefault(); $('#e_pw1').textContent = $('#e_pw2').textContent = '';
  const p1 = $('#pw1').value, p2 = $('#pw2').value, issues = passwordIssues(p1);
  if (issues.length) return ($('#e_pw1').textContent = 'Password needs: ' + issues.join(', ').toLowerCase());
  if (p1 !== p2) return ($('#e_pw2').textContent = 'Passwords do not match');
  const { error } = await supabase.auth.updateUser({ password: p1 });
  if (error) $('#e_pw1').textContent = errMsg(error); else { toast('Password updated', 'success'); $('#pwform').reset(); }
};

async function load() {
  const { data, error } = await supabase.from('attendance').select('id,checked_in_at,events(title,venue)').order('checked_in_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  $('#history').innerHTML = data.length ? data.map(a => `<li><span><b>${esc(a.events?.title)}</b><br><small class="muted">${esc(a.events?.venue)}</small></span><small class="muted">${fmt(a.checked_in_at)}</small></li>`).join('') : '<li class="empty">No attendance recorded yet.</li>';
}
await load();
watch(['attendance'], load);
