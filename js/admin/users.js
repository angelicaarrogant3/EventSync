import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import { COURSES } from '/js/shared/participant-options.js';
import { EMAIL_RE, passwordIssues } from '/js/shared/validation.js';

const { profile: me } = await boot('admin', 'users');

const PAGE_SIZE = 25;
let allUsers = [];
let summary = { total: 0, participants: 0, administrators: 0, active: 0, new_this_week: 0 };
let sortKey = 'created_at', sortDir = -1; // -1 = desc (newest signup first)
let shown = PAGE_SIZE;

const roleLabel = r => r === 'admin' ? 'Administrator' : 'Participant';
const courseYear = u => u.course ? (u.member_type === 'student' && u.year_level ? `${u.course} ${u.year_level}` : u.course) : '—';

async function load() {
  const { data, error } = await supabase.rpc('admin_list_users');
  if (error) return toast(errMsg(error), 'error');
  summary = data.summary || summary;
  allUsers = data.users || [];
  renderSummary();
  populateCourses();
  render();
}

function renderSummary() {
  $('#sTotal').textContent = summary.total;
  $('#sPart').textContent = summary.participants;
  $('#sAdmin').textContent = summary.administrators;
  $('#sActive').textContent = summary.active;
  $('#sWeek').textContent = summary.new_this_week;
}

function populateCourses() {
  const cur = $('#fCourse').value;
  const set = new Set(COURSES);
  allUsers.forEach(u => { if (u.course) set.add(u.course); });
  $('#fCourse').innerHTML = '<option value="">All courses</option>' + [...set].sort().map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#fCourse').value = cur;
}

function filteredSorted() {
  const q = $('#q').value.trim().toLowerCase();
  const r = $('#fRole').value, st = $('#fStatus').value, cr = $('#fCourse').value;
  const list = allUsers.filter(u => {
    if (r && u.role !== r) return false;
    if (st && u.status !== st) return false;
    if (cr && u.course !== cr) return false;
    if (q && !`${u.full_name} ${u.email} ${u.school_id || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  list.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (sortKey === 'course') { va = courseYear(a); vb = courseYear(b); }
    if (typeof va === 'number' || typeof vb === 'number') return ((va ?? 0) - (vb ?? 0)) * sortDir;
    return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { sensitivity: 'base' }) * sortDir;
  });
  return list;
}

const COLS = [
  ['full_name', 'Full Name'], ['school_id', 'School ID'], ['email', 'Email'],
  ['role', 'Role'], ['course', 'Course / Year'], ['status', 'Status'],
  ['created_at', 'Signed up'], ['events_registered', 'Registered'], ['events_attended', 'Attended']
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
  $('#list').innerHTML = `<div class="tablewrap users-table"><table><thead><tr>${COLS.map(([k, l]) => `<th class="sort" data-sort="${k}">${l}${arrow(k)}</th>`).join('')}</tr></thead><tbody>${visible.map(u => `
    <tr class="clickable" data-uid="${u.id}">
      <td data-label="Full Name"><b>${esc(u.full_name || '—')}</b>${u.member_type ? `<br><small class="muted">${esc(u.member_type)}</small>` : ''}</td>
      <td data-label="School ID">${esc(u.school_id || '—')}</td>
      <td data-label="Email">${esc(u.email)}</td>
      <td data-label="Role"><span class="badge ${u.role === 'admin' ? 'published' : ''}">${roleLabel(u.role)}</span></td>
      <td data-label="Course / Year">${esc(courseYear(u))}</td>
      <td data-label="Status"><span class="badge ${u.status === 'active' ? 'ok' : 'cancelled'}">${u.status}</span></td>
      <td data-label="Signed up">${fmt(u.created_at)}</td>
      <td data-label="Registered">${u.events_registered}</td>
      <td data-label="Attended">${u.events_attended}</td>
    </tr>`).join('')}</tbody></table></div>`;

  if (rows.length > visible.length) {
    $('#pager').hidden = false;
    $('#pageInfo').textContent = `Showing ${visible.length} of ${rows.length}`;
  } else {
    $('#pager').hidden = true;
  }
}

/* ---- sorting, filtering, pagination ---- */
$('#list').addEventListener('click', ev => {
  const th = ev.target.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === 'created_at' ? -1 : 1; }
    return render();
  }
  const tr = ev.target.closest('tr[data-uid]');
  if (tr) openDetail(tr.dataset.uid);
});
['#q', '#fRole', '#fStatus', '#fCourse'].forEach(s => $(s).addEventListener(s === '#q' ? 'input' : 'change', () => { shown = PAGE_SIZE; render(); }));
$('#loadMore').onclick = () => { shown += PAGE_SIZE; render(); };

/* ---- detail panel + actions ---- */
async function openDetail(uid) {
  const dlg = $('#detailDlg');
  $('#detailBody').innerHTML = '<p class="muted">Loading...</p>';
  dlg.showModal();
  const { data, error } = await supabase.rpc('admin_user_detail', { p_user_id: uid });
  if (error) { dlg.close(); return toast(errMsg(error), 'error'); }
  const u = data.profile, regs = data.registrations || [];
  const isSelf = u.id === me.id;
  const nextStatus = u.status === 'active' ? 'inactive' : 'active';
  $('#detailBody').innerHTML = `
    <div class="pagehead" style="margin-bottom:.5rem">
      <div><h2>${esc(u.full_name || u.email)}</h2><p class="muted sm">${esc(u.email)} · ${roleLabel(u.role)}</p></div>
      <span class="badge ${u.status === 'active' ? 'ok' : 'cancelled'}">${u.status}</span>
    </div>
    <div class="two sm" style="margin-bottom:1rem">
      <div><b>School ID:</b> ${esc(u.school_id || '—')}</div>
      <div><b>Contact:</b> ${esc(u.contact_number || '—')}</div>
      <div><b>Type:</b> ${esc(u.member_type || '—')}</div>
      <div><b>Course / Year:</b> ${esc(courseYear(u))}</div>
      <div><b>Section:</b> ${esc(u.section || '—')}</div>
      <div><b>Signed up:</b> ${fmt(u.created_at)}</div>
    </div>
    <div class="row" style="margin-bottom:1rem">
      <button class="btn sm ${u.status === 'active' ? 'danger' : 'ok'}" id="toggleStatus" ${isSelf ? 'disabled title="You cannot deactivate your own account"' : ''}>
        ${u.status === 'active' ? 'Deactivate account' : 'Reactivate account'}
      </button>
      ${u.role === 'user' ? '<button class="btn sm ghost" id="resetPwBtn">Reset password</button>' : ''}
    </div>
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
  $('#toggleStatus').onclick = async () => {
    if (nextStatus === 'inactive' && !confirm(`Deactivate ${u.full_name || u.email}? They will be logged out and unable to sign in.`)) return;
    const { error: e2 } = await supabase.rpc('admin_set_user_status', { p_user_id: u.id, p_status: nextStatus });
    if (e2) return toast(errMsg(e2), 'error');
    toast(`Account ${nextStatus === 'inactive' ? 'deactivated' : 'reactivated'}`, 'success');
    dlg.close(); load();
  };
  const rBtn = $('#resetPwBtn');
  if (rBtn) {
    rBtn.onclick = () => { $('#resetForm').hidden = !$('#resetForm').hidden; };
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
}

/* ---- create admin ---- */
$('#newAdminBtn').onclick = () => { $('#aMsg').innerHTML = ''; $('#adminForm').reset(); $('#adminDlg').showModal(); };
$('#aCancel').onclick = () => $('#adminDlg').close();
$('#adminForm').onsubmit = async ev => {
  ev.preventDefault(); $('#aMsg').innerHTML = '';
  const name = $('#aName').value.trim(), email = $('#aEmail').value.trim().toLowerCase(), pw = $('#aPw').value, pw2 = $('#aPw2').value;
  if (name.length < 2) return ($('#aMsg').innerHTML = '<div class="err">Full name is required</div>');
  if (!EMAIL_RE.test(email)) return ($('#aMsg').innerHTML = '<div class="err">Enter a valid email</div>');
  const issues = passwordIssues(pw);
  if (issues.length) return ($('#aMsg').innerHTML = `<div class="err">Password needs: ${esc(issues.join(', ').toLowerCase())}</div>`);
  if (pw !== pw2) return ($('#aMsg').innerHTML = '<div class="err">Passwords do not match</div>');
  const btn = $('#aSave'); btn.disabled = true;
  try {
    const { error } = await supabase.rpc('admin_create_admin', { p_full_name: name, p_email: email, p_password: pw });
    if (error) throw error;
    toast(`Administrator ${email} created`, 'success');
    $('#adminDlg').close(); load();
  } catch (e) { $('#aMsg').innerHTML = `<div class="err">${esc(errMsg(e))}</div>`; }
  finally { btn.disabled = false; }
};

/* ---- export user list (.xlsx) ---- */
$('#exportXlsx').onclick = async () => {
  try {
    if (!window.ExcelJS) throw new Error('Excel library failed to load.');
    const rows = filteredSorted();
    const { error } = await supabase.rpc('log_export', { p_kind: 'users_list', p_details: { format: 'xlsx', rows: rows.length } });
    if (error) throw error;
    const wb = new window.ExcelJS.Workbook(); wb.creator = 'EventSync';
    const ws = wb.addWorksheet('Users', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const head = ['Full Name', 'School ID', 'Email', 'Role', 'Course / Year', 'Status', 'Signed up', 'Events Registered', 'Events Attended'];
    const data = rows.map(u => [u.full_name || '-', u.school_id || '-', u.email, roleLabel(u.role), courseYear(u), u.status, fmt(u.created_at), u.events_registered, u.events_attended]);
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
watch(['profiles', 'registrations', 'attendance'], load);
