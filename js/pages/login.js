import { supabase, configMissing } from '/js/core/supabase.js';
import { homeFor } from '/js/core/boot.js';
import { errMsg, $, initPasswordEyes } from '/js/core/ui.js';

initPasswordEyes();
const msg = $('#msg');
if (configMissing) msg.innerHTML = '<div class="err">Supabase is not configured. Edit js/config.js (see README).</div>';
else if (new URLSearchParams(location.search).get('deactivated') === '1') {
  msg.innerHTML = '<div class="err">Your account has been deactivated. Contact an administrator.</div>';
}

$('#f').addEventListener('submit', async e => {
  e.preventDefault(); msg.innerHTML = '';
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Logging in...';
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
    if (error) {
      if (/banned|deactivated/i.test(error.message)) throw new Error('Your account has been deactivated. Contact an administrator.');
      throw error;
    }
    const { data: p, error: pe } = await supabase.from('profiles').select('role,status').eq('id', data.user.id).single();
    if (pe || !p) throw new Error('Profile not found. Contact the administrator.');
    if (p.status === 'inactive') {
      await supabase.auth.signOut();
      throw new Error('Your account has been deactivated. Contact an administrator.');
    }
    location.replace(homeFor(p.role));
  } catch (err) {
    msg.innerHTML = `<div class="err">${errMsg(err)}</div>`;
    btn.disabled = false; btn.textContent = 'Log in';
  }
});
