import { supabase } from '/js/core/supabase.js';
import { boot } from '/js/core/boot.js';
import { $, esc, fmt, fmtTime, toast, errMsg, watch } from '/js/core/ui.js';
import { openQrModal } from '/js/user/qr-modal.js';
import { ICONS } from '/js/shared/icons.js';
import { eventBannerHtml } from '/js/shared/event-images.js';
import { formatProgramShort } from '/js/shared/participant-options.js';
import { getAttendanceState, isLateCheckIn } from '/config/schedule.js';

const { profile } = await boot('user', 'registrations');
let rows = [], endTimer = null;

function scheduleEndRecheck() {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  const now = Date.now();
  const nextEnd = rows
    .filter(r => r.status === 'registered' && r.events?.ends_at)
    .map(r => new Date(r.events.ends_at).getTime())
    .filter(t => t > now)
    .sort((a, b) => a - b)[0];
  if (nextEnd) {
    endTimer = setTimeout(load, Math.min(nextEnd - now + 1000, 2_147_483_000));
  }
}

async function load() {
  const { data, error } = await supabase.rpc('my_registrations');
  if (error) return toast(errMsg(error), 'error');
  rows = Array.isArray(data) ? data : [];
  render();
  scheduleEndRecheck();
}

function render() {
  if (!rows.length) { $('#list').innerHTML = '<div class="card empty" style="grid-column:1/-1">No registrations yet. <a href="/user/events">Browse events</a>.</div>'; return; }
  $('#list').innerHTML = rows.map(r => {
    const rawAtt = Array.isArray(r.attendance) ? r.attendance[0] : r.attendance;
    const att = rawAtt && !rawAtt.voided && !rawAtt.is_test ? rawAtt : null;
    const started = r.events && new Date(r.events.starts_at) <= new Date();
    const ended = r.events && getAttendanceState(r.events).state === 'ENDED';
    const late = att && isLateCheckIn(r.events, att.checked_in_at);
    const label = r.status === 'cancelled'
      ? ['cancelled', 'Cancelled']
      : att
        ? [late ? 'dup' : 'ok', `${late ? 'Present (Late)' : 'Attended'} · ${fmt(att.checked_in_at)}`]
        : ended
          ? ['cancelled', 'Absent']
          : ['registered', 'Pending'];
    const canCancel = r.status === 'registered' && !att && !started;
    const timesLine = att
      ? `<p class="muted sm" style="margin:.25rem 0 0">Time in ${fmtTime(att.checked_in_at)}${att.check_out_time ? ` · Time out ${fmtTime(att.check_out_time)}` : ''}</p>`
      : '';

    const fb = r.feedback || {};
    let fbBlock = '';
    if (fb.available && fb.url) {
      fbBlock = `<div style="margin-top:.75rem">
        <a class="btn fb-btn" href="${esc(fb.url)}" target="_blank" rel="noopener noreferrer">Give feedback</a>
        <p class="muted sm" style="margin:.3rem 0 0">This opens a Google Form in a new tab.</p>
      </div>`;
    } else if (fb.reason === 'not_ended') {
      fbBlock = '<p class="muted sm" style="margin:.55rem 0 0">Feedback opens after the event.</p>';
    } else if (fb.reason === 'attended_only') {
      fbBlock = '<p class="muted sm" style="margin:.55rem 0 0">Feedback is for people who attended.</p>';
    }

    return `<div class="card hoverable fade-in">
      <div class="evt-reg-head">
        ${eventBannerHtml(r.events || { title: 'Event' }, { variant: 'reg' })}
        <div>
          <h2>${esc(r.events?.title)}</h2>
          <p class="muted sm">${ICONS.clock(14)} ${fmt(r.events?.starts_at)}<br>${ICONS.pin(14)} ${esc(r.events?.venue)}</p>
          <p><span class="badge ${label[0]}">${label[1]}</span></p>
          ${timesLine}
        </div>
      </div>
      <div class="row" style="margin-top:.6rem">
        ${r.status === 'registered' ? `<button class="btn" data-qr="${r.id}">${ICONS.qr(16)} View QR</button>` : ''}
        ${r.status === 'registered' && !att ? `<button class="btn ghost" data-cancel="${r.id}" ${canCancel ? '' : 'disabled title="Cancellation closes when the event starts"'}>Cancel</button>` : ''}
      </div>
      ${r.status === 'registered' && !att && started ? '<p class="muted sm" style="margin:.4rem 0 0">Event started - cancellation is closed.</p>' : ''}
      ${fbBlock}</div>`;
  }).join('');
}

$('#list').onclick = async e => {
  const q = e.target.closest('button[data-qr]');
  if (q) {
    const r = rows.find(x => x.id === q.dataset.qr);
    return openQrModal({
      token: r.qr_token, title: r.events?.title, startsAt: r.events?.starts_at, venue: r.events?.venue,
      name: profile.full_name || profile.email, schoolId: profile.school_id,
      course: formatProgramShort({ ...profile, year_level: null }),
      imagePath: r.events?.image_path, imageUpdatedAt: r.events?.image_updated_at
    });
  }
  const b = e.target.closest('button[data-cancel]'); if (!b || b.disabled || !confirm('Cancel this registration? Your seat will be released.')) return;
  b.disabled = true;
  const { error } = await supabase.rpc('cancel_registration', { p_registration_id: b.dataset.cancel });
  if (error) toast(errMsg(error), 'error'); else toast('Registration cancelled', 'success');
  load();
};

await load();
watch(['registrations', 'attendance', 'events'], load);
window.addEventListener('focus', load);
