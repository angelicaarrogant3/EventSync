import { supabase, configMissing } from '/js/core/supabase.js';
import { errMsg, $ } from '/js/core/ui.js';
import { mountParticipantForm } from '/js/shared/participant-form.js';

const msg = $('#msg');
if (configMissing) msg.innerHTML = '<div class="err">Supabase is not configured. Edit js/config.js (see README).</div>';
const form = mountParticipantForm($('#fields'));

async function availabilityErrors(v) {
  const { data } = await supabase.rpc('signup_availability', { p_school_id: v.school_id, p_email: v.email });
  const e = {};
  if (data?.school_id_taken) e.school_id = 'This school ID is already registered';
  if (data?.email_taken) e.email = 'This email is already registered';
  return e;
}

$('#f').addEventListener('submit', async ev => {
  ev.preventDefault(); msg.innerHTML = '';
  if (!form.validate()) return;                                  // instant client-side validation
  const v = form.values();
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const taken = await availabilityErrors(v);                   // friendly duplicate messages
    if (Object.keys(taken).length) { form.showErrors(taken); return; }

    // NOTE: no role is sent. The database forces role = participant and re-validates everything.
    const { data, error } = await supabase.auth.signUp({
      email: v.email, password: v.password,
      options: {
        emailRedirectTo: location.origin + '/login',
        data: { full_name: v.full_name, school_id: v.school_id, contact_number: v.contact_number, member_type: v.member_type,
                course: v.course, year_level: v.year_level, section: v.section, consent: v.consent }
      }
    });
    if (error) {
      if (/database error|saving new user/i.test(error.message)) {   // server-side validation rejected it: find out why
        const t2 = await availabilityErrors(v);
        if (Object.keys(t2).length) { form.showErrors(t2); return; }
        throw new Error('Some details were rejected by the server. Please check every field and try again.');
      }
      if (/already registered|already exists/i.test(error.message)) { form.showErrors({ email: 'This email is already registered' }); return; }
      throw error;
    }
    if (data.session) { await supabase.auth.signOut(); $('#doneText').textContent = `Welcome, ${v.full_name}! Your account is ready. Please log in to continue.`; }
    else $('#doneText').textContent = 'Your account was created. Check your email to confirm it, then log in.';
    form.reset();
    $('#doneDlg').showModal();
  } catch (err) { msg.innerHTML = `<div class="err">${errMsg(err)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Sign up'; }
});
