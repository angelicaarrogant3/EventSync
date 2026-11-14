const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const loadMod = () => import('../js/shared/event-images.js');

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const TEXT_AS_PNG = new TextEncoder().encode('hello this is plain text pretending to be a png');

test('magic-byte validation accepts JPEG, PNG, WebP and rejects text/SVG/GIF with 415', async () => {
  const { validateImageBuffer } = await loadMod();
  assert.deepEqual(validateImageBuffer(PNG_BYTES), { ok: true, mime: 'image/png' });
  assert.deepEqual(validateImageBuffer(JPG_BYTES), { ok: true, mime: 'image/jpeg' });
  assert.deepEqual(validateImageBuffer(WEBP_BYTES), { ok: true, mime: 'image/webp' });

  for (const bad of [GIF_BYTES, SVG_BYTES, TEXT_AS_PNG]) {
    const res = validateImageBuffer(bad);
    assert.equal(res.ok, false);
    assert.equal(res.status, 415);
  }
});

test('oversized file (> 5 MB) is rejected with 413', async () => {
  const { validateImageBuffer, MAX_EVENT_IMAGE_BYTES } = await loadMod();
  const res = validateImageBuffer(PNG_BYTES, MAX_EVENT_IMAGE_BYTES + 1);
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
});

test('path traversal is blocked and server-safe filenames ignore user filename', async () => {
  const { isSafeImagePath, makeEventImagePath, eventImageUrl } = await loadMod();
  assert.equal(isSafeImagePath('../etc/passwd'), false);
  assert.equal(isSafeImagePath('/abs/path.png'), false);
  assert.equal(isSafeImagePath('a\\b.png'), false);
  assert.equal(isSafeImagePath('evt_123_abc.webp'), true);

  const p = makeEventImagePath('550e8400-e29b-41d4-a716-446655440000', 'image/webp');
  assert.match(p, /^evt_550e8400-e29b-41d4-a716-446655440000_[a-z0-9]+\.webp$/i);

  const url = eventImageUrl({ image_path: p, image_updated_at: '2026-11-14T12:00:00Z' }, 'https://example.supabase.co');
  assert.match(url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/event-images\/evt_.*\?v=\d+$/);
  assert.equal(eventImageUrl({ image_path: null }, 'https://example.supabase.co'), null);
});

// ---- Database + Storage RLS tests (rolled back) ----
const skip = !process.env.PGURL && 'PGURL not set';
let c, adminId, userId;

before(async () => {
  if (skip) return;
  c = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  adminId = (await c.query("select id from public.profiles where role = 'admin' order by created_at limit 1")).rows[0]?.id;
  userId = (await c.query("select id from public.profiles where role = 'user' order by created_at limit 1")).rows[0]?.id;
  assert.ok(adminId && userId, 'need at least 1 admin and 1 participant account');
});
after(async () => { if (c) await c.end(); });
beforeEach(async () => { if (c) await c.query('begin'); });
afterEach(async () => { if (c) await c.query('rollback'); });

async function asRole(role, uid, fn) {
  await c.query('savepoint sp');
  try {
    if (uid) {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role })]);
    } else {
      await c.query("select set_config('request.jwt.claims', '{}', true)");
    }
    await c.query(`set local role ${role}`);
    const res = await fn();
    await c.query('release savepoint sp');
    await c.query('reset role');
    return res;
  } catch (err) {
    await c.query('rollback to savepoint sp');
    await c.query('reset role');
    throw err;
  }
}

test('migration preserves existing events and configures event-images bucket', { skip }, async () => {
  const cols = (await c.query(
    "select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name='events' and column_name in ('image_path','image_updated_at')"
  )).rows;
  assert.equal(cols.length, 2);
  assert.ok(cols.every(r => r.is_nullable === 'YES'));

  const viewCols = (await c.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='event_stats' and column_name in ('image_path','image_updated_at')"
  )).rows;
  assert.equal(viewCols.length, 2);

  const bucket = (await c.query("select id, public, file_size_limit, allowed_mime_types from storage.buckets where id='event-images'")).rows[0];
  assert.ok(bucket);
  assert.equal(bucket.public, true);
  assert.equal(Number(bucket.file_size_limit), 5242880);
  assert.deepEqual(bucket.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
});

test('admin upload/replace/remove/archive/delete + participant/anon RLS rejections', { skip }, async () => {
  const evId = (await c.query(
    "insert into public.events(title,venue,starts_at,ends_at,status) values ('IMG TEST','Main Hall',now()+interval '1 day',now()+interval '2 days','published') returning id"
  )).rows[0].id;

  // Anonymous cannot insert into storage.objects or update events
  await assert.rejects(() => asRole('anon', null, () =>
    c.query("insert into storage.objects(bucket_id, name, owner) values ('event-images', 'anon.webp', null)")
  ));
  await assert.rejects(() => asRole('anon', null, () =>
    c.query("update public.events set image_path = 'anon.webp' where id = $1", [evId])
  ).then(r => { if (r.rowCount === 0) throw new Error('blocked'); }));

  // Participant cannot insert into storage.objects or update events
  await assert.rejects(() => asRole('authenticated', userId, () =>
    c.query("insert into storage.objects(bucket_id, name, owner) values ('event-images', 'user.webp', $1)", [userId])
  ));
  const userUpd = await asRole('authenticated', userId, () =>
    c.query("update public.events set image_path = 'user.webp' where id = $1", [evId])
  );
  assert.equal(userUpd.rowCount, 0);

  // Admin uploads image -> sets image_path & logs event.image_uploaded
  const path1 = `evt_${evId}_one.webp`;
  await asRole('authenticated', adminId, async () => {
    await c.query("insert into storage.objects(bucket_id, name, owner) values ('event-images', $1, $2)", [path1, adminId]);
    await c.query("update public.events set image_path = $1, image_updated_at = now() where id = $2", [path1, evId]);
  });
  let logs = (await c.query("select action from public.activity_logs where entity_id = $1 order by id", [evId])).rows.map(r => r.action);
  assert.ok(logs.includes('event.image_uploaded'));

  // Admin replaces image -> updates path, logs event.image_replaced
  const path2 = `evt_${evId}_two.webp`;
  await asRole('authenticated', adminId, async () => {
    await c.query("insert into storage.objects(bucket_id, name, owner) values ('event-images', $1, $2)", [path2, adminId]);
    await c.query("update public.events set image_path = $1, image_updated_at = now() where id = $2", [path2, evId]);
  });
  logs = (await c.query("select action from public.activity_logs where entity_id = $1 order by id", [evId])).rows.map(r => r.action);
  assert.ok(logs.includes('event.image_replaced'));

  // Archiving (status = 'closed') keeps the image
  await asRole('authenticated', adminId, () =>
    c.query("update public.events set status = 'closed' where id = $1", [evId])
  );
  const afterArchive = (await c.query("select image_path from public.events where id = $1", [evId])).rows[0];
  assert.equal(afterArchive.image_path, path2);

  // Removing image sets image_path to null and logs event.image_removed
  await asRole('authenticated', adminId, async () => {
    await c.query("update public.events set image_path = null, image_updated_at = now() where id = $1", [evId]);
  });
  const afterRemove = (await c.query("select image_path from public.events where id = $1", [evId])).rows[0];
  assert.equal(afterRemove.image_path, null);
  logs = (await c.query("select action from public.activity_logs where entity_id = $1 order by id", [evId])).rows.map(r => r.action);
  assert.ok(logs.includes('event.image_removed'));

  // Public upcoming events RPC returns published upcoming events with image_path and no PII
  await c.query("update public.events set status = 'published', image_path = 'pub.webp' where id = $1", [evId]);
  const pubRows = await asRole('anon', null, () => c.query("select * from public.public_upcoming_events(12)"));
  const found = pubRows.rows.find(r => r.id === evId);
  assert.ok(found);
  assert.equal(found.image_path, 'pub.webp');
  assert.equal('created_by' in found, false);
});

test('uploadEventImage / removeEventImage / deleteEventStorageFile manage storage cleanup and rollback', async () => {
  const { uploadEventImage, removeEventImage, deleteEventStorageFile } = await loadMod();
  const stored = new Set();
  const dbRows = new Map([['ev-1', { image_path: null, image_updated_at: null }]]);
  let failNextUpdate = false;

  const mockSupabase = {
    storage: {
      from: () => ({
        upload: async (path) => { stored.add(path); return { error: null }; },
        remove: async (paths) => { paths.forEach(p => stored.delete(p)); return { error: null }; }
      })
    },
    from: () => ({
      update: (vals) => ({
        eq: async (_col, id) => {
          if (failNextUpdate) return { error: new Error('DB failure') };
          dbRows.set(id, vals);
          return { error: null };
        }
      })
    })
  };

  // Upload
  const r1 = await uploadEventImage(mockSupabase, 'ev-1', PNG_BYTES, null);
  assert.equal(stored.size, 1);
  assert.ok(stored.has(r1.imagePath));

  // Replace deletes old file
  const r2 = await uploadEventImage(mockSupabase, 'ev-1', WEBP_BYTES, r1.imagePath);
  assert.equal(stored.size, 1);
  assert.equal(stored.has(r1.imagePath), false);
  assert.equal(stored.has(r2.imagePath), true);

  // DB failure rolls back uploaded file (no partial/orphan file)
  failNextUpdate = true;
  await assert.rejects(() => uploadEventImage(mockSupabase, 'ev-1', JPG_BYTES, r2.imagePath));
  assert.equal(stored.size, 1);
  assert.equal(stored.has(r2.imagePath), true);
  failNextUpdate = false;

  // Remove clears image_path and deletes storage file
  const rem = await removeEventImage(mockSupabase, 'ev-1', r2.imagePath);
  assert.equal(rem.imageUrl, null);
  assert.equal(dbRows.get('ev-1').image_path, null);
  assert.equal(stored.size, 0);

  // Delete event storage file helper removes existing file
  const r3 = await uploadEventImage(mockSupabase, 'ev-1', PNG_BYTES, null);
  assert.equal(stored.size, 1);
  await deleteEventStorageFile(mockSupabase, r3.imagePath);
  assert.equal(stored.size, 0);
});
