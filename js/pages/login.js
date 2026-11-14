import { supabase, configMissing } from '/js/core/supabase.js';
import { homeFor } from '/js/core/boot.js';
import { errMsg, $ } from '/js/core/ui.js';

const msg = $('#msg');
if (configMissing) msg.innerHTML = '<div class="err">Supabase is not configured. Edit js/config.js (see README).</div>';

$('#f').addEventListener('submit', async e => {
  e.preventDefault(); msg.innerHTML = '';
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Logging in...';
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
    if (error) throw error;
    const { data: p, error: pe } = await supabase.from('profiles').select('role').eq('id', data.user.id).single();
    if (pe || !p) throw new Error('Profile not found. Contact the administrator.');
    location.replace(homeFor(p.role));
  } catch (err) {
    msg.innerHTML = `<div class="err">${errMsg(err)}</div>`;
    btn.disabled = false; btn.textContent = 'Log in';
  }
});
