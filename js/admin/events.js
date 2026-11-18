import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import {
  eventBannerHtml, eventImageUrl, validateImageFile, processEventImage,
  uploadEventImage, removeEventImage, deleteEventStorageFile
} from '/js/shared/event-images.js';
import {
  DEFAULT_EARLY_GRACE_MINUTES, DEFAULT_LATE_GRACE_MINUTES, DEFAULT_LATE_AFTER_MINUTES,
  parseManilaInput, toManilaInput, getAttendanceState, getDerivedEventStatus, formatManila
} from '/config/schedule.js';
import { validateFeedbackUrl } from '/config/feedback.js';
import { PROGRAM_SCHOOLS, ADMIN_OFFICE_SCHOOL } from '/js/shared/participant-options.js';
import { openTemplateEditorModal, DEFAULT_TEMPLATE_ID } from '/js/shared/certificate.js';

const { profile } = await boot('admin', 'events');
let events = [], templates = [], editingId = null, editingImagePath = null, editingOrig = null;
let selectedFile = null, previewObjectUrl = null, pendingRemove = false;
const dlg = $('#dlg');

async function loadTemplates(selectedId = null) {
  const { data } = await supabase.from('certificate_templates').select('*').eq('is_active', true).order('is_global', { ascending: false }).order('created_at', { ascending: false });
  templates = data || [];
  const sel = $('#certTemplate');
  if (!sel) return;
  const cur = selectedId || sel.value || DEFAULT_TEMPLATE_ID;
  sel.innerHTML = templates.map(t => `<option value="${t.id}">${esc(t.name)}${t.is_global ? ' (Global)' : ''} · v${t.version}</option>`).join('');
  if (templates.some(t => t.id === cur)) sel.value = cur;
}
await loadTemplates();

function initEligibilitySelectors() {
  const scEl = $('#eligSchool'), prEl = $('#eligProgram');
  if (!scEl || !prEl) return;
  const schools = [...PROGRAM_SCHOOLS.map(s => s.name), ADMIN_OFFICE_SCHOOL.name];
  scEl.innerHTML = '<option value="">All schools & offices</option>' +
    schools.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const syncPrograms = (keepVal = '') => {
    const sc = scEl.value;
    const src = sc ? PROGRAM_SCHOOLS.filter(s => s.name === sc) : PROGRAM_SCHOOLS;
    const progs = [];
    src.forEach(s => s.programs.forEach(p => { if (!progs.includes(p.name)) progs.push(p.name); }));
    if (sc === ADMIN_OFFICE_SCHOOL.name) {
      ADMIN_OFFICE_SCHOOL.programs.forEach(p => { if (!progs.includes(p.name)) progs.push(p.name); });
    }
    prEl.innerHTML = '<option value="">All programs</option>' +
      progs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    if (keepVal && progs.includes(keepVal)) prEl.value = keepVal;
  };
  scEl.onchange = () => syncPrograms('');
  syncPrograms('');
  scEl._syncPrograms = syncPrograms;
}
initEligibilitySelectors();

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

function updateScheduleHint() {
  const s = parseManilaInput($('#starts').value);
  const e = parseManilaInput($('#ends').value);
  const dl = parseManilaInput($('#deadline').value);
  const eg = parseInt($('#earlyGrace').value || DEFAULT_EARLY_GRACE_MINUTES, 10);
  const lg = parseInt($('#lateGrace').value || DEFAULT_LATE_GRACE_MINUTES, 10);
  if (s && e) {
    const ws = getAttendanceState({ starts_at: s, ends_at: e, early_grace_minutes: eg, late_grace_minutes: lg, status: 'published' });
    $('#attWindowHint').textContent = `Attendance opens ${formatManila(ws.opensAt)} and closes ${formatManila(ws.closesAt)}.`;
  } else {
    $('#attWindowHint').textContent = '';
  }
  if (dl && s && new Date(dl) > new Date(s)) {
    $('#schedWarn').textContent = 'Note: Registration deadline is after the event start time.';
  } else {
    $('#schedWarn').textContent = '';
  }
}

async function load() {
  const { data, error } = await supabase.from('event_stats').select('*').order('starts_at', { ascending: false });
  if (error) { toast(errMsg(error), 'error'); return; }
  events = profile.role === 'organizer' ? (data || []).filter(e => e.created_by === profile.id) : (data || []);
  if (!events.length) { $('#list').innerHTML = '<div class="card empty">No events yet. Create your first one.</div>'; return; }
  $('#list').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Title</th><th>When</th><th>Venue</th><th>Status</th><th>Reg / Cap</th><th>Attended</th><th></th></tr></thead><tbody>${events.map(e => {
    const dStatus = getDerivedEventStatus(e);
    const specialCount = (e.test_attended_count || 0) + (e.voided_count || 0);
    const fbSet = !!(e.has_feedback_url || e.feedback_url);
    const endedNoFb = dStatus.label === 'Ended' && !fbSet && e.status !== 'cancelled';
    const canToggleEarly = fbSet && new Date(e.ends_at) > new Date() && e.status !== 'cancelled';
    const hasElig = (e.allowed_schools?.length || e.allowed_programs?.length || e.allowed_year_levels?.length);
    return `<tr>
      <td class="wrap" data-label="Title"><div class="evt-admin-title">${eventBannerHtml(e, { variant: 'thumb' })}<div><b>${esc(e.title)}</b><br><span class="badge ${fbSet ? 'ok' : ''}" style="margin-top:.25rem">Feedback: ${fbSet ? 'set' : 'not set'}</span>${hasElig ? ' <span class="badge" style="margin-top:.25rem">Restricted</span>' : ''}${e.feedback_opened_early ? ' <span class="badge dup">Open early</span>' : ''}${endedNoFb ? '<br><small class="muted">This event ended. Add a feedback form link.</small>' : ''}</div></div></td>
      <td data-label="When">${fmt(e.starts_at)}</td>
      <td data-label="Venue">${esc(e.venue)}</td>
      <td data-label="Status"><span class="badge ${e.status}">${e.status}</span> <span class="badge ${dStatus.code}">${dStatus.label}</span></td>
      <td data-label="Reg / Cap">${e.registered_count} / ${e.capacity ?? '∞'}</td>
      <td data-label="Attended">${e.attended_count}${e.test_attended_count ? ` <small class="muted">(+${e.test_attended_count} test)</small>` : ''}${e.certificates_issued_count ? `<br><small class="muted">${e.certificates_issued_count} cert(s)</small>` : ''}</td>
      <td data-label="Actions"><div class="row">
        <button class="btn sm ghost" data-a="edit" data-id="${e.id}">Edit</button>
        <button class="btn sm ghost" data-a="att" data-id="${e.id}">Check-ins${specialCount ? ` (${specialCount})` : ''}</button>
        ${profile.role === 'admin' && e.certificates_issued_count ? `<button class="btn sm ghost" data-a="certs" data-id="${e.id}">Certificates (${e.certificates_issued_count})</button>` : ''}
        ${canToggleEarly ? `<button class="btn sm ${e.feedback_opened_early ? 'ghost' : 'ok'}" data-a="fbEarly" data-id="${e.id}">${e.feedback_opened_early ? 'Close early feedback' : 'Open feedback now'}</button>` : ''}
        <button class="btn sm ${e.status === 'published' ? 'ghost' : 'ok'}" data-a="toggle" data-id="${e.id}">${e.status === 'published' ? 'Unpublish' : 'Publish'}</button>
        <button class="btn sm danger" data-a="del" data-id="${e.id}">Delete</button></div></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function openForm(e) {
  clearPreviewUrl();
  editingId = e?.id || null;
  editingOrig = e || null;
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
  $('#starts').value = toManilaInput(e?.starts_at); $('#ends').value = toManilaInput(e?.ends_at);
  $('#regOpens').value = toManilaInput(e?.registration_opens_at);
  $('#deadline').value = toManilaInput(e?.registration_deadline);
  $('#earlyGrace').value = e?.early_grace_minutes ?? DEFAULT_EARLY_GRACE_MINUTES;
  $('#lateGrace').value = e?.late_grace_minutes ?? DEFAULT_LATE_GRACE_MINUTES;
  $('#lateAfter').value = e ? (e.late_after_minutes ?? '') : DEFAULT_LATE_AFTER_MINUTES;
  $('#cap').value = e?.capacity ?? '';
  $('#status').value = e?.status || 'draft';
  $('#fbUrl').value = e?.feedback_url || '';
  $('#fbAudience').value = e?.feedback_audience || 'attended';
  if ($('#certEnabled')) {
    $('#certEnabled').checked = e ? e.certificates_enabled !== false : true;
    $('#certSetupWrap').hidden = !$('#certEnabled').checked;
    $('#certTemplate').value = e?.certificate_template_id || DEFAULT_TEMPLATE_ID;
  }
  if ($('#eligSchool')) {
    $('#eligSchool').value = e?.allowed_schools?.[0] || '';
    $('#eligSchool')._syncPrograms?.(e?.allowed_programs?.[0] || '');
  }
  const yrs = new Set((e?.allowed_year_levels || []).map(Number));
  document.querySelectorAll('#eligYears input[type="checkbox"]').forEach(cb => {
    cb.checked = yrs.has(Number(cb.value));
  });
  updateScheduleHint();
  dlg.showModal();
}

async function openCheckinsModal(e) {
  const attDlg = $('#attDlg');
  $('#attBody').innerHTML = '<p class="muted">Loading check-ins...</p>';
  attDlg.showModal();
  const { data, error } = await supabase
    .from('attendance')
    .select('id,checked_in_at,is_test,clock_suspect,voided,void_reason,profiles!attendance_user_id_fkey(full_name,school_id)')
    .eq('event_id', e.id)
    .order('checked_in_at', { ascending: false });
  if (error) { attDlg.close(); return toast(errMsg(error), 'error'); }

  const special = (data || []).filter(r => r.is_test || r.voided || r.clock_suspect);
  $('#attBody').innerHTML = `
    <div class="pagehead" style="margin-bottom:.75rem">
      <div><h2 style="margin:0">${esc(e.title)}</h2><p class="muted sm">Test, voided, and flagged check-ins (${special.length})</p></div>
      <button type="button" class="btn sm danger" id="clearTestBtn" ${!(data || []).some(r => r.is_test) ? 'disabled' : ''}>Clear test check-ins</button>
    </div>
    ${special.length ? `<ul class="feed">${special.map(r => `
      <li>
        <span>
          <b>${esc(r.profiles?.full_name || 'Unknown')}</b> ${r.profiles?.school_id ? `<small class="muted">(${esc(r.profiles.school_id)})</small>` : ''}
          ${r.is_test ? '<span class="badge dup">TEST</span>' : ''}
          ${r.voided ? '<span class="badge cancelled">VOIDED</span>' : ''}
          ${r.clock_suspect ? '<span class="badge">CLOCK SUSPECT</span>' : ''}
          <br><small class="muted">${fmt(r.checked_in_at)}${r.void_reason ? ` · ${esc(r.void_reason)}` : ''}</small>
        </span>
        <div class="row">
          ${r.voided
            ? `<button type="button" class="btn sm ok" data-restore="${r.id}">Restore</button>`
            : `<button type="button" class="btn sm ghost" data-void="${r.id}">Void</button>`}
        </div>
      </li>`).join('')}</ul>` : '<p class="muted sm">No test, voided, or flagged check-ins for this event.</p>'}
    <div class="row" style="justify-content:flex-end;margin-top:1rem"><button type="button" class="btn ghost" id="attClose">Close</button></div>
  `;

  $('#attClose').onclick = () => attDlg.close();
  $('#clearTestBtn').onclick = async () => {
    if (!confirm(`Delete all test check-ins for "${e.title}"? Real attendance records will not be touched.`)) return;
    const { data: cnt, error: ce } = await supabase.rpc('admin_clear_test_attendance', { p_event_id: e.id });
    if (ce) return toast(errMsg(ce), 'error');
    toast(`Cleared ${cnt ?? 0} test check-in(s).`, 'success');
    await load();
    openCheckinsModal(events.find(x => x.id === e.id) || e);
  };
  $('#attBody').onclick = async ev => {
    const rb = ev.target.closest('button[data-restore]');
    if (rb) {
      const { error: re } = await supabase.rpc('admin_restore_attendance', { p_attendance_id: rb.dataset.restore });
      if (re) return toast(errMsg(re), 'error');
      toast('Check-in restored.', 'success');
      await load();
      return openCheckinsModal(events.find(x => x.id === e.id) || e);
    }
    const vb = ev.target.closest('button[data-void]');
    if (vb) {
      const reason = prompt('Reason for voiding this check-in:', 'Voided by administrator');
      if (reason === null) return;
      const { error: ve } = await supabase.rpc('admin_void_attendance', { p_attendance_id: vb.dataset.void, p_reason: reason });
      if (ve) return toast(errMsg(ve), 'error');
      toast('Check-in voided.', 'success');
      await load();
      return openCheckinsModal(events.find(x => x.id === e.id) || e);
    }
  };
}

async function openCertsAdminModal(e) {
  const attDlg = $('#attDlg');
  $('#attBody').innerHTML = '<p class="muted">Loading certificates...</p>';
  attDlg.showModal();
  const { data: certs, error } = await supabase
    .from('certificates')
    .select('id,certificate_code,name_at_issuance,status,issued_at,revoke_reason,template_version')
    .eq('event_id', e.id)
    .order('issued_at', { ascending: false });
  if (error) { attDlg.close(); return toast(errMsg(error), 'error'); }

  $('#attBody').innerHTML = `
    <div class="pagehead" style="margin-bottom:.75rem">
      <div><h2 style="margin:0">${esc(e.title)} — Certificates (${(certs || []).length})</h2><p class="muted sm">Admins can revoke or reissue issued certificates.</p></div>
    </div>
    ${certs?.length ? `<ul class="feed">${certs.map(c => `
      <li>
        <span>
          <b>${esc(c.name_at_issuance)}</b> · <code>${esc(c.certificate_code)}</code>
          <span class="badge ${c.status === 'valid' ? 'ok' : 'cancelled'}">${esc(c.status)}</span>
          <br><small class="muted">Issued ${fmt(c.issued_at)} · Template v${c.template_version}${c.revoke_reason ? ` · Revoked: ${esc(c.revoke_reason)}` : ''}</small>
        </span>
        <div class="row">
          <a class="btn sm ghost" href="/verify/${encodeURIComponent(c.certificate_code)}" target="_blank" rel="noopener">Verify</a>
          ${c.status === 'valid'
            ? `<button type="button" class="btn sm danger" data-cert-revoke="${c.id}">Revoke</button>`
            : `<button type="button" class="btn sm ok" data-cert-reissue="${c.id}">Reissue</button>`}
        </div>
      </li>`).join('')}</ul>` : '<p class="muted sm">No certificates issued for this event yet.</p>'}
    <div class="row" style="justify-content:flex-end;margin-top:1rem"><button type="button" class="btn ghost" id="attClose">Close</button></div>`;

  $('#attClose').onclick = () => attDlg.close();
  $('#attBody').onclick = async ev => {
    const revBtn = ev.target.closest('button[data-cert-revoke]');
    if (revBtn) {
      const reason = prompt('Reason for revoking this certificate:');
      if (!reason) return;
      const { error: rErr } = await supabase.rpc('admin_revoke_certificate', { p_certificate_id: revBtn.dataset.certRevoke, p_reason: reason });
      if (rErr) return toast(errMsg(rErr), 'error');
      toast('Certificate revoked', 'info');
      await load();
      return openCertsAdminModal(events.find(x => x.id === e.id) || e);
    }
    const reBtn = ev.target.closest('button[data-cert-reissue]');
    if (reBtn) {
      const { error: reErr } = await supabase.rpc('admin_reissue_certificate', { p_certificate_id: reBtn.dataset.certReissue });
      if (reErr) return toast(errMsg(reErr), 'error');
      toast('Certificate reissued with updated profile name', 'success');
      await load();
      return openCertsAdminModal(events.find(x => x.id === e.id) || e);
    }
  };
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
['imgZoom', 'imgPanX', 'imgPanY'].forEach(id => { $(`#${id}`).oninput = applyPreviewCrop; });
['starts', 'ends', 'deadline', 'earlyGrace', 'lateGrace'].forEach(id => { $(`#${id}`).oninput = updateScheduleHint; });

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
if ($('#certEnabled')) {
  $('#certEnabled').onchange = () => { $('#certSetupWrap').hidden = !$('#certEnabled').checked; };
  $('#certNewTplBtn').onclick = () => openTemplateEditorModal({
    profile,
    initialTemplate: null,
    onSaved: saved => loadTemplates(saved?.id)
  });
  $('#certEditTplBtn').onclick = () => {
    const sel = templates.find(t => t.id === $('#certTemplate').value) || null;
    if (sel && sel.is_global && profile.role !== 'admin') {
      return toast('Global templates are read-only for organizers. Click "+ Upload / Design" to create your own template.', 'info');
    }
    openTemplateEditorModal({
      profile,
      initialTemplate: sel,
      onSaved: saved => loadTemplates(saved?.id)
    });
  };
}
$('#fbTestBtn').onclick = () => {
  const res = validateFeedbackUrl($('#fbUrl').value);
  if (!res.ok) return toast(res.error, 'error');
  if (!res.url) return toast('Paste a Google Form link first.', 'info');
  window.open(res.url, '_blank', 'noopener,noreferrer');
};
$('#form').onsubmit = async ev => {
  ev.preventDefault();
  const fbRes = validateFeedbackUrl($('#fbUrl').value);
  if (!fbRes.ok) return toast(fbRes.error, 'error');
  const row = {
    title: $('#title').value.trim(), venue: $('#venue').value.trim(), description: $('#desc').value.trim() || null,
    starts_at: parseManilaInput($('#starts').value),
    ends_at: parseManilaInput($('#ends').value),
    registration_opens_at: parseManilaInput($('#regOpens').value),
    registration_deadline: parseManilaInput($('#deadline').value),
    early_grace_minutes: Math.max(0, Math.min(1440, parseInt($('#earlyGrace').value || '60', 10))),
    late_grace_minutes: Math.max(0, Math.min(1440, parseInt($('#lateGrace').value || '60', 10))),
    late_after_minutes: $('#lateAfter').value.trim() === '' ? null : Math.max(0, Math.min(1440, parseInt($('#lateAfter').value, 10))),
    capacity: $('#cap').value ? parseInt($('#cap').value, 10) : null,
    status: $('#status').value,
    allow_early_test_attendance: false,
    feedback_url: fbRes.url,
    feedback_audience: $('#fbAudience').value || 'attended',
    certificates_enabled: $('#certEnabled') ? $('#certEnabled').checked : true,
    certificate_template_id: $('#certTemplate')?.value || DEFAULT_TEMPLATE_ID,
    allowed_schools: $('#eligSchool')?.value ? [$('#eligSchool').value] : null,
    allowed_programs: $('#eligProgram')?.value ? [$('#eligProgram').value] : null,
    allowed_year_levels: (() => {
      const checked = [...document.querySelectorAll('#eligYears input[type="checkbox"]:checked')].map(cb => Number(cb.value));
      return checked.length ? checked : null;
    })()
  };
  if (!row.starts_at || !row.ends_at || new Date(row.ends_at) <= new Date(row.starts_at)) {
    return toast('Event end must be after start', 'error');
  }
  if (row.registration_opens_at && row.registration_deadline && new Date(row.registration_opens_at) > new Date(row.registration_deadline)) {
    return toast('Registration opens must be before or equal to the registration deadline', 'error');
  }
  if (row.registration_deadline && new Date(row.registration_deadline) > new Date(row.ends_at)) {
    return toast('Registration deadline must be on or before the event end', 'error');
  }
  if (editingOrig && (editingOrig.registered_count > 0 || editingOrig.attended_count > 0)) {
    const timesChanged = new Date(row.starts_at).getTime() !== new Date(editingOrig.starts_at).getTime()
      || new Date(row.ends_at).getTime() !== new Date(editingOrig.ends_at).getTime();
    if (timesChanged && !confirm('This event already has registrations or attendance. Changing event times may affect existing schedule windows. Continue?')) {
      return;
    }
  }

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
  if (b.dataset.a === 'att') return openCheckinsModal(e);
  if (b.dataset.a === 'certs') return openCertsAdminModal(e);
  if (b.dataset.a === 'fbEarly') {
    const next = !e.feedback_opened_early;
    const msg = next
      ? `Open the feedback form now for "${e.title}" before its scheduled end time?`
      : `Turn off early feedback for "${e.title}"?`;
    if (!confirm(msg)) return;
    const { error } = await supabase.rpc('admin_set_feedback_early', { p_event_id: e.id, p_open: next });
    if (error) toast(errMsg(error), 'error'); else { toast(next ? 'Feedback opened early' : 'Early feedback closed', 'success'); load(); }
  }
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
