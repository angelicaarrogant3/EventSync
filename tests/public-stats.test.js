const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cfg = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
const URL_ = (cfg.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1];
const KEY = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1];
const skip = (!URL_ || URL_.includes('YOUR_') || !process.env.PGURL) && 'Supabase not configured';

test('public_landing_stats: anon receives only aggregate integer counts, no PII', { skip }, async () => {
  const r = await fetch(`${URL_}/rest/v1/rpc/public_landing_stats`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(Object.keys(data).sort(), ['checkins_today', 'events_count', 'registered_count']);
  for (const k of Object.keys(data)) {
    assert.equal(typeof data[k], 'number');
    assert.ok(Number.isInteger(data[k]) && data[k] >= 0);
  }
});
