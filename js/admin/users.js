import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import {
  PROGRAM_SCHOOLS, ADMIN_OFFICE_SCHOOL, OTHER_SCHOOL_NAME, NEEDS_UPDATE_LABEL,
  MEMBER_TYPES, YEAR_LEVELS, validateProgramSelection,
  formatProgramShort, formatProgramFull
} from '/js/shared/participant-options.js';
import { mountProgramSelector } from '/js/shared/program-selector.js';

const { profile: me } = await boot('admin', 'users');

const PAGE_SIZE = 25;
let allUsers = [];
let sortKey = 'created_at', sortDir = -1; // -1 = desc (newest signup first)
let shown = PAGE_SIZE;

const courseYear = u => formatProgramShort(u);
const schoolLabel = u => u.program_needs_update ? NEEDS_UPDATE_LABEL : (u.department || '—');

async function load() {
  const [{ data, error }, { data: reqs }] = await Promise.all([
    supabase.rpc('admin_list_users'),
    supabase.rpc('admin_list_role_requests')
  ]);
  if (error) return toast(errMsg(error), 'error');
  allUsers = (data.users || []).filter(u => u.role === 'user' || u.role === 'organizer');
  renderRoleRequests(Array.isArray(reqs) ? reqs : []);
  renderSummary();
  populateSchools();
  populatePrograms();
  render();
}

function renderRoleRequests(reqs) {
  const card = $('#roleReqCard'), listEl = $('#roleReqList'), badge = $('#reqCountBadge');
  if (!card || !listEl) return;
  const pending = reqs.filter(r => r.status === 'pending');
  if (!reqs.length) { card.hidden = true; return; }
  card.hidden = false;
  badge.textContent = `${pending.length} pending`;
  listEl.innerHTML = reqs.slice(0, 12).map(r => {
    const stBadge = r.status === 'pending'
      ? '<span class="badge dup">Pending</span>'
      : r.status === 'approved'
        ? '<span class="badge ok">Approved</span>'
        : '<span class="badge cancelled">Rejected</span>';
    const actions = r.status === 'pending'
      ? `<div class="row">
           <button type="button" class="btn sm ok" data-req-approve="${r.id}" ${r.user_id === me.id ? 'disabled title="Cannot approve your own request"' : ''}>Approve</button>
           <button type="button" class="btn sm danger" data-req-reject="${r.id}" ${r.user_id === me.id ? 'disabled title="Cannot reject your own request"' : ''}>Reject</button>
         </div>`
      : `<small class="muted">${r.reviewer_name ? `by ${esc(r.reviewer_name)} · ` : ''}${fmt(r.reviewed_at || r.created_at)}</small>`;
    return `<li>
      <span>
        <b>${esc(r.full_name || r.email)}</b> ${r.school_id ? `<small class="muted">(${esc(r.school_id)})</small>` : ''} ${stBadge}
        <br><small class="muted"><b>Reason:</b> ${esc(r.reason)} · <b>Planned events:</b> ${esc(r.planned_events)}${r.decision_reason ? ` · <b>Note:</b> ${esc(r.decision_reason)}` : ''}</small>
      </span>
      ${actions}
    </li>`;
  }).join('');
}

$('#roleReqList')?.addEventListener('click', async ev => {
  const appBtn = ev.target.closest('button[data-req-approve]');
  if (appBtn) {
    appBtn.disabled = true;
    const { error } = await supabase.rpc('admin_review_role_request', { p_request_id: appBtn.dataset.reqApprove, p_decision: 'approved', p_decision_reason: null });
    if (error) { appBtn.disabled = false; return toast(errMsg(error), 'error'); }
    toast('Request approved — account is now an Event Organizer', 'success');
    return load();
  }
  const rejBtn = ev.target.closest('button[data-req-reject]');
  if (rejBtn) {
    const reason = prompt('Optional reason for rejecting this request:', '');
    if (reason === null) return;
    rejBtn.disabled = true;
    const { error } = await supabase.rpc('admin_review_role_request', { p_request_id: rejBtn.dataset.reqReject, p_decision: 'rejected', p_decision_reason: reason });
    if (error) { rejBtn.disabled = false; return toast(errMsg(error), 'error'); }
    toast('Request rejected', 'info');
    return load();
  }
});

function renderSummary() {
  const weekAgo = Date.now() - 7 * 86400e3;
  const active = allUsers.filter(u => u.status === 'active').length;
  $('#sPart').textContent = allUsers.length;
  $('#sActive').textContent = active;
  $('#sInactive').textContent = allUsers.length - active;
  $('#sWeek').textContent = allUsers.filter(u => new Date(u.created_at).getTime() >= weekAgo).length;
}

function populateSchools() {
  const cur = $('#fSchool').value;
  const schools = [...PROGRAM_SCHOOLS.map(s => s.name), ADMIN_OFFICE_SCHOOL.name, OTHER_SCHOOL_NAME];
  allUsers.forEach(u => { if (u.department && !schools.includes(u.department)) schools.push(u.department); });
  $('#fSchool').innerHTML = '<option value="">All schools</option>' +
    schools.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('') +
    `<option value="${NEEDS_UPDATE_LABEL}">${NEEDS_UPDATE_LABEL}</option>`;
  $('#fSchool').value = cur;
}

function populatePrograms() {
  const sc = $('#fSchool').value;
  const cur = $('#fProgram').value;
  const set = new Set();
  const src = sc ? PROGRAM_SCHOOLS.filter(s => s.name === sc) : PROGRAM_SCHOOLS;
  src.forEach(s => s.programs.forEach(p => set.add(p.name)));
  allUsers.forEach(u => {
    if (u.program && (!sc || u.department === sc)) set.add(u.program);
  });
  $('#fProgram').innerHTML = '<option value="">All programs</option>' +
    [...set].sort().map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('') +
    `<option value="${NEEDS_UPDATE_LABEL}">${NEEDS_UPDATE_LABEL}</option>`;
  if ([...$('#fProgram').options].some(o => o.value === cur)) $('#fProgram').value = cur;
}

function filteredSorted() {
  const q = $('#q').value.trim().toLowerCase();
  const rl = $('#fRole')?.value || '';
  const st = $('#fStatus').value, sc = $('#fSchool').value, pr = $('#fProgram').value;
  const list = allUsers.filter(u => {
    if (rl && u.role !== rl) return false;
    if (st && u.status !== st) return false;
    if (sc === NEEDS_UPDATE_LABEL ? !u.program_needs_update : (sc && u.department !== sc)) return false;
    if (pr === NEEDS_UPDATE_LABEL ? !u.program_needs_update : (pr && u.program !== pr)) return false;
    if (q && !`${u.full_name} ${u.email} ${u.school_id || ''} ${u.department || ''} ${u.program || ''} ${u.major || ''} ${u.role || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  list.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (sortKey === 'department') { va = schoolLabel(a); vb = schoolLabel(b); }
    if (sortKey === 'course') { va = courseYear(a); vb = courseYear(b); }
    if (typeof va === 'number' || typeof vb === 'number') return ((va ?? 0) - (vb ?? 0)) * sortDir;
    return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { sensitivity: 'base' }) * sortDir;
  });
  return list;
}

const COLS = [
  ['full_name', 'Full Name'], ['role', 'Role'], ['school_id', 'School ID'], ['email', 'Email'],
  ['department', 'School'], ['course', 'Program (Major) / Year'], ['status', 'Status'],
  ['events_registered', 'Reg'], ['events_attended', 'Att']
];

function render() {
  const rows = filteredSorted();
  const visible = rows.slice(0, shown);
  if (!rows.length) {
    $('#list').innerHTML = '<div class="card empty">No matching users found.</div>';
    $('#pager').hidden = true;
    return;
  }
  const arrow = k => sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
  $('#list').innerHTML = `<div class="tablewrap users-table"><table><thead><tr>${COLS.map(([k, l]) => `<th class="sort" data-sort="${k}">${l}${arrow(k)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${visible.map(u => `
    <tr class="clickable" data-uid="${u.id}">
      <td data-label="Full Name"><b>${esc(u.full_name || '—')}</b>${u.member_type ? `<br><small class="muted">${esc(u.member_type)}</small>` : ''}</td>
      <td data-label="Role"><span class="badge ${u.role === 'organizer' ? 'ok' : ''}">${u.role === 'organizer' ? 'Organizer' : 'Participant'}</span></td>
      <td data-label="School ID">${esc(u.school_id || '—')}</td>
      <td data-label="Email">${esc(u.email)}</td>
      <td data-label="School">${esc(schoolLabel(u))}</td>
      <td data-label="Program (Major) / Year" title="${esc(formatProgramFull(u))}">${esc(courseYear(u))}</td>
      <td data-label="Status"><span class="badge ${u.status === 'active' ? 'ok' : 'cancelled'}">${u.status}</span></td>
      <td data-label="Reg">${u.events_registered}</td>
      <td data-label="Att">${u.events_attended}</td>
      <td data-label="Actions">
        <div class="row" style="gap:.35rem">
          ${u.role === 'organizer'
            ? `<button type="button" class="btn sm ghost" data-quick-role="user" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}" title="Revoke Event Organizer rights">Revoke Organizer</button>`
            : `<button type="button" class="btn sm ok" data-quick-role="organizer" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}" title="Grant Event Organizer rights directly">Make Organizer</button>`}
          <button type="button" class="btn sm ghost" data-edit-uid="${u.id}">Edit</button>
          <button type="button" class="btn sm danger" data-del-uid="${u.id}" data-name="${esc(u.full_name || u.email)}">Delete</button>
        </div>
      </td>
    </tr>`).join('')}</tbody></table></div>`;

  if (rows.length > visible.length) {
    $('#pager').hidden = false;
    $('#pageInfo').textContent = `Showing ${visible.length} of ${rows.length}`;
  } else {
    $('#pager').hidden = true;
  }
}

/* ---- sorting, filtering, pagination ---- */
$('#list').addEventListener('click', async ev => {
  const th = ev.target.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === 'created_at' ? -1 : 1; }
    return render();
  }
  const roleBtn = ev.target.closest('button[data-quick-role]');
  if (roleBtn) {
    ev.stopPropagation();
    const nextRole = roleBtn.dataset.quickRole;
    const nm = roleBtn.dataset.name;
    const msg = nextRole === 'organizer'
      ? `Make "${nm}" an Event Organizer immediately (without requiring a role request)?`
      : `Revoke Event Organizer rights from "${nm}" and return them to Participant?`;
    if (!confirm(msg)) return;
    roleBtn.disabled = true;
    const { error } = await supabase.rpc('admin_set_user_role', { p_user_id: roleBtn.dataset.uid, p_role: nextRole });
    if (error) { roleBtn.disabled = false; return toast(errMsg(error), 'error'); }
    toast(nextRole === 'organizer' ? `${nm} is now an Event Organizer` : `Organizer rights revoked for ${nm}`, 'success');
    return load();
  }
  const delBtn = ev.target.closest('button[data-del-uid]');
  if (delBtn) {
    ev.stopPropagation();
    const nm = delBtn.dataset.name;
    if (!confirm(`Permanently delete user "${nm}" and all their registrations and records?`)) return;
    delBtn.disabled = true;
    const { error } = await supabase.rpc('admin_delete_user', { p_user_id: delBtn.dataset.delUid });
    if (error) { delBtn.disabled = false; return toast(errMsg(error), 'error'); }
    toast(`Deleted ${nm}`, 'info');
    return load();
  }
  const editBtn = ev.target.closest('button[data-edit-uid]');
  if (editBtn) {
    ev.stopPropagation();
    return openDetail(editBtn.dataset.editUid, true);
  }
  const tr = ev.target.closest('tr[data-uid]');
  if (tr) openDetail(tr.dataset.uid, false);
});
$('#fSchool').addEventListener('change', () => { populatePrograms(); shown = PAGE_SIZE; render(); });
['#q', '#fRole', '#fStatus', '#fProgram'].forEach(s => $(s)?.addEventListener(s === '#q' ? 'input' : 'change', () => { shown = PAGE_SIZE; render(); }));
$('#loadMore').onclick = () => { shown += PAGE_SIZE; render(); };

/* ---- detail panel + CRUD actions ---- */
async function openDetail(uid, startInEditMode = false) {
  const dlg = $('#detailDlg');
  $('#detailBody').innerHTML = '<p class="muted">Loading...</p>';
  dlg.showModal();
  const { data, error } = await supabase.rpc('admin_user_detail', { p_user_id: uid });
  if (error) { dlg.close(); return toast(errMsg(error), 'error'); }
  const u = data.profile, regs = data.registrations || [];
  const isSelf = u.id === me.id;
  const nextStatus = u.status === 'active' ? 'inactive' : 'active';
  const roleLabel = u.role === 'organizer' ? 'Event Organizer' : u.role === 'admin' ? 'Administrator' : 'Participant';
  $('#detailBody').innerHTML = `
    <div class="pagehead" style="margin-bottom:.5rem">
      <div><h2>${esc(u.full_name || u.email)}</h2><p class="muted sm">${esc(u.email)} · <span class="badge ${u.role === 'organizer' ? 'ok' : ''}">${roleLabel}</span></p></div>
      <span class="badge ${u.status === 'active' ? 'ok' : 'cancelled'}">${u.status}</span>
    </div>
    <div class="two sm" style="margin-bottom:1rem">
      <div><b>School ID:</b> ${esc(u.school_id || '—')}</div>
      <div><b>Contact:</b> ${esc(u.contact_number || '—')}</div>
      <div><b>Type:</b> ${esc(u.member_type || '—')}</div>
      <div><b>School:</b> ${esc(schoolLabel(u))}</div>
      <div><b>Program / Year:</b> ${esc(formatProgramFull(u))}</div>
      <div><b>Section:</b> ${esc(u.section || '—')}</div>
      <div><b>Signed up:</b> ${fmt(u.created_at)}</div>
      <div><b>Role:</b> ${roleLabel}</div>
    </div>
    <div class="row" style="margin-bottom:1rem;flex-wrap:wrap;gap:.45rem">
      ${!isSelf ? `<button class="btn sm ${u.role === 'organizer' ? 'ghost' : 'ok'}" id="toggleRoleBtn">${u.role === 'organizer' ? 'Revoke Organizer Role' : 'Make Event Organizer'}</button>` : ''}
      <button class="btn sm ghost" id="editProfileBtn">Edit user &amp; role</button>
      <button class="btn sm ghost" id="resetPwBtn">Reset password</button>
      <button class="btn sm ${u.status === 'active' ? 'danger' : 'ok'}" id="toggleStatus" ${isSelf ? 'disabled title="You cannot deactivate your own account"' : ''}>
        ${u.status === 'active' ? 'Deactivate' : 'Reactivate'}
      </button>
      ${!isSelf ? `<button class="btn sm danger" id="deleteUserBtn">Delete user</button>` : ''}
    </div>

    <form id="editUserForm" ${startInEditMode ? '' : 'hidden'} style="margin-bottom:1rem;padding:.85rem;border:1px solid var(--line);border-radius:10px">
      <h3 style="margin:0 0 .65rem;font-size:.98rem">Edit User Profile &amp; Role</h3>
      <div class="two">
        <div><label for="euName">Full name *</label><input id="euName" required minlength="2" value="${esc(u.full_name || '')}"></div>
        <div><label for="euRole">Role</label>
          <select id="euRole" ${isSelf ? 'disabled' : ''}>
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>Participant</option>
            <option value="organizer" ${u.role === 'organizer' ? 'selected' : ''}>Event Organizer</option>
          </select>
        </div>
        <div><label for="euSchoolId">School / Employee ID</label><input id="euSchoolId" value="${esc(u.school_id || '')}" placeholder="e.g., 21-1-0123"></div>
        <div><label for="euContact">Contact number</label><input id="euContact" value="${esc(u.contact_number || '')}" placeholder="09XXXXXXXXX"></div>
        <div><label for="euMemberType">Member type</label>
          <select id="euMemberType">
            <option value="">Select…</option>
            ${MEMBER_TYPES.map(t => `<option value="${t.value}" ${u.member_type === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
        <div><label for="euYear">Year level (students)</label>
          <select id="euYear">
            <option value="">—</option>
            ${YEAR_LEVELS.map(y => `<option value="${y.value}" ${Number(u.year_level) === Number(y.value) ? 'selected' : ''}>${y.label}</option>`).join('')}
          </select>
        </div>
        <div><label for="euSection">Section</label><input id="euSection" value="${esc(u.section || '')}"></div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:.75rem">
        <button type="submit" class="btn sm">Save changes</button>
      </div>
    </form>

    <form id="resetForm" hidden style="margin-bottom:1rem;padding:.75rem;border:1px solid var(--line);border-radius:10px">
      <label for="tempPw">Temporary password (min 8 chars)</label>
      <div class="row"><input id="tempPw" type="text" minlength="8" required placeholder="Enter temporary password" style="flex:1"><button class="btn sm">Set password</button></div>
      <small class="muted">User will be forced to change this password at next login.</small>
    </form>
    <h3>Registrations (${regs.length})</h3>
    ${regs.length ? `<ul class="feed">${regs.map(r => {
      const st = r.status === 'cancelled' ? ['cancelled', 'Cancelled'] : r.checked_in_at ? ['ok', `Attended · ${fmt(r.checked_in_at)}`] : ['registered', 'Registered'];
      return `<li><span><b>${esc(r.event_title)}</b><br><small class="muted">${fmt(r.starts_at)} · ${esc(r.venue)}</small></span><span class="badge ${st[0]}">${st[1]}</span></li>`;
    }).join('')}</ul>` : '<p class="muted sm">No event registrations.</p>'}
    <div class="row" style="justify-content:flex-end;margin-top:1rem"><button type="button" class="btn ghost" id="dClose">Close</button></div>`;

  $('#dClose').onclick = () => dlg.close();
  $('#editProfileBtn').onclick = () => { $('#editUserForm').hidden = !$('#editUserForm').hidden; };
  $('#editUserForm').onsubmit = async ev => {
    ev.preventDefault();
    const payload = {
      full_name: $('#euName').value.trim(),
      role: $('#euRole').value,
      school_id: $('#euSchoolId').value.trim() || null,
      contact_number: $('#euContact').value.trim() || null,
      member_type: $('#euMemberType').value || null,
      department: u.department,
      program: u.program,
      major: u.major,
      course: u.course,
      year_level: $('#euYear').value || null,
      section: $('#euSection').value.trim() || null
    };
    const { error: uErr } = await supabase.rpc('admin_update_user', { p_user_id: u.id, p: payload });
    if (uErr) return toast(errMsg(uErr), 'error');
    toast('User updated', 'success');
    dlg.close(); load();
  };

  const roleBtn = $('#toggleRoleBtn');
  if (roleBtn) {
    roleBtn.onclick = async () => {
      const nextRole = u.role === 'organizer' ? 'user' : 'organizer';
      const label = nextRole === 'organizer' ? 'Event Organizer' : 'Participant';
      if (!confirm(nextRole === 'organizer'
        ? `Make ${u.full_name || u.email} an Event Organizer immediately?`
        : `Revoke Event Organizer rights from ${u.full_name || u.email}?`)) return;
      const { error: rErr } = await supabase.rpc('admin_set_user_role', { p_user_id: u.id, p_role: nextRole });
      if (rErr) return toast(errMsg(rErr), 'error');
      toast(`Role updated to ${label}`, 'success');
      dlg.close(); load();
    };
  }
  const delBtn = $('#deleteUserBtn');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm(`Permanently delete ${u.full_name || u.email} and all their registrations?`)) return;
      const { error: dErr } = await supabase.rpc('admin_delete_user', { p_user_id: u.id });
      if (dErr) return toast(errMsg(dErr), 'error');
      toast('User deleted', 'info');
      dlg.close(); load();
    };
  }
  $('#toggleStatus').onclick = async () => {
    if (nextStatus === 'inactive' && !confirm(`Deactivate ${u.full_name || u.email}? They will be logged out and unable to sign in.`)) return;
    const { error: e2 } = await supabase.rpc('admin_set_user_status', { p_user_id: u.id, p_status: nextStatus });
    if (e2) return toast(errMsg(e2), 'error');
    toast(`Account ${nextStatus === 'inactive' ? 'deactivated' : 'reactivated'}`, 'success');
    dlg.close(); load();
  };
  $('#resetPwBtn').onclick = () => { $('#resetForm').hidden = !$('#resetForm').hidden; };
  $('#resetForm').onsubmit = async ev => {
    ev.preventDefault();
    const pw = $('#tempPw').value;
    if (pw.length < 8) return toast('Temporary password must be at least 8 characters', 'error');
    const { error: e3 } = await supabase.rpc('admin_reset_user_password', { p_user_id: u.id, p_temp_password: pw });
    if (e3) return toast(errMsg(e3), 'error');
    toast('Temporary password set. User must change it on next login.', 'success');
    $('#resetForm').hidden = true; $('#resetForm').reset();
  };
}

/* ---- Create User / Event Organizer modal ---- */
const cuDlg = $('#createUserDlg');
if (cuDlg) {
  $('#cuMemberType').innerHTML = '<option value="">Select…</option>' + MEMBER_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
  $('#cuYear').innerHTML = '<option value="">Select…</option>' + YEAR_LEVELS.map(y => `<option value="${y.value}">${y.label}</option>`).join('');
  const cuProg = mountProgramSelector($('#cuProgMount'), { idPrefix: 'cu', memberType: '' });
  $('#cuMemberType').onchange = () => {
    const mt = $('#cuMemberType').value;
    $('#cuYearWrap').hidden = mt !== 'student';
    cuProg.setMemberType(mt);
  };
  $('#newUserBtn').onclick = () => {
    $('#createUserForm').reset();
    $('#cuYearWrap').hidden = true;
    cuProg.setMemberType('');
    cuDlg.showModal();
  };
  $('#cuCancel').onclick = () => cuDlg.close();
  $('#createUserForm').onsubmit = async ev => {
    ev.preventDefault();
    const mt = $('#cuMemberType').value;
    const pv = cuProg.values();
    let dept = pv.department || null, prog = pv.program || null, maj = pv.major || null, crs = pv.course || null;
    if (mt) {
      const vRes = validateProgramSelection({ member_type: mt, ...pv });
      if (vRes.error) { cuProg.showErrors({ [vRes.field || 'department']: vRes.error }); return; }
      dept = vRes.department; prog = vRes.program; maj = vRes.major; crs = vRes.course;
    }
    const btn = $('#cuSubmit');
    btn.disabled = true;
    const { error } = await supabase.rpc('admin_create_user', {
      p: {
        full_name: $('#cuName').value.trim(),
        role: $('#cuRole').value,
        email: $('#cuEmail').value.trim(),
        password: $('#cuPassword').value,
        school_id: $('#cuSchoolId').value.trim() || null,
        contact_number: $('#cuContact').value.trim() || null,
        member_type: mt || null,
        department: dept,
        program: prog,
        major: maj,
        course: crs,
        year_level: mt === 'student' ? $('#cuYear').value : null,
        section: $('#cuSection').value.trim() || null
      }
    });
    btn.disabled = false;
    if (error) return toast(errMsg(error), 'error');
    toast(`Created ${$('#cuRole').value === 'organizer' ? 'Event Organizer' : 'Participant'} account`, 'success');
    cuDlg.close();
    load();
  };
}

/* ---- export user list (.xlsx) ---- */
$('#exportXlsx').onclick = async () => {
  try {
    if (!window.ExcelJS) throw new Error('Excel library failed to load.');
    const rows = filteredSorted();
    const { error } = await supabase.rpc('log_export', { p_kind: 'users_list', p_details: { format: 'xlsx', rows: rows.length } });
    if (error) throw error;
    const wb = new window.ExcelJS.Workbook(); wb.creator = 'EventSync';
    const ws = wb.addWorksheet('Users', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const head = ['Full Name', 'School ID', 'Email', 'School', 'Program (Major) / Year', 'Status', 'Signed up', 'Events Registered', 'Events Attended'];
    const data = rows.map(u => [u.full_name || '-', u.school_id || '-', u.email, schoolLabel(u), courseYear(u), u.status, fmt(u.created_at), u.events_registered, u.events_attended]);
    head.forEach((h, i) => {
      const c = ws.getCell(1, i + 1);
      c.value = h; c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E9F5' } };
      ws.getColumn(i + 1).width = Math.min(Math.max(h.length, ...data.map(r => String(r[i]).length)) + 3, 45);
    });
    data.forEach((r, ri) => r.forEach((v, ci) => { ws.getCell(ri + 2, ci + 1).value = v; }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = 'eventsync-users.xlsx'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  } catch (e) { toast(errMsg(e), 'error'); }
};

await load();
watch(['profiles', 'registrations', 'attendance', 'role_requests'], load);
