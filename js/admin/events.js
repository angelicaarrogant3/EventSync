import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toLocalInput, toast, errMsg, watch } from '/js/core/ui.js';

const { profile } = await boot('admin', 'events');
let events = [], editingId = null;
const dlg = $('#dlg');

async function load() {
  const { data, error } = await supabase.from('event_stats').select('*').order('starts_at', { ascending: false });
  if (error) { toast(errMsg(error), 'error'); return; }
  events = data;
  if (!events.length) { $('#list').innerHTML = '<div class="card empty">No events yet. Create your first one.</div>'; return; }
  $('#list').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Title</th><th>When</th><th>Venue</th><th>Status</th><th>Reg / Cap</th><th>Attended</th><th></th></tr></thead><tbody>${events.map(e => `
    <tr><td class="wrap"><b>${esc(e.title)}</b></td><td>${fmt(e.starts_at)}</td><td>${esc(e.venue)}</td>
    <td><span class="badge ${e.status}">${e.status}</span></td><td>${e.registered_count} / ${e.capacity ?? '∞'}</td><td>${e.attended_count}</td>
    <td><div class="row">
      <button class="btn sm ghost" data-a="edit" data-id="${e.id}">Edit</button>
      <button class="btn sm ${e.status === 'published' ? 'ghost' : 'ok'}" data-a="toggle" data-id="${e.id}">${e.status === 'published' ? 'Unpublish' : 'Publish'}</button>
      <button class="btn sm danger" data-a="del" data-id="${e.id}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`;
}

function openForm(e) {
  editingId = e?.id || null;
  $('#dlgTitle').textContent = e ? 'Edit event' : 'New event';
  $('#title').value = e?.title || ''; $('#venue').value = e?.venue || ''; $('#desc').value = e?.description || '';
  $('#starts').value = toLocalInput(e?.starts_at); $('#ends').value = toLocalInput(e?.ends_at);
  $('#cap').value = e?.capacity ?? ''; $('#status').value = e?.status || 'draft';
  dlg.showModal();
}

$('#newBtn').onclick = () => openForm();
$('#cancel').onclick = () => dlg.close();
$('#form').onsubmit = async ev => {
  ev.preventDefault();
  const row = {
    title: $('#title').value.trim(), venue: $('#venue').value.trim(), description: $('#desc').value.trim() || null,
    starts_at: new Date($('#starts').value).toISOString(), ends_at: new Date($('#ends').value).toISOString(),
    capacity: $('#cap').value ? parseInt($('#cap').value, 10) : null, status: $('#status').value
  };
  if (new Date(row.ends_at) <= new Date(row.starts_at)) return toast('End must be after start', 'error');
  const btn = $('#save'); btn.disabled = true;
  const q = editingId ? supabase.from('events').update(row).eq('id', editingId) : supabase.from('events').insert({ ...row, created_by: profile.id });
  const { error } = await q; btn.disabled = false;
  if (error) return toast(errMsg(error), 'error');
  dlg.close(); toast('Event saved', 'success'); load();
};

$('#list').onclick = async ev => {
  const b = ev.target.closest('button[data-a]'); if (!b) return;
  const e = events.find(x => x.id === b.dataset.id);
  if (b.dataset.a === 'edit') return openForm(e);
  if (b.dataset.a === 'toggle') {
    const { error } = await supabase.from('events').update({ status: e.status === 'published' ? 'draft' : 'published' }).eq('id', e.id);
    if (error) toast(errMsg(error), 'error'); else { toast('Status updated', 'success'); load(); }
  }
  if (b.dataset.a === 'del' && confirm(`Delete "${e.title}" and all its registrations and attendance?`)) {
    const { error } = await supabase.from('events').delete().eq('id', e.id);
    if (error) toast(errMsg(error), 'error'); else { toast('Event deleted', 'success'); load(); }
  }
};

await load();
watch(['events', 'registrations', 'attendance'], load);
