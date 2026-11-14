import { CONFIG } from '/js/config.js';
import { supabase, configMissing } from '/js/core/supabase.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = d => d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const fmtTime = d => d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const toLocalInput = d => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
export const $ = (s, r = document) => r.querySelector(s);

export function toast(msg, type = 'info', ms = 3500) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function errMsg(e) {
  const m = e?.message || String(e);
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Network problem - check your connection and try again.';
  return m;
}

/* ---------- network detection & recovery ---------- */
const reconnectFns = new Set();
let online = navigator.onLine, rtLive = false, started = false;
export const onReconnect = fn => reconnectFns.add(fn);

function paint() {
  const chip = $('#netChip'), bar = $('#netBanner');
  const live = online && rtLive;
  if (chip) { chip.className = 'chip ' + (!online ? 'off' : live ? 'live' : 'wait'); chip.textContent = !online ? 'Offline' : live ? 'Live' : 'Connecting'; }
  if (bar) bar.hidden = online;
}
function setOnline(v) {
  if (v === online) return;
  online = v; paint();
  if (v) { toast('Back online - refreshing data', 'success'); reconnectFns.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
  else toast('Connection lost. Waiting to reconnect...', 'error', 5000);
}
async function ping() {
  if (configMissing) return;
  try {
    const r = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: CONFIG.SUPABASE_ANON_KEY }, cache: 'no-store' });
    setOnline(r.ok);
  } catch { setOnline(false); }
}
export function startNetworkMonitor() {
  if (started) return; started = true;
  const bar = document.createElement('div');
  bar.id = 'netBanner'; bar.hidden = true; bar.textContent = 'You are offline. Changes will sync automatically when the connection returns.';
  document.body.prepend(bar);
  window.addEventListener('online', ping);
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { ping(); } });
  setInterval(ping, 8000); paint();
}

/* ---------- realtime watcher: refetch (debounced) on any change ---------- */
export function watch(tables, cb) {
  let t;
  const run = () => { clearTimeout(t); t = setTimeout(cb, 250); };
  const ch = supabase.channel('w-' + Math.random().toString(36).slice(2));
  tables.forEach(table => ch.on('postgres_changes', { event: '*', schema: 'public', table }, run));
  ch.subscribe(status => { rtLive = status === 'SUBSCRIBED'; paint(); });
  onReconnect(cb);
  return ch;
}

export function csvDownload(filename, rows) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
