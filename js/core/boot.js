import { supabase, configMissing } from '/js/core/supabase.js';
import { startNetworkMonitor, esc, toast, errMsg, initPasswordEyes } from '/js/core/ui.js';
import { passwordIssues } from '/js/shared/validation.js';
import { ICONS } from '/js/shared/icons.js';

const NAV = {
  admin: [
    ['events', '/admin/events', 'Events'],
    ['registrations', '/admin/registrations', 'Registrations'],
    ['scan', '/admin/scan', 'Scan QR'],
    ['monitor', '/admin/monitor', 'Live Monitor'],
    ['reports', '/admin/reports', 'Reports'],
    ['logs', '/admin/logs', 'Activity Logs'],
    ['users', '/admin/users', 'Users']
  ],
  user: [
    ['events', '/user/events', 'Browse Events'],
    ['registrations', '/user/registrations', 'My Registrations'],
    ['profile', '/user/profile', 'Profile']
  ]
};
export const homeFor = role => role === 'admin' ? '/admin/events' : '/user/events';
const halt = () => new Promise(() => {});

export async function logout() { await supabase.auth.signOut(); location.replace('/login'); }

export async function getProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
  return data;
}

/** Route guard + shell renderer. Halts the page when access is denied. */
export async function boot(role, active) {
  if (configMissing) {
    document.body.innerHTML = '<div class="card" style="max-width:560px;margin:3rem auto"><h2>Configuration needed</h2><p>Edit <code>js/config.js</code> with your new Supabase project URL and anon key. See README.</p></div>';
    await halt();
  }
  const profile = await getProfile();
  if (!profile) { location.replace('/login'); await halt(); }
  if (profile.status === 'inactive') { await supabase.auth.signOut(); location.replace('/login?deactivated=1'); await halt(); }
  if (profile.role !== role) { location.replace(homeFor(profile.role)); await halt(); }

  const links = NAV[role].map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('');
  const shell = document.createElement('header');
  shell.className = 'topbar';
  shell.innerHTML = `
    <div class="nav-pill">
      <a class="brand" href="${homeFor(role)}">
        <img class="es-logo" src="/assets/logo.png" alt="EventSync logo" width="42" height="28">
        <span class="brand-text hide-xs">EventSync</span>
      </a>
      <nav class="nav-links" aria-label="Main navigation">${links}</nav>
      <div class="topbar-right">
        <span id="netChip" class="chip wait">Connecting</span>
        <span class="who">${esc(profile.full_name || profile.email)}${profile.school_id ? ` <small>${esc(profile.school_id)}</small>` : ''}${profile.course ? ` <small>${esc(profile.course)}</small>` : ''}${role === 'admin' ? ' <small>admin</small>' : ''}</span>
        <button class="btn ghost sm" id="logoutBtn">Logout</button>
        <button class="nav-burger" id="navBurger" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="navDrawer">${ICONS.menu(20)}</button>
      </div>
    </div>
    <nav class="nav-drawer" id="navDrawer" aria-label="Mobile navigation" hidden>
      ${links}
      <div class="drawer-meta">
        <span>${esc(profile.full_name || profile.email)} (${role === 'admin' ? 'Administrator' : 'Participant'})</span>
      </div>
    </nav>`;
  document.body.prepend(shell);
  document.getElementById('logoutBtn').onclick = logout;
  const burger = document.getElementById('navBurger'), drawer = document.getElementById('navDrawer');
  const setMenu = open => {
    drawer.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    burger.innerHTML = open ? ICONS.close(20) : ICONS.menu(20);
  };
  burger.onclick = () => setMenu(drawer.hidden);
  drawer.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) setMenu(false); });
  startNetworkMonitor();
  if (profile.must_change_password) await enforcePasswordChange();
  return { profile };
}

async function enforcePasswordChange() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <form id="fpwForm" novalidate>
      <h2>Change your password</h2>
      <p class="muted sm">An administrator reset your password. Set a new password before continuing.</p>
      <label for="fpw1">New password</label><input id="fpw1" type="password" autocomplete="new-password" required>
      <label for="fpw2">Confirm new password</label><input id="fpw2" type="password" autocomplete="new-password" required>
      <div id="fpwErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:1rem">
        <button type="button" class="btn ghost" id="fpwOut">Logout</button>
        <button class="btn" id="fpwSave">Update password</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  initPasswordEyes(dlg);
  dlg.addEventListener('cancel', e => e.preventDefault());
  dlg.querySelector('#fpwOut').onclick = logout;
  dlg.showModal();
  await new Promise(resolve => {
    dlg.querySelector('#fpwForm').onsubmit = async ev => {
      ev.preventDefault();
      const errBox = dlg.querySelector('#fpwErr'); errBox.innerHTML = '';
      const p1 = dlg.querySelector('#fpw1').value, p2 = dlg.querySelector('#fpw2').value;
      const issues = passwordIssues(p1);
      if (issues.length) { errBox.innerHTML = `<div class="err">Password needs: ${esc(issues.join(', ').toLowerCase())}</div>`; return; }
      if (p1 !== p2) { errBox.innerHTML = '<div class="err">Passwords do not match</div>'; return; }
      const btn = dlg.querySelector('#fpwSave'); btn.disabled = true;
      const { error } = await supabase.auth.updateUser({ password: p1 });
      if (error) { errBox.innerHTML = `<div class="err">${esc(errMsg(error))}</div>`; btn.disabled = false; return; }
      const { error: ce } = await supabase.rpc('complete_password_change');
      if (ce) { errBox.innerHTML = `<div class="err">${esc(errMsg(ce))}</div>`; btn.disabled = false; return; }
      toast('Password updated', 'success');
      dlg.close(); dlg.remove(); resolve();
    };
  });
}
