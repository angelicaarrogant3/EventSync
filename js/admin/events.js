import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toLocalInput, toast, errMsg, watch } from '/js/core/ui.js';
import {
  eventBannerHtml, eventImageUrl, validateImageFile, processEventImage,
  uploadEventImage, removeEventImage, deleteEventStorageFile
} from '/js/shared/event-images.js';

const { profile } = await boot('admin', 'events');
let events = [], editingId = null, editingImagePath = null;
let selectedFile = null, previewObjectUrl = null, pendingRemove = false;
const dlg = $('#dlg');

const fmtBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function applyPreviewCrop() {
  const prev = $('#imgPrev');
  const z = Number($('#imgZoom').value) || 1;
  const px = Math.round((Number($('#imgPanX').value) || 0.5) * 100);
  const py = Math.round((Number($('#imgPanY').value) || 0.5) * 100);
  prev.style.objectPosition = `${px}% ${py}%`;
  prev.style.transform = `scale(${z})`;
}

function setUploaderState({ src = null, meta = 'Drag & drop or tap Choose to add a banner', showCrop = false, hasImage = false, err = '' }) {
  $('#imgPrev').src = src || '';
  $('#imgBox').classList.toggle('has-img', !!src);
  $('#imgCropCtrl').classList.toggle('show', showCrop);
  $('#imgMeta').textContent = meta;
  $('#imgChoose').textContent = hasImage ? 'Replace' : 'Choose';
  $('#imgRemove').hidden = !hasImage;
  $('#imgErr').textContent = err;
  $('#imgProg').classList.remove('show');
  $('#imgBar').style.width = '0%';
  if (src) applyPreviewCrop();
}

function clearPreviewUrl() {
  if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
}

async function handlePickedFile(file) {
  if (!file) return;
  const check = await validateImageFile(file);
  if (!check.ok) {
    $('#imgErr').textContent = check.error;
    toast(check.error, 'error');
    return;
  }
  clearPreviewUrl();
  selectedFile = file;
  pendingRemove = false;
  previewObjectUrl = URL.createObjectURL(file);
  $('#imgZoom').value = '1'; $('#imgPanX').value = '0.5'; $('#imgPanY').value = '0.5';
  setUploaderState({
    src: previewObjectUrl,
    meta: `${file.name} (${fmtBytes(file.size)})`,
    showCrop: true,
    hasImage: true,
    err: ''
  });
}

async function load() {
  const { data, error } = await supabase.from('event_stats').select('*').order('starts_at', { ascending: false });
  if (error) { toast(errMsg(error), 'error'); return; }
  events = data;
  if (!events.length) { $('#list').innerHTML = '<div class="card empty">No events yet. Create your first one.</div>'; return; }
  $('#list').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Title</th><th>When</th><th>Venue</th><th>Status</th><th>Reg / Cap</th><th>Attended</th><th></th></tr></thead><tbody>${events.map(e => `
    <tr><td class="wrap" data-label="Title"><div class="evt-admin-title">${eventBannerHtml(e, { variant: 'thumb' })}<div><b>${esc(e.title)}</b></div></div></td><td data-label="When">${fmt(e.starts_at)}</td><td data-label="Venue">${esc(e.venue)}</td>
    <td data-label="Status"><span class="badge ${e.status}">${e.status}</span></td><td data-label="Reg / Cap">${e.registered_count} / ${e.capacity ?? '∞'}</td><td data-label="Attended">${e.attended_count}</td>
    <td data-label="Actions"><div class="row">
      <button class="btn sm ghost" data-a="edit" data-id="${e.id}">Edit</button>
      <button class="btn sm ${e.status === 'published' ? 'ghost' : 'ok'}" data-a="toggle" data-id="${e.id}">${e.status === 'published' ? 'Unpublish' : 'Publish'}</button>
      <button class="btn sm danger" data-a="del" data-id="${e.id}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`;
}

function openForm(e) {
  clearPreviewUrl();
  editingId = e?.id || null;
  editingImagePath = e?.image_path || null;
  selectedFile = null;
  pendingRemove = false;
  $('#imgFile').value = '';
  $('#imgZoom').value = '1'; $('#imgPanX').value = '0.5'; $('#imgPanY').value = '0.5';
  const existingUrl = eventImageUrl(e);
  setUploaderState({
    src: existingUrl,
    meta: existingUrl ? 'Current event banner' : 'Drag & drop or tap Choose to add a banner',
    showCrop: false,
    hasImage: !!existingUrl
  });
  $('#dlgTitle').textContent = e ? 'Edit event' : 'New event';
  $('#title').value = e?.title || ''; $('#venue').value = e?.venue || ''; $('#desc').value = e?.description || '';
  $('#starts').value = toLocalInput(e?.starts_at); $('#ends').value = toLocalInput(e?.ends_at);
  $('#cap').value = e?.capacity ?? ''; $('#deadline').value = toLocalInput(e?.registration_deadline); $('#status').value = e?.status || 'draft';
  dlg.showModal();
}

$('#imgChoose').onclick = () => $('#imgFile').click();
$('#imgFile').onchange = ev => handlePickedFile(ev.target.files?.[0]);
$('#imgRemove').onclick = () => {
  clearPreviewUrl();
  selectedFile = null;
  pendingRemove = true;
  $('#imgFile').value = '';
  setUploaderState({ hasImage: false, meta: 'Banner removed (save to apply)' });
};
['imgZoom', 'imgPanX', 'imgPanY'].forEach(id => {
  $(`#${id}`).oninput = applyPreviewCrop;
});
const drop = $('#imgDrop');
drop.ondragover = ev => { ev.preventDefault(); drop.classList.add('drag'); };
drop.ondragleave = () => drop.classList.remove('drag');
drop.ondrop = ev => {
  ev.preventDefault();
  drop.classList.remove('drag');
  handlePickedFile(ev.dataTransfer?.files?.[0]);
};

$('#newBtn').onclick = () => openForm();
$('#cancel').onclick = () => { clearPreviewUrl(); dlg.close(); };
$('#form').onsubmit = async ev => {
  ev.preventDefault();
  const row = {
    title: $('#title').value.trim(), venue: $('#venue').value.trim(), description: $('#desc').value.trim() || null,
    starts_at: new Date($('#starts').value).toISOString(), ends_at: new Date($('#ends').value).toISOString(),
    registration_deadline: $('#deadline').value ? new Date($('#deadline').value).toISOString() : null,
    capacity: $('#cap').value ? parseInt($('#cap').value, 10) : null, status: $('#status').value
  };
  if (new Date(row.ends_at) <= new Date(row.starts_at)) return toast('End must be after start', 'error');

  const btn = $('#save');
  const wasNew = !editingId;
  btn.disabled = true;
  $('#imgErr').textContent = '';

  const q = editingId
    ? supabase.from('events').update(row).eq('id', editingId).select('id').single()
    : supabase.from('events').insert({ ...row, created_by: profile.id }).select('id').single();
  const { data: saved, error } = await q;
  if (error) { btn.disabled = false; return toast(errMsg(error), 'error'); }

  const targetId = editingId || saved.id;

  if (selectedFile) {
    $('#imgProg').classList.add('show');
    $('#imgBar').style.width = '25%';
    try {
      const blob = await processEventImage(selectedFile, {
        zoom: Number($('#imgZoom').value) || 1,
        panX: Number($('#imgPanX').value) || 0.5,
        panY: Number($('#imgPanY').value) || 0.5
      });
      $('#imgBar').style.width = '65%';
      await uploadEventImage(supabase, targetId, blob, editingImagePath);
      $('#imgBar').style.width = '100%';
    } catch (imgErr) {
      btn.disabled = false;
      $('#imgProg').classList.remove('show');
      if (wasNew) {
        editingId = targetId;
        editingImagePath = null;
        $('#dlgTitle').textContent = 'Edit event';
      }
      const msg = wasNew
        ? 'Event saved, but the image failed to upload. Try again.'
        : (imgErr?.message || 'Image upload failed. Try again.');
      $('#imgErr').textContent = msg;
      toast(msg, 'error');
      load();
      return;
    }
  } else if (pendingRemove && editingImagePath) {
    try {
      await removeEventImage(supabase, targetId, editingImagePath);
    } catch (imgErr) {
      btn.disabled = false;
      const msg = imgErr?.message || 'Failed to remove image.';
      $('#imgErr').textContent = msg;
      toast(msg, 'error');
      return;
    }
  }

  btn.disabled = false;
  clearPreviewUrl();
  dlg.close();
  toast('Event saved', 'success');
  load();
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
    if (error) toast(errMsg(error), 'error');
    else {
      await deleteEventStorageFile(supabase, e.image_path);
      toast('Event deleted', 'success');
      load();
    }
  }
};

await load();
watch(['events', 'registrations', 'attendance'], load);
