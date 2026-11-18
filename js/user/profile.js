import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch, initPasswordEyes } from '/js/core/ui.js';
import { MEMBER_TYPES, YEAR_LEVELS, validateProgramSelection } from '/js/shared/participant-options.js';
import { mountProgramSelector } from '/js/shared/program-selector.js';
import { PH_CONTACT, passwordIssues } from '/js/shared/validation.js';

const { profile } = await boot('user', 'profile');
initPasswordEyes();

if (profile.program_needs_update) $('#legacyBanner').hidden = false;

$('#name').value = profile.full_name || '';
$('#school_id').value = profile.school_id || '(not set - ask an administrator)';
$('#email').value = profile.email;
$('#contact').value = profile.contact_number || '';
$('#section').value = profile.section || '';

$('#member_type').innerHTML = '<option value="">Select…</option>' + MEMBER_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
$('#member_type').value = profile.member_type || '';
$('#year_level').innerHTML = '<option value="">Select…</option>' + YEAR_LEVELS.map(y => `<option value="${y.value}">${y.label}</option>`).join('');
$('#year_level').value = profile.year_level || '';

const progSel = mountProgramSelector($('#progMount'), {
  idPrefix: 'prof',
  memberType: profile.member_type || '',
  initial: {
    department: profile.department || '',
    program: profile.program || '',
    major: profile.major || '',
    course: profile.course || ''
  }
});

const sync = () => {
  const mt = $('#member_type').value;
  $('#year_wrap').hidden = mt !== 'student';
  progSel.setMemberType(mt);
};
$('#member_type').onchange = sync;
sync();

$('#form').onsubmit = async e => {
  e.preventDefault();
  ['e_contact', 'e_year'].forEach(i => ($('#' + i).textContent = ''));
  progSel.showErrors({});
  const contact = $('#contact').value.trim(), mt = $('#member_type').value;
  const pv = progSel.values();
  const res = validateProgramSelection({ member_type: mt, ...pv });

  let bad = false;
  if (contact && !PH_CONTACT.test(contact)) { $('#e_contact').textContent = 'Use 09XXXXXXXXX or +639XXXXXXXXX'; bad = true; }
  if (res.error) { progSel.showErrors({ [res.field || 'department']: res.error }); bad = true; }
  if (mt === 'student' && !$('#year_level').value) { $('#e_year').textContent = 'Select a year level'; bad = true; }
  if (bad) return;

  const { error } = await supabase.from('profiles').update({
    full_name: $('#name').value.trim(),
    contact_number: contact || null,
    member_type: mt || null,
    department: res.department,
    program: res.program,
    major: res.major,
    course: res.course,
    program_needs_update: false,
    year_level: mt === 'student' ? Number($('#year_level').value) : null,
    section: $('#section').value.trim() || null
  }).eq('id', profile.id);
  if (error) toast(errMsg(error), 'error');
  else {
    $('#legacyBanner').hidden = true;
    toast('Profile saved', 'success');
  }
};

$('#pwform').onsubmit = async e => {
  e.preventDefault(); $('#e_pw1').textContent = $('#e_pw2').textContent = '';
  const p1 = $('#pw1').value, p2 = $('#pw2').value, issues = passwordIssues(p1);
  if (issues.length) return ($('#e_pw1').textContent = 'Password needs: ' + issues.join(', ').toLowerCase());
  if (p1 !== p2) return ($('#e_pw2').textContent = 'Passwords do not match');
  const { error } = await supabase.auth.updateUser({ password: p1 });
  if (error) $('#e_pw1').textContent = errMsg(error); else { toast('Password updated', 'success'); $('#pwform').reset(); }
};

async function loadRoleRequests() {
  const box = $('#orgBody');
  if (!box) return;
  if (profile.role === 'admin' || profile.role === 'organizer') {
    box.innerHTML = `<p class="sm"><span class="badge ok">${profile.role === 'admin' ? 'Administrator' : 'Event Organizer'}</span> Your account can create and manage events.</p>
      <a class="btn sm" href="/admin/events" style="margin-top:.5rem;display:inline-flex">Open ${profile.role === 'admin' ? 'Admin' : 'Organizer'} View</a>`;
    return;
  }
  const { data, error } = await supabase.rpc('my_role_requests');
  if (error) { box.innerHTML = `<p class="muted sm">${esc(errMsg(error))}</p>`; return; }
  const list = Array.isArray(data) ? data : [];
  const latest = list[0] || null;
  if (latest?.status === 'pending') {
    box.innerHTML = `
      <p class="sm"><span class="badge dup">Pending review</span> Submitted ${fmt(latest.created_at)}</p>
      <p class="muted sm" style="margin:.35rem 0 0"><b>Reason:</b> ${esc(latest.reason)}<br><b>Planned events:</b> ${esc(latest.planned_events)}</p>`;
    return;
  }
  const rejectedNote = latest?.status === 'rejected'
    ? `<div style="padding:.6rem .75rem;margin-bottom:.75rem;border-radius:8px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35)" class="sm">
         <b>Previous request rejected</b> (${fmt(latest.reviewed_at || latest.created_at)})${latest.decision_reason ? `<br><span class="muted">Reason: ${esc(latest.decision_reason)}</span>` : ''}
       </div>`
    : '';
  box.innerHTML = `
    ${rejectedNote}
    <p class="muted sm" style="margin:0 0 .6rem">Want to host an official school, department, or organization event? Request Event Organizer access from an administrator.</p>
    <form id="orgForm" novalidate>
      <label for="orgReason">Why do you need organizer access?</label>
      <textarea id="orgReason" rows="2" required minlength="5" placeholder="e.g., Faculty adviser / SSG officer organizing college events"></textarea>
      <label for="orgPlanned">What kind of events do you plan to run?</label>
      <input id="orgPlanned" required minlength="3" placeholder="e.g., Department seminars, workshops, general assemblies">
      <button class="btn" style="margin-top:.85rem">Become an organizer</button>
    </form>`;
  $('#orgForm').onsubmit = async ev => {
    ev.preventDefault();
    const reason = $('#orgReason').value.trim();
    const planned = $('#orgPlanned').value.trim();
    const { error: reqErr } = await supabase.rpc('request_organizer_role', { p_reason: reason, p_planned_events: planned });
    if (reqErr) return toast(errMsg(reqErr), 'error');
    toast('Organizer request submitted for admin review', 'success');
    loadRoleRequests();
  };
}

async function load() {
  const { data, error } = await supabase.from('attendance').select('id,checked_in_at,events(title,venue)').order('checked_in_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  $('#history').innerHTML = data.length ? data.map(a => `<li><span><b>${esc(a.events?.title)}</b><br><small class="muted">${esc(a.events?.venue)}</small></span><small class="muted">${fmt(a.checked_in_at)}</small></li>`).join('') : '<li class="empty">No attendance recorded yet.</li>';
}
await Promise.all([load(), loadRoleRequests()]);
watch(['attendance', 'role_requests', 'profiles'], () => { load(); loadRoleRequests(); });
