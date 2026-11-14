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
      options: { data: { full_name: $('#name').value.trim() } }
    });
    if (error) throw error;
    if (data.session) { location.replace('/user/events'); return; }
    msg.innerHTML = '<div class="okmsg">Account created. Check your email to confirm, then log in.</div>';
  } catch (err) { msg.innerHTML = `<div class="err">${errMsg(err)}</div>`; }
  btn.disabled = false; btn.textContent = 'Sign up';
});
