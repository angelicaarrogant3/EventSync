import { supabase, configMissing } from '/js/core/supabase.js';
import { startNetworkMonitor, esc } from '/js/core/ui.js';

const NAV = {
  admin: [
    ['events', '/admin/events', 'Events'],
    ['registrations', '/admin/registrations', 'Registrations'],
    ['scan', '/admin/scan', 'Scan QR'],
    ['monitor', '/admin/monitor', 'Live Monitor'],
    ['reports', '/admin/reports', 'Reports'],
    ['logs', '/admin/logs', 'Activity Logs']
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
  if (profile.role !== role) { location.replace(homeFor(profile.role)); await halt(); }

  const links = NAV[role].map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('');
  const shell = document.createElement('header');
  shell.className = 'topbar';
  shell.innerHTML = `
    <div class="topbar-row">
      <a class="brand" href="${homeFor(role)}"><span class="logo">ES</span> EventSync</a>
      <div class="topbar-right">
        <span id="netChip" class="chip wait">Connecting</span>
        <span class="who">${esc(profile.full_name || profile.email)}${profile.school_id ? ` <small>${esc(profile.school_id)}</small>` : ''}${profile.course ? ` <small>${esc(profile.course)}</small>` : ''}${role === 'admin' ? ' <small>admin</small>' : ''}</span>
        <button class="btn ghost sm" id="logoutBtn">Logout</button>
      </div>
    </div>
    <nav class="nav">${links}</nav>`;
  document.body.prepend(shell);
  document.getElementById('logoutBtn').onclick = logout;
  startNetworkMonitor();
  return { profile };
}
