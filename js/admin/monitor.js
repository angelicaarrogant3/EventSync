import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmtTime, toast, errMsg, watch } from '/js/core/ui.js';
import { ICONS } from '/js/shared/icons.js';

await boot('admin', 'monitor');
$('#iReg').innerHTML = ICONS.users(18);
$('#iAtt').innerHTML = ICONS.check(18);
$('#iLeft').innerHTML = ICONS.clock(18);
$('#iPct').innerHTML = ICONS.activity(18);
let seen = new Set(), first = true;
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';

async function loadEvents() {
  const { data } = await supabase.from('events').select('id,title,status').order('starts_at', { ascending: false });
  const cur = $('#ev').value;
  $('#ev').innerHTML = '<option value="">All events</option>' + (data || []).map(e => `<option value="${e.id}">${esc(e.title)} (${e.status})</option>`).join('');
  $('#ev').value = cur;
}

async function load() {
  const id = $('#ev').value;
  let rq = supabase.from('registrations').select('id', { count: 'exact', head: true }).eq('status', 'registered');
  let aq = supabase.from('attendance').select('id,checked_in_at,profiles!attendance_user_id_fkey(full_name),events(title)').order('checked_in_at', { ascending: false }).limit(50);
  let cq = supabase.from('attendance').select('id', { count: 'exact', head: true });
  if (id) { rq = rq.eq('event_id', id); aq = aq.eq('event_id', id); cq = cq.eq('event_id', id); }
  const [r, a, c] = await Promise.all([rq, aq, cq]);
  if (r.error || a.error || c.error) return toast(errMsg(r.error || a.error || c.error), 'error');
  const reg = r.count || 0, att = c.count || 0;
  $('#sReg').textContent = reg; $('#sAtt').textContent = att; $('#sLeft').textContent = Math.max(reg - att, 0);
  const pct = reg ? Math.round(att / reg * 100) : 0;
  $('#sPct').textContent = pct + '%'; $('#barfill').style.width = Math.min(pct, 100) + '%';
  $('#feed').innerHTML = a.data.length ? a.data.map(x => `<li class="${!first && !seen.has(x.id) ? 'new' : ''}"><div class="row" style="gap:.65rem;flex-wrap:nowrap"><span class="avatar">${esc(initials(x.profiles?.full_name))}</span><span><b>${esc(x.profiles?.full_name)}</b><br><small class="muted">${esc(x.events?.title)}</small></span></div><span class="muted sm">${fmtTime(x.checked_in_at)}</span></li>`).join('') : '<li class="empty">No check-ins yet.</li>';
  a.data.forEach(x => seen.add(x.id)); first = false;
}
$('#ev').onchange = () => { seen = new Set(); first = true; load(); };
await loadEvents(); await load();
watch(['attendance', 'registrations', 'events'], () => { loadEvents(); load(); });
