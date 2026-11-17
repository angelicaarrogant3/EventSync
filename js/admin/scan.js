import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmtTime, toast, errMsg, watch } from '/js/core/ui.js';
import { ICONS } from '/js/shared/icons.js';
import { getAttendanceState, formatManila } from '/config/schedule.js';
import { createScanModal, SCAN_MODAL_CONFIG } from '/js/admin/scan-modal.js';

await boot('admin', 'scan');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EV_CACHE_KEY = 'eventsync_cached_events';
const QUEUE_KEY = 'eventsync_scan_queue';

let scanner = null, busy = false, last = { t: '', at: 0 };
let events = [];
let audioCtx = null;

function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}

function playTone(tone) {
  try {
    const ctx = unlockAudio();
    if (!ctx) return;
    const beep = (freq, start, dur, type = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.14, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    };
    if (tone === 'green') { beep(880, 0, 0.09); beep(1174, 0.1, 0.13); }
    else if (tone === 'amber' || tone === 'blue') { beep(440, 0, 0.14, 'triangle'); beep(330, 0.16, 0.18, 'triangle'); }
    else { beep(220, 0, 0.22, 'sawtooth'); beep(175, 0.24, 0.26, 'sawtooth'); }
  } catch {}
}

function triggerVibrate(tone) {
  if (!navigator.vibrate) return;
  if (tone === 'green') navigator.vibrate(120);
  else if (tone === 'amber' || tone === 'blue') navigator.vibrate([80, 50, 80]);
  else navigator.vibrate([120, 60, 120, 60, 120]);
}

const scanModal = createScanModal({
  onTone: playTone,
  onVibrate: triggerVibrate
});

function loadCachedEvents() {
  try { return JSON.parse(localStorage.getItem(EV_CACHE_KEY) || '[]'); } catch { return []; }
}
function saveCachedEvents(list) {
  try { localStorage.setItem(EV_CACHE_KEY, JSON.stringify(list)); } catch {}
}
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
  renderQueue();
}

function eventStateLabel(e) {
  const ws = getAttendanceState(e);
  if (e.allow_early_test_attendance && ws.state !== 'OPEN') return `TEST MODE (Opens ${formatManila(ws.opensAt)})`;
  if (ws.state === 'OPEN') return 'Open now';
  if (ws.state === 'NOT_STARTED') return `Opens ${formatManila(ws.opensAt)}`;
  if (ws.state === 'CANCELLED') return 'Cancelled';
  return 'Ended';
}

function updateBanner() {
  const ev = events.find(x => x.id === $('#ev').value);
  const chip = $('#testChip'), ban = $('#scanBanner');
  if (!ev) { chip.hidden = true; ban.hidden = true; return; }
  const ws = getAttendanceState(ev);
  chip.hidden = !ev.allow_early_test_attendance;
  if (ev.allow_early_test_attendance) {
    ban.className = 'scan-banner test';
    ban.innerHTML = `${ICONS.alert(16)} <b>TEST MODE ON:</b> Attendance outside schedule is allowed and flagged as <code>is_test</code>.`;
    ban.hidden = false;
  } else if (ws.state === 'NOT_STARTED') {
    ban.className = 'scan-banner warn';
    ban.innerHTML = `${ICONS.clock(16)} <b>Not open yet:</b> Attendance opens ${esc(formatManila(ws.opensAt))}. Scans will be rejected.`;
    ban.hidden = false;
  } else if (ws.state === 'ENDED') {
    ban.className = 'scan-banner warn';
    ban.innerHTML = `${ICONS.xCircle(16)} <b>Attendance closed:</b> Window closed ${esc(formatManila(ws.closesAt))}.`;
    ban.hidden = false;
  } else if (ws.state === 'CANCELLED') {
    ban.className = 'scan-banner warn';
    ban.innerHTML = `${ICONS.xCircle(16)} <b>Event cancelled.</b>`;
    ban.hidden = false;
  } else {
    ban.hidden = true;
  }
}

async function loadEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,title,status,starts_at,ends_at,early_grace_minutes,late_grace_minutes,allow_early_test_attendance')
    .order('starts_at', { ascending: false });
  if (!error && data) {
    events = data;
    saveCachedEvents(data);
  } else if (!events.length) {
    events = loadCachedEvents();
  }
  const cur = $('#ev').value;
  $('#ev').innerHTML = '<option value="">Auto-detect from QR</option>' + events.map(e =>
    `<option value="${e.id}">${esc(e.title)} — ${esc(eventStateLabel(e))}</option>`
  ).join('');
  if (cur && events.some(e => e.id === cur)) {
    $('#ev').value = cur;
  } else {
    const openEv = events.find(e => getAttendanceState(e).state === 'OPEN');
    if (openEv) $('#ev').value = openEv.id;
  }
  updateBanner();
}

function renderQueue() {
  const q = readQueue();
  $('#queueCard').hidden = q.length === 0;
  $('#queueList').innerHTML = q.map((item, idx) => `
    <li>
      <span>
        <b>${esc(item.qr_token.slice(0, 8))}…</b>
        <br><small class="muted">${esc(fmtTime(item.scanned_at))}${item.reason ? ` · <span style="color:#fca5a5">${esc(item.reason)}</span>` : ' · Waiting to sync'}</small>
      </span>
      <div class="row">
        <span class="badge ${item.status === 'rejected' ? 'cancelled' : 'dup'}">${item.status === 'rejected' ? 'Rejected' : 'Queued'}</span>
        <button class="btn sm ghost" data-drop="${idx}" title="Dismiss">Dismiss</button>
      </div>
    </li>
  `).join('');
}

async function syncQueue() {
  const q = readQueue();
  const pending = q.filter(x => x.status !== 'rejected');
  if (!pending.length) return;
  $('#syncBtn').disabled = true;
  try {
    const { data, error } = await supabase.rpc('sync_offline_attendance', {
      p_items: pending.map(x => ({ qr_token: x.qr_token, event_id: x.event_id || null, scanned_at: x.scanned_at }))
    });
    if (error) throw error;
    const results = Array.isArray(data) ? data : [];
    const nextQueue = q.filter(x => x.status === 'rejected');
    results.forEach((res, i) => {
      const orig = pending[i];
      if (res.status === 'ok' || res.status === 'duplicate') {
        appendRecent(res, true);
      } else {
        nextQueue.push({ ...orig, status: 'rejected', reason: res.message || res.code || 'Rejected' });
      }
    });
    writeQueue(nextQueue);
    const rejCount = results.filter(r => r.status !== 'ok' && r.status !== 'duplicate').length;
    if (rejCount) toast(`${rejCount} queued scan(s) rejected — check Offline Queue.`, 'error');
    else toast('Offline scans synced.', 'success');
  } catch (e) {
    toast(errMsg(e), 'error');
  } finally {
    $('#syncBtn').disabled = false;
  }
}

function appendRecent(r, fromSync = false) {
  const mapped = scanModal.open && !fromSync ? scanModal.open(r) : null;
  const badgeClass = r.status === 'ok' ? 'ok' : (r.status === 'duplicate' || r.status === 'queued' || r.status === 'not_started') ? 'dup' : 'cancelled';
  const label = mapped?.title || r.status;
  const li = document.createElement('li'); li.className = 'new';
  li.innerHTML = `<span><b>${esc(r.participant || 'Unknown')}</b>${r.is_test ? ' <span class="badge dup">TEST</span>' : ''}${fromSync ? ' <small class="muted">(synced)</small>' : ''}<br><small class="muted">${esc(r.event || r.message || '')}</small></span><span class="badge ${badgeClass}">${esc(label)}</span><small class="muted">${fmtTime(new Date())}</small>`;
  $('#recent').prepend(li);
}

async function verify(raw, mode = 'scan') {
  // Pause camera decoding while modal is open (manual verify still replaces open modal)
  if (mode === 'scan' && scanModal.isOpen()) return;

  const m = String(raw).match(UUID);
  if (!m) {
    const res = { status: 'invalid', code: 'INVALID_QR', message: 'This code is not an EventSync pass.' };
    appendRecent(res);
    return;
  }
  const token = m[0].toLowerCase();
  if (busy || (mode === 'scan' && token === last.t && Date.now() - last.at < SCAN_MODAL_CONFIG.debounceMs)) return;
  busy = true; last = { t: token, at: Date.now() };
  const selectedEventId = $('#ev').value || null;
  const selectedEvent = events.find(x => x.id === selectedEventId) || null;

  try {
    if (!navigator.onLine) {
      if (selectedEvent && !selectedEvent.allow_early_test_attendance) {
        const ws = getAttendanceState(selectedEvent);
        if (ws.state === 'NOT_STARTED') {
          return appendRecent({ status: 'not_started', code: 'EVENT_NOT_STARTED', event: selectedEvent.title, opensAt: ws.opensAt, message: `Attendance opens on ${formatManila(ws.opensAt)}.` });
        }
        if (ws.state === 'ENDED') {
          return appendRecent({ status: 'ended', code: 'EVENT_ENDED', event: selectedEvent.title, closesAt: ws.closesAt, endsAt: selectedEvent.ends_at, message: `This event ended on ${formatManila(selectedEvent.ends_at)}.` });
        }
      }
      const q = readQueue();
      q.push({ qr_token: token, event_id: selectedEventId, scanned_at: new Date().toISOString(), status: 'queued', reason: '' });
      writeQueue(q);
      return appendRecent({ status: 'queued', code: 'SAVED_OFFLINE', event: selectedEvent?.title, message: 'Scan saved. It will sync when the connection returns.' });
    }

    const { data, error } = await supabase.rpc('verify_attendance', {
      p_qr_token: token,
      p_event_id: selectedEventId,
      p_mode: mode
    });
    if (error) throw error;
    appendRecent(data);
  } catch (e) {
    const msg = errMsg(e);
    if (/network problem|failed to fetch/i.test(msg)) {
      if (selectedEvent && !selectedEvent.allow_early_test_attendance) {
        const ws = getAttendanceState(selectedEvent);
        if (ws.state === 'NOT_STARTED') {
          return appendRecent({ status: 'not_started', code: 'EVENT_NOT_STARTED', event: selectedEvent.title, opensAt: ws.opensAt });
        }
        if (ws.state === 'ENDED') {
          return appendRecent({ status: 'ended', code: 'EVENT_ENDED', event: selectedEvent.title, closesAt: ws.closesAt, endsAt: selectedEvent.ends_at });
        }
      }
      const q = readQueue();
      q.push({ qr_token: token, event_id: selectedEventId, scanned_at: new Date().toISOString(), status: 'queued', reason: '' });
      writeQueue(q);
      return appendRecent({ status: 'queued', code: 'SAVED_OFFLINE', event: selectedEvent?.title });
    }
    appendRecent({ status: 'error', message: msg });
  } finally {
    busy = false;
  }
}

$('#ev').onchange = updateBanner;
$('#syncBtn').onclick = syncQueue;
$('#queueList').onclick = ev => {
  const b = ev.target.closest('button[data-drop]');
  if (!b) return;
  const q = readQueue();
  q.splice(Number(b.dataset.drop), 1);
  writeQueue(q);
};
window.addEventListener('online', syncQueue);
document.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });

$('#start').onclick = async () => {
  unlockAudio();
  $('#camErr').innerHTML = '';
  if (!window.isSecureContext) $('#camErr').innerHTML = '<div class="err">Camera requires HTTPS or localhost. Use the public HTTPS URL on phones (see README).</div>';
  try {
    scanner = scanner || new Html5Qrcode('reader');
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, txt => verify(txt, 'scan'), () => {});
    $('#start').disabled = true; $('#stop').disabled = false;
  } catch (e) { $('#camErr').innerHTML = `<div class="err">Cannot start camera: ${esc(errMsg(e))}</div>`; }
};
$('#stop').onclick = async () => { await scanner?.stop(); $('#start').disabled = false; $('#stop').disabled = true; };
$('#verify').onclick = () => {
  unlockAudio();
  const v = $('#manual').value.trim();
  if (v) { last = { t: '', at: 0 }; verify(v, 'manual'); $('#manual').value = ''; }
};
$('#manual').addEventListener('keydown', e => { if (e.key === 'Enter') $('#verify').click(); });

await loadEvents();
renderQueue();
if (navigator.onLine) syncQueue();
watch(['events'], loadEvents);
