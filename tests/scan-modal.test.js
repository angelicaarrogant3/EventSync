const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadModal = () => import('../js/admin/scan-modal.js');

function makeFakeDom() {
  const listeners = new WeakMap();
  const makeEl = tag => {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      hidden: false,
      style: {},
      children: [],
      attributes: {},
      textContent: '',
      _innerHTML: '',
      title: '',
      offsetWidth: 100,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, fn) {
        if (!listeners.has(this)) listeners.set(this, new Map());
        const m = listeners.get(this);
        if (!m.has(type)) m.set(type, []);
        m.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        const m = listeners.get(this);
        for (const fn of (m?.get(type) || [])) fn({ target: this, preventDefault() {}, ...ev });
      },
      focus() { doc.activeElement = this; },
      querySelector(sel) {
        if (!sel.startsWith('#')) return null;
        const id = sel.slice(1);
        const find = node => {
          if (node.id === id) return node;
          for (const c of (node.children || [])) {
            const hit = find(c);
            if (hit) return hit;
          }
          return null;
        };
        return find(this);
      }
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML; },
      set(val) {
        el._innerHTML = String(val);
        // Populate known modal child IDs so querySelector('#...') works in Node
        const ids = ['smLive', 'smCard', 'smIco', 'smTitle', 'smWho', 'smMeta', 'smEv', 'smDesc', 'smTime', 'smProg', 'smBar', 'smNext'];
        if (el.id === 'scanModal' && el.children.length === 0) {
          for (const id of ids) {
            const child = makeEl(id === 'smNext' ? 'button' : 'div');
            child.id = id;
            el.children.push(child);
          }
        }
      }
    });
    return el;
  };

  const manualBtn = makeEl('input');
  manualBtn.id = 'manual';
  const body = makeEl('body');
  body.style.overflow = 'auto';
  const doc = {
    body,
    activeElement: manualBtn,
    createElement: makeEl,
    getElementById: id => (id === 'manual' ? manualBtn : body.querySelector('#' + id))
  };
  return { doc, manualBtn };
}

function makeFakeTimers() {
  let now = 10_000;
  let nextId = 1;
  const tasks = new Map();
  return {
    nowFn: () => now,
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      tasks.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn(id) { tasks.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...tasks.entries()]) {
        if (t.at <= now) {
          tasks.delete(id);
          t.fn();
        }
      }
    },
    pendingCount: () => tasks.size
  };
}

test('mapScanOutcome maps all 9 outcomes with icon, title, and semantic tone', async () => {
  const { mapScanOutcome } = await loadModal();

  const cases = [
    [{ status: 'ok', participant: 'Ana Cruz', school_id: '2024-01', course: 'BSCS', year_level: 3, event: 'Tech Day' }, 'CHECKED_IN', 'green'],
    [{ status: 'duplicate', participant: 'Ana Cruz', checked_in_at: '2026-11-25T00:00:00Z', verified_by_name: 'Gate 1' }, 'ALREADY_CHECKED_IN', 'amber'],
    [{ status: 'not_started', code: 'EVENT_NOT_STARTED', opensAt: '2026-11-24T23:00:00Z' }, 'NOT_OPEN_YET', 'amber'],
    [{ status: 'ended', code: 'EVENT_ENDED', endsAt: '2026-11-25T09:00:00Z' }, 'ATTENDANCE_CLOSED', 'amber'],
    [{ status: 'wrong_event', code: 'WRONG_EVENT', event: 'Other Summit' }, 'WRONG_EVENT', 'red'],
    [{ status: 'cancelled', code: 'REGISTRATION_CANCELLED' }, 'REGISTRATION_CANCELLED', 'red'],
    [{ status: 'cancelled', code: 'EVENT_CANCELLED' }, 'EVENT_CANCELLED', 'red'],
    [{ status: 'invalid', code: 'INVALID_QR' }, 'INVALID_QR', 'red'],
    [{ status: 'queued', code: 'SAVED_OFFLINE' }, 'SAVED_OFFLINE', 'blue']
  ];

  for (const [input, expectedKey, expectedTone] of cases) {
    const out = mapScanOutcome(input);
    assert.equal(out.key, expectedKey);
    assert.equal(out.tone, expectedTone);
    assert.ok(out.icon.includes('<svg'), `${expectedKey} should have SVG icon`);
    assert.ok(out.title.length > 0);
  }
  assert.match(mapScanOutcome({ status: 'duplicate', verified_by_name: 'Gate 1', checked_in_at: '2026-11-25T00:00:00Z' }).message, /Gate 1/);
  assert.match(mapScanOutcome({ status: 'not_started', code: 'EVENT_NOT_STARTED', opensAt: '2026-11-24T23:00:00Z' }).message, /No attendance was recorded/);
  assert.match(mapScanOutcome({ status: 'invalid', code: 'INVALID_QR' }).message, /not an EventSync pass/);
});

test('createScanModal: auto-close timers, red errors stay open, scroll lock, replace, pause/resume, focus restore', async () => {
  const { createScanModal } = await loadModal();
  const { doc, manualBtn } = makeFakeDom();
  const timers = makeFakeTimers();
  let tones = [];
  const modal = createScanModal({
    documentRef: doc,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: timers.nowFn,
    onTone: t => tones.push(t)
  });

  // 1. CHECKED_IN opens, locks scroll, focuses Scan next, auto-closes after 2000ms
  modal.open({ status: 'ok', participant: 'Juan Cruz', event: 'Summit' });
  assert.equal(modal.isOpen(), true);
  assert.equal(doc.body.style.overflow, 'hidden');
  assert.equal(doc.activeElement.id, 'smNext');
  assert.equal(tones[0], 'green');
  timers.advance(1999);
  assert.equal(modal.isOpen(), true);
  timers.advance(1);
  assert.equal(modal.isOpen(), false);
  assert.equal(doc.body.style.overflow, 'auto');
  assert.equal(doc.activeElement, manualBtn);

  // 2. Warning (amber / blue) auto-closes at 3000ms, and pause/resume holds countdown
  modal.open({ status: 'duplicate', participant: 'Juan Cruz', checked_in_at: '2026-11-25T00:00:00Z' });
  timers.advance(1500);
  modal.pause();
  timers.advance(5000);
  assert.equal(modal.isOpen(), true, 'paused modal must not auto-close');
  modal.resume();
  timers.advance(1499);
  assert.equal(modal.isOpen(), true);
  timers.advance(1);
  assert.equal(modal.isOpen(), false);

  // 3. Red error does NOT auto-close, and a new result replaces it without stacking
  modal.open({ status: 'invalid', code: 'INVALID_QR' });
  timers.advance(10_000);
  assert.equal(modal.isOpen(), true, 'red error must stay open until dismissed');
  modal.open({ status: 'queued', code: 'SAVED_OFFLINE' });
  assert.equal(doc.body.querySelector('#smTitle').textContent, 'SAVED OFFLINE');
  timers.advance(3000);
  assert.equal(modal.isOpen(), false);
});

test('scan.js pauses camera decoding while modal is open and supports manual verify', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'scan.js'), 'utf8');
  assert.match(src, /if\s*\(\s*mode\s*===\s*'scan'\s*&&\s*scanModal\.isOpen\(\)\s*\)\s*return;/);
  assert.match(src, /verify\(v,\s*'manual'\)/);
});
