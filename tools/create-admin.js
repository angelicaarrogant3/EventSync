#!/usr/bin/env node
// Create an ADMIN account from the terminal (the only supported way).
//   $env:SUPABASE_URL="https://<ref>.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY="<service_role key>"   # Dashboard -> Settings -> API Keys. NEVER commit/share it.
//   npm run create-admin
const readline = require('readline');
const fs = require('fs');

const URL_ = (process.env.SUPABASE_URL || readConfigUrl() || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function readConfigUrl() {
  try { return (fs.readFileSync(__dirname + '/../js/config.js', 'utf8').match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1]; } catch { return ''; }
}
function ask(q, hidden = false) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(q); }; }
    rl.question(q, a => { rl.close(); if (hidden) console.log(); res(a.trim()); });
  });
}
async function api(path, opts = {}) {
  const r = await fetch(URL_ + path, { ...opts, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) } });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error((body && (body.msg || body.message || body.error_description)) || text || r.status);
  return body;
}

(async () => {
  if (!URL_ || !KEY) { console.error('Set SUPABASE_URL (or js/config.js) and SUPABASE_SERVICE_ROLE_KEY first.'); process.exit(1); }
  const full_name = await ask('Admin full name: ');
  const email = (await ask('Admin email: ')).toLowerCase();
  const password = await ask('Password (min 8 chars): ', true);
  if (!full_name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) { console.error('Invalid input.'); process.exit(1); }

  let user;
  try {
    user = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name }, app_metadata: { created_by: 'trusted_tool' } }) });
  } catch (e) {
    if (!/already|registered|exists/i.test(e.message)) throw e;
    const list = await api('/auth/v1/admin/users?per_page=1000');
    user = (list.users || []).find(u => u.email === email);
    if (!user) throw e;
    console.log('Account already exists - promoting it to admin (password unchanged).');
  }
  const rows = await api(`/rest/v1/profiles?id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin', full_name }) });
  if (!rows.length) throw new Error('Profile row not found (is the schema applied?).');
  console.log(`Admin ready: ${email}. Log in at /login.`);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
