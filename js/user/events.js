import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, toast, errMsg, watch } from '/js/core/ui.js';
import { openQrModal } from '/js/user/qr-modal.js';
import { ICONS } from '/js/shared/icons.js';
import { eventBannerHtml } from '/js/shared/event-images.js';
import { formatProgramShort } from '/js/shared/participant-options.js';

const { profile } = await boot('user', 'events');
let events = [];                 // published events (events table => live registered_count)
const mine = new Map();          // event_id -> { id, status, qr_token, attended }
const pending = new Set();

const norm = a => (Array.isArray(a) ? a[0] : a) || null;

/** Decide what the card's action area shows. */
function stateFor(e) {
  const reg = mine.get(e.id);
  const now = Date.now();
  if (reg?.status === 'registered') return { kind: 'registered', attended: reg.attended };
  if (e.capacity && e.registered_count >= e.capacity) return { kind: 'disabled', label: 'Full' };
  if (e.registration_deadline && new Date(e.registration_deadline) < now) return { kind: 'disabled', label: 'Registration closed', reason: 'The registration deadline has passed' };
  if (new Date(e.ends_at) < now) return { kind: 'disabled', label: 'Event ended', reason: 'This event has already ended' };
  return { kind: 'open', label: reg?.status === 'cancelled' ? 'Register again' : 'Register' };
}

function render() {
  if (!events.length) { $('#list').innerHTML = '<div class="card empty" style="grid-column:1/-1">No upcoming events right now.</div>'; return; }
  $('#list').innerHTML = events.map(e => {
    const s = stateFor(e);
    const left = e.capacity ? Math.max(e.capacity - e.registered_count, 0) : null;
    const pct = e.capacity ? Math.min(100, Math.round((e.registered_count / e.capacity) * 100)) : 0;
    const badge = s.kind === 'registered' ? ['registered', 'Registered'] : s.label === 'Full' ? ['closed', 'Full'] : s.kind === 'disabled' ? ['closed', 'Closed'] : ['published', 'Open'];
    let action;
    if (s.kind === 'registered') action = `<div class="row"><button class="btn" disabled>Registered</button><button class="btn ghost" data-qr="${e.id}">${ICONS.qr(16)} View QR</button><button class="btn ghost sm" data-detail="${e.id}">Details</button>${s.attended ? '<span class="badge ok">Attended</span>' : ''}</div>`;
    else if (s.kind === 'disabled') action = `<div class="row"><button class="btn" disabled title="${esc(s.reason || s.label)}">${s.label}</button><button class="btn ghost sm" data-detail="${e.id}">Details</button></div>${s.reason ? `<p class="muted sm" style="margin:.4rem 0 0">${esc(s.reason)}</p>` : ''}`;
    else action = `<div class="row"><button class="btn" data-reg="${e.id}" ${pending.has(e.id) ? 'disabled' : ''}>${pending.has(e.id) ? 'Registering...' : `${s.label} ${ICONS.arrowRight(16)}`}</button><button class="btn ghost sm" data-detail="${e.id}">Details</button></div>`;
    return `<div class="card hoverable fade-in" data-card="${e.id}">
      <a href="#event-${e.id}" data-detail="${e.id}" style="display:block;text-decoration:none;color:inherit">${eventBannerHtml(e, { variant: 'card' })}</a>
      <div class="stat-top" style="margin-bottom:.5rem"><h2 style="margin:0">${esc(e.title)}</h2><span class="badge ${badge[0]}">${badge[1]}</span></div>
      <p class="muted sm">${ICONS.clock(14)} ${fmt(e.starts_at)} – ${fmt(e.ends_at)}<br>${ICONS.pin(14)} ${esc(e.venue)}${e.registration_deadline ? `<br><span class="faint">Register by ${fmt(e.registration_deadline)}</span>` : ''}</p>
      ${e.description ? `<p class="sm">${esc(e.description)}</p>` : ''}
      <div style="margin:.85rem 0">
        <p class="sm" style="margin:0 0 .35rem"><b>${e.registered_count}</b> registered${e.capacity ? ` / ${e.capacity} seats · <b>${left}</b> left` : ''}</p>
        ${e.capacity ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      ${action}</div>`;
  }).join('');
}

async function load() {
  const [ev, rg] = await Promise.all([
    supabase.from('events').select('*').eq('status', 'published').gte('ends_at', new Date().toISOString()).order('starts_at'),
    supabase.from('registrations').select('id,event_id,status,qr_token,attendance(checked_in_at)')
  ]);
  if (ev.error) return toast(errMsg(ev.error), 'error');
  events = ev.data;
  if (!rg.error) {
    mine.clear();
    rg.data.forEach(r => mine.set(r.event_id, { id: r.id, status: r.status, qr_token: r.qr_token, attended: !!norm(r.attendance) }));
  }
  render();
}

function showQr(eventId) {
  const e = events.find(x => x.id === eventId), r = mine.get(eventId);
  if (!e || !r) return;
  openQrModal({
    token: r.qr_token, title: e.title, startsAt: e.starts_at, venue: e.venue,
    name: profile.full_name || profile.email, schoolId: profile.school_id,
    course: formatProgramShort({ ...profile, year_level: null }),
    imagePath: e.image_path, imageUpdatedAt: e.image_updated_at
  });
}

function openDetails(eventId) {
  const e = events.find(x => x.id === eventId);
  if (!e) return;
  let dlg = document.getElementById('evDetailDlg');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'evDetailDlg';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
  }
  const s = stateFor(e);
  const left = e.capacity ? Math.max(e.capacity - e.registered_count, 0) : null;
  dlg.innerHTML = `
    ${eventBannerHtml(e, { variant: 'detail' })}
    <div class="stat-top" style="margin-bottom:.5rem"><h2 style="margin:0">${esc(e.title)}</h2></div>
    <p class="muted sm">${ICONS.clock(14)} ${fmt(e.starts_at)} – ${fmt(e.ends_at)}<br>${ICONS.pin(14)} ${esc(e.venue)}${e.registration_deadline ? `<br><span class="faint">Register by ${fmt(e.registration_deadline)}</span>` : ''}</p>
    ${e.description ? `<p class="sm">${esc(e.description)}</p>` : ''}
    <p class="sm"><b>${e.registered_count}</b> registered${e.capacity ? ` / ${e.capacity} seats · <b>${left}</b> left` : ''}</p>
    <div class="row" style="justify-content:flex-end;margin-top:1rem">
      ${s.kind === 'registered' ? `<button class="btn" id="dtQr">${ICONS.qr(16)} View QR</button>` : s.kind === 'open' ? `<button class="btn" id="dtReg">${s.label} ${ICONS.arrowRight(16)}</button>` : `<button class="btn" disabled>${s.label}</button>`}
      <button class="btn ghost" id="dtClose">Close</button>
    </div>`;
  dlg.querySelector('#dtClose').onclick = () => dlg.close();
  const dtQr = dlg.querySelector('#dtQr');
  if (dtQr) dtQr.onclick = () => { dlg.close(); showQr(e.id); };
  const dtReg = dlg.querySelector('#dtReg');
  if (dtReg) dtReg.onclick = () => { dlg.close(); $(`button[data-reg="${e.id}"]`)?.click(); };
  if (!dlg.open) dlg.showModal();
}

$('#list').onclick = async ev => {
  const dt = ev.target.closest('[data-detail]');
  if (dt) { ev.preventDefault(); return openDetails(dt.dataset.detail); }
  const q = ev.target.closest('button[data-qr]');
  if (q) return showQr(q.dataset.qr);
  const b = ev.target.closest('button[data-reg]'); if (!b) return;
  const id = b.dataset.reg;
  if (pending.has(id)) return;
  pending.add(id); render();
  try {
    const { data, error } = await supabase.rpc('register_for_event', { p_event_id: id });
    if (error) throw error;
    if (!data?.id || !data?.qr_token) throw new Error('Registration was not confirmed by the server.');   // never claim success without proof
    const e = events.find(x => x.id === id);
    if (data.already_registered) toast('You are already registered for this event.', 'info');
    else { toast('Registered! Your QR code is ready.', 'success'); if (e) e.registered_count += 1; }   // immediate UI update; realtime/refetch reconciles
    mine.set(id, { id: data.id, status: 'registered', qr_token: data.qr_token, attended: false });
    pending.delete(id); render(); showQr(id);
    load();
  } catch (err) {
    pending.delete(id); toast(errMsg(err), 'error'); load();
  }
};

await load();
watch(['events', 'registrations', 'attendance'], load);   // seat counts + button states update live on every device
setInterval(render, 30000);                               // flips "closed"/"ended" states as time passes
