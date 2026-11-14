import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';

await boot('user', 'events');
const pending = new Set();

async function load() {
  const [ev, rg] = await Promise.all([
    supabase.from('event_stats').select('*').eq('status', 'published').gte('ends_at', new Date().toISOString()).order('starts_at'),
    supabase.from('registrations').select('event_id,status')
  ]);
  if (ev.error) return toast(errMsg(ev.error), 'error');
  const mine = new Map((rg.data || []).map(r => [r.event_id, r.status]));
  $('#list').innerHTML = ev.data.length ? ev.data.map(e => {
    const reg = mine.get(e.id) === 'registered';
    const full = e.capacity && e.registered_count >= e.capacity;
    return `<div class="card"><h2>${esc(e.title)}</h2><p class="muted sm">${fmt(e.starts_at)} – ${fmt(e.ends_at)}<br>📍 ${esc(e.venue)}</p>
    <p class="sm">${esc(e.description || '')}</p>
    <p class="sm"><b>${e.registered_count}</b> registered${e.capacity ? ` / ${e.capacity} seats` : ''}</p>
    ${reg ? '<span class="badge registered">You are registered</span> <a class="btn sm ghost" href="/user/registrations">View QR</a>'
      : `<button class="btn" data-id="${e.id}" ${full || pending.has(e.id) ? 'disabled' : ''}>${full ? 'Event full' : 'Register'}</button>`}</div>`;
  }).join('') : '<div class="card empty" style="grid-column:1/-1">No upcoming events right now.</div>';
}

$('#list').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b || pending.has(b.dataset.id)) return;
  pending.add(b.dataset.id); b.disabled = true; b.textContent = 'Registering...';
  const { error } = await supabase.rpc('register_for_event', { p_event_id: b.dataset.id });
  pending.delete(b.dataset.id);
  if (error) toast(errMsg(error), 'error'); else toast('Registered! Your QR code is ready.', 'success');
  load();
};

await load();
watch(['events', 'registrations'], load);
