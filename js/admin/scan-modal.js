import { ICONS } from '../shared/icons.js';
import { formatManila } from '../../config/schedule.js';

export const SCAN_MODAL_CONFIG = {
  debounceMs: 2500,
  durations: {
    CHECKED_IN: 2000,
    CHECKED_OUT: 2000,
    ALREADY_CHECKED_IN: 3000,
    ALREADY_CHECKED_OUT: 3000,
    NOT_OPEN_YET: 3000,
    ATTENDANCE_CLOSED: 3000,
    SAVED_OFFLINE: 3000,
    NO_TIME_IN_RECORDED: 0,
    WRONG_EVENT: 0,             // 0 = stay until staff taps "Scan next"
    SELF_SCAN_NOT_ALLOWED: 0,
    REGISTRATION_CANCELLED: 0,
    EVENT_CANCELLED: 0,
    INVALID_QR: 0
  }
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Map any server or offline scan result into one of the 9 canonical modal outcomes. */
export function mapScanOutcome(r = {}) {
  const code = String(r.code || '').toUpperCase();
  const status = String(r.status || '').toLowerCase();
  const scanTime = formatManila(r.check_out_time || r.checked_in_at || r.scanned_at || new Date());

  if (status === 'self_scan' || code === 'SELF_SCAN_NOT_ALLOWED') {
    return {
      key: 'SELF_SCAN_NOT_ALLOWED',
      tone: 'red',
      icon: ICONS.xCircle(38),
      title: 'SELF-SCAN BLOCKED',
      message: r.message || 'You cannot scan your own QR pass. Ask another organizer or admin to verify you.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'checked_out' || code === 'CHECKED_OUT') {
    return {
      key: 'CHECKED_OUT',
      tone: 'blue',
      icon: ICONS.check(38),
      title: 'CHECKED OUT',
      message: r.is_test ? 'Test time-out recorded.' : 'Time out recorded.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'already_checked_out' || code === 'ALREADY_CHECKED_OUT') {
    const prevOut = formatManila(r.check_out_time);
    const station = r.verified_by_name ? ` by ${r.verified_by_name}` : '';
    return {
      key: 'ALREADY_CHECKED_OUT',
      tone: 'amber',
      icon: ICONS.alert(38),
      title: 'ALREADY CHECKED OUT',
      message: `Earlier time-out: ${prevOut}${station}.`,
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'no_time_in' || code === 'NO_TIME_IN_RECORDED') {
    return {
      key: 'NO_TIME_IN_RECORDED',
      tone: 'red',
      icon: ICONS.xCircle(38),
      title: 'NO TIME-IN RECORDED',
      message: 'Participant must time in before timing out.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }

  if (status === 'ok' || code === 'OK') {
    return {
      key: 'CHECKED_IN',
      tone: 'green',
      icon: ICONS.check(38),
      title: r.is_test ? 'TEST CHECKED IN' : 'CHECKED IN',
      message: r.is_test ? 'Test attendance recorded (outside schedule).' : 'Attendance recorded.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'duplicate' || code === 'ALREADY_CHECKED_IN') {
    const prevTime = formatManila(r.checked_in_at);
    const station = r.verified_by_name ? ` by ${r.verified_by_name}` : '';
    return {
      key: 'ALREADY_CHECKED_IN',
      tone: 'amber',
      icon: ICONS.alert(38),
      title: 'ALREADY CHECKED IN',
      message: `Earlier check-in: ${prevTime}${station}.`,
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'not_started' || code === 'EVENT_NOT_STARTED') {
    const opens = r.opensAt ? `Attendance opens ${formatManila(r.opensAt)}.` : (r.message || 'Attendance has not opened yet.');
    return {
      key: 'NOT_OPEN_YET',
      tone: 'amber',
      icon: ICONS.clock(38),
      title: 'NOT OPEN YET',
      message: `${opens} No attendance was recorded.`,
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'ended' || code === 'EVENT_ENDED') {
    const endedOn = r.endsAt || r.closesAt ? `This event ended on ${formatManila(r.endsAt || r.closesAt)}.` : (r.message || 'Attendance for this event is closed.');
    return {
      key: 'ATTENDANCE_CLOSED',
      tone: 'amber',
      icon: ICONS.xCircle(38),
      title: 'ATTENDANCE CLOSED',
      message: endedOn,
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (status === 'queued' || code === 'SAVED_OFFLINE') {
    return {
      key: 'SAVED_OFFLINE',
      tone: 'blue',
      icon: ICONS.clock(38),
      title: 'SAVED OFFLINE',
      message: 'Scan saved. It will sync when the connection returns.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course || '',
      event: r.event || ''
    };
  }
  if (status === 'wrong_event' || code === 'WRONG_EVENT') {
    return {
      key: 'WRONG_EVENT',
      tone: 'red',
      icon: ICONS.alert(38),
      title: 'WRONG EVENT',
      message: r.event ? `This pass belongs to ${r.event}.` : (r.message || 'Pass is for a different event.'),
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course ? (r.year_level ? `${r.course} · Year ${r.year_level}` : r.course) : '',
      event: r.event || ''
    };
  }
  if (code === 'EVENT_CANCELLED') {
    return {
      key: 'EVENT_CANCELLED',
      tone: 'red',
      icon: ICONS.xCircle(38),
      title: 'EVENT CANCELLED',
      message: r.message || 'This event has been cancelled.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course || '',
      event: r.event || ''
    };
  }
  if (status === 'cancelled' || code === 'REGISTRATION_CANCELLED') {
    return {
      key: 'REGISTRATION_CANCELLED',
      tone: 'red',
      icon: ICONS.xCircle(38),
      title: 'REGISTRATION CANCELLED',
      message: r.message || 'This registration was cancelled.',
      timeLabel: scanTime,
      participant: r.participant || '',
      schoolId: r.school_id || '',
      program: r.course || '',
      event: r.event || ''
    };
  }
  return {
    key: 'INVALID_QR',
    tone: 'red',
    icon: ICONS.xCircle(38),
    title: 'INVALID QR',
    message: r.message && code !== 'INVALID_QR' ? r.message : 'This code is not an EventSync pass.',
    timeLabel: scanTime,
    participant: r.participant || '',
    schoolId: r.school_id || '',
    program: '',
    event: r.event || ''
  };
}

export function createScanModal({
  documentRef = typeof document !== 'undefined' ? document : null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = () => Date.now(),
  config = SCAN_MODAL_CONFIG,
  onOpen,
  onClose,
  onTone,
  onVibrate
} = {}) {
  let root = null;
  let openState = false;
  let prevOverflow = '';
  let prevFocus = null;
  let timerId = null;
  let remainingMs = 0;
  let startedAt = 0;
  let currentDuration = 0;
  let paused = false;

  function ensureRoot() {
    if (root || !documentRef) return root;
    root = documentRef.createElement('div');
    root.id = 'scanModal';
    root.className = 'sm-backdrop';
    root.hidden = true;
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'smTitle');
    root.setAttribute('aria-describedby', 'smDesc');
    root.innerHTML = `
      <div class="sm-live" id="smLive" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>
      <div class="sm-card" id="smCard">
        <div class="sm-body">
          <div class="sm-ico" id="smIco" aria-hidden="true"></div>
          <h2 class="sm-title" id="smTitle"></h2>
          <div class="sm-who" id="smWho"></div>
          <div class="sm-meta" id="smMeta"></div>
          <div class="sm-ev" id="smEv"></div>
          <p class="sm-msg" id="smDesc"></p>
          <p class="sm-time" id="smTime"></p>
        </div>
        <div class="sm-foot">
          <div class="sm-prog" id="smProg" hidden><i id="smBar"></i></div>
          <button type="button" class="btn sm-next" id="smNext">Scan next</button>
        </div>
      </div>`;
    documentRef.body.appendChild(root);

    root.addEventListener('click', ev => {
      if (ev.target === root) close();
    });
    const nextBtn = root.querySelector('#smNext');
    nextBtn.addEventListener('click', () => close());

    const card = root.querySelector('#smCard');
    const holdPause = () => pause();
    const holdResume = () => resume();
    card.addEventListener('pointerdown', holdPause);
    card.addEventListener('pointerup', holdResume);
    card.addEventListener('pointerleave', holdResume);
    card.addEventListener('touchstart', holdPause, { passive: true });
    card.addEventListener('touchend', holdResume);

    root.addEventListener('keydown', ev => {
      if (!openState) return;
      if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        nextBtn.focus();
      }
    });
    return root;
  }

  function clearTimer() {
    if (timerId !== null) {
      clearTimeoutFn(timerId);
      timerId = null;
    }
  }

  function startCountdown(ms) {
    clearTimer();
    currentDuration = ms;
    remainingMs = ms;
    paused = false;
    const prog = root?.querySelector('#smProg');
    const bar = root?.querySelector('#smBar');
    if (!ms || ms <= 0) {
      if (prog) prog.hidden = true;
      return;
    }
    if (prog && bar) {
      prog.hidden = false;
      bar.style.transition = 'none';
      bar.style.width = '100%';
      void bar.offsetWidth;
      bar.style.transition = `width ${ms}ms linear`;
      bar.style.width = '0%';
    }
    startedAt = nowFn();
    timerId = setTimeoutFn(() => close(), ms);
  }

  function pause() {
    if (!openState || paused || currentDuration <= 0) return;
    paused = true;
    const elapsed = Math.max(0, nowFn() - startedAt);
    remainingMs = Math.max(0, remainingMs - elapsed);
    clearTimer();
    const bar = root?.querySelector('#smBar');
    if (bar && currentDuration > 0) {
      const pct = Math.max(0, Math.min(100, (remainingMs / currentDuration) * 100));
      bar.style.transition = 'none';
      bar.style.width = `${pct}%`;
    }
  }

  function resume() {
    if (!openState || !paused || remainingMs <= 0) return;
    paused = false;
    startedAt = nowFn();
    const bar = root?.querySelector('#smBar');
    if (bar) {
      void bar.offsetWidth;
      bar.style.transition = `width ${remainingMs}ms linear`;
      bar.style.width = '0%';
    }
    timerId = setTimeoutFn(() => close(), remainingMs);
  }

  function open(rawResult) {
    ensureRoot();
    const m = mapScanOutcome(rawResult);
    const wasOpen = openState;
    if (!wasOpen && documentRef) {
      prevFocus = documentRef.activeElement || null;
      prevOverflow = documentRef.body.style.overflow || '';
      documentRef.body.style.overflow = 'hidden';
      openState = true;
      onOpen?.(m);
    }

    if (root) {
      const card = root.querySelector('#smCard');
      card.className = `sm-card sm-${m.tone}`;
      root.querySelector('#smIco').innerHTML = m.icon;
      root.querySelector('#smTitle').textContent = m.title;

      const who = root.querySelector('#smWho');
      who.textContent = m.participant || '';
      who.title = m.participant || '';
      who.hidden = !m.participant;

      const metaParts = [m.schoolId, m.program].filter(Boolean);
      const meta = root.querySelector('#smMeta');
      meta.textContent = metaParts.join(' · ');
      meta.title = meta.textContent;
      meta.hidden = metaParts.length === 0;

      const evEl = root.querySelector('#smEv');
      evEl.textContent = m.event || '';
      evEl.title = m.event || '';
      evEl.hidden = !m.event;

      root.querySelector('#smDesc').textContent = m.message;
      root.querySelector('#smTime').textContent = `Scan time: ${m.timeLabel}`;
      root.querySelector('#smLive').textContent = `${m.title}. ${m.participant ? m.participant + '. ' : ''}${m.message}`;

      root.hidden = false;
      root.querySelector('#smNext').focus();
    } else {
      openState = true;
    }

    onTone?.(m.tone, m.key);
    onVibrate?.(m.tone, m.key);

    const ms = Number(config?.durations?.[m.key] ?? 0);
    startCountdown(ms);
    return m;
  }

  function close() {
    if (!openState) return;
    clearTimer();
    openState = false;
    paused = false;
    remainingMs = 0;
    if (root) root.hidden = true;
    if (documentRef) {
      documentRef.body.style.overflow = prevOverflow;
      const fallback = documentRef.getElementById('manual') || documentRef.getElementById('start');
      const target = prevFocus && typeof prevFocus.focus === 'function' ? prevFocus : fallback;
      target?.focus?.();
    }
    onClose?.();
  }

  return {
    open,
    close,
    pause,
    resume,
    isOpen: () => openState
  };
}
