const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const visibleHtml = html.replace(/<script[\s\S]*?<\/script>/gi, '');

test('landing page contains no banned technical jargon in visible markup', () => {
  const banned = [
    'HTTP', 'HTTPS', 'atomic', 'UUID', 'tamper-proof', 'PostgreSQL', 'database',
    'Row-Level Security', 'RPC', 'Pub/Sub', 'Realtime', 'node', 'API', 'token',
    'server', 'distributed', 'synchronized', 'endpoint', 'latency', 'cloud'
  ];
  for (const word of banned) {
    const re = new RegExp(`\\b${word.replace(/[-/]/g, '\\$&')}\\b`, 'i');
    assert.equal(re.test(visibleHtml), false, `index.html must not contain "${word}"`);
  }
});

test('landing page removed the 4 statistic cards, public_landing_stats call, and architecture section', () => {
  for (const removed of [
    'Published Events', 'Registered Participants', 'Check-ins Today', 'Check-in Velocity',
    'Distributed Architecture', 'Built on', 'public_landing_stats', 'stEvents', 'stReg', 'stChk', 'stRate'
  ]) {
    assert.equal(html.includes(removed), false, `index.html must not include "${removed}"`);
  }
});

test('landing page has required plain-language sections, single h1, Help details, and dashboard link', () => {
  assert.equal((visibleHtml.match(/<h1\b/gi) || []).length, 1);
  assert.ok(visibleHtml.includes('School events made easy'));
  assert.ok(visibleHtml.includes('Upcoming <span class="accent">events</span>'));
  assert.ok(visibleHtml.includes('What you can <span class="accent">do</span>'));
  assert.ok(visibleHtml.includes('Before you <span class="accent">start</span>'));
  assert.ok((visibleHtml.match(/<details\b/gi) || []).length === 4);
  assert.ok(html.includes('Go to my dashboard'));
  assert.ok(html.includes('No upcoming events yet. Please check back soon.'));
  assert.ok(html.includes('We could not load the events. Please refresh the page.'));
});

test('docs/ARCHITECTURE.md preserves the Distributed Architecture explanation', () => {
  const arch = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ARCHITECTURE.md'), 'utf8');
  assert.ok(arch.includes('Cloud Database'));
  assert.ok(arch.includes('Registration Node'));
  assert.ok(arch.includes('Scanner Station'));
  assert.ok(arch.includes('Organizer Hub'));
});
