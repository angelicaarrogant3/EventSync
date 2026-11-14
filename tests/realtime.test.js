// End-to-end realtime test: two real signed-in clients (like two devices).
// Client B must receive Client A's registration / cancellation as live events.
//   $env:PGURL = '<postgres connection string>' ; npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const skip = !process.env.PGURL && 'PGURL not set';
const cfg = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
const URL_ = (cfg.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1];
const KEY = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1];
const PASSWORD = 'Rt#' + Math.random().toString(36).slice(2) + 'A1';

let db, eventId, userIds = [], clients = [];

async function mkUser(tag) {
  const email = `rt-${tag}-${Date.now()}@eventsync.test`;
  const id = (await db.query(
    `insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,
       created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
     values ('00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',$1,crypt($2,gen_salt('bf')),now(),
       '{"provider":"email","providers":["email"],"created_by":"trusted_tool"}','{"full_name":"RT Test"}',now(),now(),'','','','') returning id`, [email, PASSWORD])).rows[0].id;
  await db.query(`insert into auth.identities(id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
     values (gen_random_uuid(),$1::uuid,jsonb_build_object('sub',$3::text,'email',$2::text),'email',$3::text,now(),now(),now())`, [id, email, String(id)]);
  userIds.push(id);
  const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  assert.ifError(error);
  clients.push(sb);
  return sb;
}

before(async () => {
  if (skip) return;
  db = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  eventId = (await db.query(`insert into public.events(title,venue,starts_at,ends_at,capacity,status)
    values ('RT TEST '||gen_random_uuid(),'Test Hall',now()+interval '1 hour',now()+interval '2 hours',5,'published') returning id`)).rows[0].id;
});
after(async () => {
  if (!db) return;
  for (const sb of clients) { await sb.removeAllChannels(); }
  await db.query('delete from public.events where id=$1', [eventId]);
  if (userIds.length) await db.query('delete from auth.users where id = any($1)', [userIds]);
  await db.end();
});

test('live update reaches a second connected client (register, then cancel)', { skip, timeout: 40000 }, async () => {
  const a = await mkUser('a'), b = await mkUser('b');

  const seen = [];
  const ch = b.channel('rt-test')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'events', filter: `id=eq.${eventId}` },
        p => seen.push(p.new.registered_count));
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('realtime subscribe timeout')), 15000);
    ch.subscribe(s => { if (s === 'SUBSCRIBED') { clearTimeout(t); res(); } });
  });
  const waitFor = async (n) => { for (let i = 0; i < 100 && !seen.includes(n); i++) await new Promise(r => setTimeout(r, 100)); return seen.includes(n); };

  const { data, error } = await a.rpc('register_for_event', { p_event_id: eventId });
  assert.ifError(error);
  assert.ok(data.qr_token);
  assert.ok(await waitFor(1), `client B should receive registered_count=1 (saw ${JSON.stringify(seen)})`);

  const { error: e2 } = await a.rpc('cancel_registration', { p_registration_id: data.id });
  assert.ifError(e2);
  assert.ok(await waitFor(0), `client B should receive registered_count=0 after cancel (saw ${JSON.stringify(seen)})`);
});
