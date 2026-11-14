import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';

await boot('admin', 'logs');

async function load() {
  let q = supabase.from('activity_logs').select('id,action,entity,entity_id,details,created_at,profiles(full_name,email)').order('created_at', { ascending: false }).limit(300);
  if ($('#filter').value) q = q.eq('entity', $('#filter').value);
  const { data, error } = await q;
  if (error) return toast(errMsg(error), 'error');
  $('#list').innerHTML = data.length ? `<div class="tablewrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>${data.map(l => `
    <tr><td data-label="Time">${fmt(l.created_at)}</td><td data-label="Actor">${esc(l.profiles?.full_name || l.profiles?.email || 'system')}</td><td data-label="Action"><span class="badge">${esc(l.action)}</span></td>
    <td data-label="Details" class="wrap sm">${esc(Object.entries(l.details || {}).map(([k, v]) => `${k}: ${v}`).join(' · '))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">No activity yet.</div>';
}
$('#filter').onchange = load;
await load();
watch(['activity_logs'], load);
