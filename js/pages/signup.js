import { supabase, configMissing } from '/js/core/supabase.js';
import { errMsg, $ } from '/js/core/ui.js';

const msg = $('#msg');
if (configMissing) msg.innerHTML = '<div class="err">Supabase is not configured. Edit js/config.js (see README).</div>';

$('#f').addEventListener('submit', async e => {
  e.preventDefault(); msg.innerHTML = '';
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const { data, error } = await supabase.auth.signUp({
      email: $('#email').value.trim(), password: $('#password').value,
      options: { data: { full_name: $('#name').value.trim() }, emailRedirectTo: location.origin + '/login' }
    });
    if (error) throw error;
    // Always send the new user to the login page (not straight into the app)
    if (data.session) {
      await supabase.auth.signOut();
      $('#doneText').textContent = 'Your account is ready. Please log in to continue.';
    } else {
      $('#doneText').textContent = 'Your account was created. Check your email to confirm it, then log in.';
    }
    $('#f').reset();
    $('#doneDlg').showModal();
    return;
  } catch (err) { msg.innerHTML = `<div class="err">${errMsg(err)}</div>`; }
  btn.disabled = false; btn.textContent = 'Sign up';
});
