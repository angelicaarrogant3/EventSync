import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';

const { profile } = await boot('user', 'profile');
$('#email').value = profile.email; $('#name').value = profile.full_name; $('#phone').value = profile.phone || '';

$('#form').onsubmit = async e => {
  e.preventDefault();
  const { error } = await supabase.from('profiles').update({ full_name: $('#name').value.trim(), phone: $('#phone').value.trim() || null }).eq('id', profile.id);
  if (error) toast(errMsg(error), 'error'); else toast('Profile saved', 'success');
};

async function load() {
  const { data, error } = await supabase.from('attendance').select('id,checked_in_at,events(title,venue)').order('checked_in_at', { ascending: false });
  if (error) return toast(errMsg(error), 'error');
  $('#history').innerHTML = data.length ? data.map(a => `<li><span><b>${esc(a.events?.title)}</b><br><small class="muted">${esc(a.events?.venue)}</small></span><small class="muted">${fmt(a.checked_in_at)}</small></li>`).join('') : '<li class="empty">No attendance recorded yet.</li>';
}
await load();
watch(['attendance'], load);
