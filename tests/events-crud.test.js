/**
 * EventSync: Event CRUD, Safe Delete, Archive, Force Delete & Live Broadcast API Tests
 * Runs an isolated in-process HTTP + Socket.IO server on an ephemeral port.
 */

const path = require('path');
module.paths.push(path.resolve(__dirname, '../server/node_modules'));

const http = require('http');
const assert = require('assert');
const { initializeDatabase, db } = require('../server/src/db/connection');
const app = require('../server/src/app');
const { initializeSockets } = require('../server/src/sockets/socketManager');
const { createAdministrator, createSession } = require('../server/src/services/auth.service');

let testAdminCookie = '';

function requestJson(baseUrl, method, urlPath, body = null, cookie = testAdminCookie) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-node-id': 'test-runner',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGetText(url, cookie = testAdminCookie) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: cookie ? { Cookie: cookie } : {}
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    }).on('error', reject);
  });
}

function httpPostText(url, text, cookie = testAdminCookie) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Content-Length': Buffer.byteLength(text),
          ...(cookie ? { Cookie: cookie } : {})
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.write(text);
    req.end();
  });
}

/**
 * Minimal Socket.IO v4 Engine.IO polling client to verify real server broadcasts
 */
async function createPollingSocketClient(baseUrl) {
  const handshake = await httpGetText(`${baseUrl}/socket.io/?EIO=4&transport=polling`);
  const jsonPart = handshake.body.replace(/^\d+/, '').replace(/^0/, '');
  const { sid } = JSON.parse(jsonPart);

  // Connect to default namespace '/'
  await httpPostText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, '40');
  // Drain namespace ack
  await httpGetText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`);

  const receivedEvents = [];
  let running = true;

  const pollLoop = (async () => {
    while (running) {
      try {
        const res = await httpGetText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
        if (!running) break;
        // Engine.IO packets separated by \x1e
        const packets = res.body.split('\x1e');
        for (const pkt of packets) {
          if (pkt === '2') {
            // Engine.IO ping -> respond with pong
            await httpPostText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, '3');
          } else if (pkt.startsWith('42')) {
            const [eventName, payload] = JSON.parse(pkt.slice(2));
            receivedEvents.push({ eventName, payload });
          }
        }
      } catch {
        break;
      }
    }
  })();

  return {
    receivedEvents,
    close: async () => {
      running = false;
      try {
        await httpPostText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, '41');
      } catch {}
      await pollLoop.catch(() => {});
    }
  };
}

async function runCrudTests() {
  console.log('\n================================================================');
  console.log('   EVENTSYNC: EVENT CRUD, SAFE DELETE & LIVE BROADCAST TESTS    ');
  console.log('================================================================\n');

  initializeDatabase();
  const testUsername = `crud_admin_${Date.now()}`;
  const adminUser = createAdministrator({
    full_name: 'CRUD Test Admin',
    username: testUsername,
    email: `${testUsername}@eventsync.test`,
    password: 'TestPassword123!'
  });
  const { sessionId } = createSession(adminUser.id);
  testAdminCookie = `eventsync_sid=${sessionId}`;

  const server = http.createServer(app);
  initializeSockets(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Test Server] Listening on ${baseUrl}`);

  const socketClient = await createPollingSocketClient(baseUrl);

  try {
    // 1. Validation checks on Create
    console.log('\n1. Create validation (missing title, end_time <= start_time)...');
    const badTitle = await requestJson(baseUrl, 'POST', '/api/events', {
      title: '   ',
      venue: 'Hall A',
      event_date: '2026-12-01',
      start_time: '09:00',
      end_time: '12:00',
      capacity: 10
    });
    assert.strictEqual(badTitle.status, 400);
    assert.strictEqual(badTitle.data.error.code, 'INVALID_INPUT');

    const badTime = await requestJson(baseUrl, 'POST', '/api/events', {
      title: 'Invalid Time Event',
      venue: 'Hall A',
      event_date: '2026-12-01',
      start_time: '14:00',
      end_time: '12:00',
      capacity: 10
    });
    assert.strictEqual(badTime.status, 400);
    assert.strictEqual(badTime.data.error.code, 'INVALID_INPUT');
    console.log('  [PASS] Invalid create payloads rejected with 400 INVALID_INPUT.');

    // 2. Create & Read
    console.log('\n2. Create & Read Event...');
    const createRes = await requestJson(baseUrl, 'POST', '/api/events', {
      title: 'CRUD Test Seminar',
      description: 'Initial notes',
      venue: 'Room 101',
      event_date: '2026-12-05',
      start_time: '09:00',
      end_time: '11:00',
      capacity: 25,
      status: 'OPEN'
    });
    assert.strictEqual(createRes.status, 201);
    const ev1 = createRes.data.data;
    assert(ev1.id, 'Created event must have an id');

    const listRes = await requestJson(baseUrl, 'GET', '/api/events');
    assert.strictEqual(listRes.status, 200);
    assert(listRes.data.data.some(e => e.id === ev1.id), 'Created event must appear in GET /api/events');

    const getRes = await requestJson(baseUrl, 'GET', `/api/events/${ev1.id}`);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.data.data.title, 'CRUD Test Seminar');
    console.log('  [PASS] Event created and retrieved via REST.');

    // 3. Update & ENDED event rule
    console.log('\n3. Update Event & ENDED immutability rule...');
    const updRes = await requestJson(baseUrl, 'PUT', `/api/events/${ev1.id}`, {
      venue: 'Room 202',
      capacity: 30
    });
    assert.strictEqual(updRes.status, 200);
    assert.strictEqual(updRes.data.data.venue, 'Room 202');

    const endRes = await requestJson(baseUrl, 'PATCH', `/api/events/${ev1.id}/status`, { status: 'ENDED' });
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.data.data.status, 'ENDED');

    const editEndedTitle = await requestJson(baseUrl, 'PUT', `/api/events/${ev1.id}`, {
      title: 'Should Fail'
    });
    assert.strictEqual(editEndedTitle.status, 400);
    assert.strictEqual(editEndedTitle.data.error.code, 'EVENT_ENDED');

    const editEndedNotes = await requestJson(baseUrl, 'PUT', `/api/events/${ev1.id}`, {
      description: 'Updated post-event notes'
    });
    assert.strictEqual(editEndedNotes.status, 200);
    assert.strictEqual(editEndedNotes.data.data.description, 'Updated post-event notes');
    console.log('  [PASS] Update and ENDED notes-only rule enforced.');

    // 4. Delete with NO data
    console.log('\n4. Delete event with NO registrations/attendance...');
    const delEmpty = await requestJson(baseUrl, 'DELETE', `/api/events/${ev1.id}`);
    assert.strictEqual(delEmpty.status, 200);
    assert.strictEqual(delEmpty.data.data.action, 'DELETED');

    const getAfterDel = await requestJson(baseUrl, 'GET', `/api/events/${ev1.id}`);
    assert.strictEqual(getAfterDel.status, 404);
    console.log('  [PASS] Empty event deleted cleanly.');

    // 5. Delete blocked when event HAS data (409 EVENT_HAS_DATA)
    console.log('\n5. Safe Delete blocked with 409 EVENT_HAS_DATA when registrations/attendance exist...');
    const createWithData = await requestJson(baseUrl, 'POST', '/api/events', {
      title: 'Protected Event With Attendees',
      venue: 'Auditorium',
      event_date: '2026-12-10',
      start_time: '08:00',
      end_time: '17:00',
      capacity: 10,
      status: 'OPEN'
    });
    assert.strictEqual(createWithData.status, 201);
    const ev2 = createWithData.data.data;

    const regRes = await requestJson(baseUrl, 'POST', '/api/registrations', {
      eventId: ev2.id,
      participant: {
        school_id: `CRUD-STU-${Date.now()}`,
        full_name: 'Test Student',
        email: 'test.student@university.edu',
        department_or_course: 'BSCS',
        year_level: '3rd Year',
        role: 'STUDENT'
      }
    });
    assert.strictEqual(regRes.status, 201);
    const qrToken = regRes.data.data.registration.qrToken;

    const scanRes = await requestJson(baseUrl, 'POST', '/api/attendance/scan', {
      eventId: ev2.id,
      qrToken,
      clientScanId: `crud-scan-${Date.now()}`
    });
    assert.strictEqual(scanRes.status, 200);

    // Try capacity below registered (1)
    const capLow = await requestJson(baseUrl, 'PUT', `/api/events/${ev2.id}`, { capacity: 0 });
    assert.strictEqual(capLow.status, 400);

    // Default DELETE must be blocked with 409 EVENT_HAS_DATA
    const blockedDel = await requestJson(baseUrl, 'DELETE', `/api/events/${ev2.id}`);
    assert.strictEqual(blockedDel.status, 409);
    assert.strictEqual(blockedDel.data.error.code, 'EVENT_HAS_DATA');
    assert.strictEqual(blockedDel.data.error.counts.registrations, 1);
    assert.strictEqual(blockedDel.data.error.counts.attendance, 1);
    console.log('  [PASS] Default DELETE returned 409 EVENT_HAS_DATA with accurate counts.');

    // 6. Archive (?archive=true)
    console.log('\n6. Archive event (?archive=true)...');
    const archiveRes = await requestJson(baseUrl, 'DELETE', `/api/events/${ev2.id}?archive=true`);
    assert.strictEqual(archiveRes.status, 200);
    assert.strictEqual(archiveRes.data.data.action, 'ARCHIVED');

    const defaultList = await requestJson(baseUrl, 'GET', '/api/events');
    assert(!defaultList.data.data.some(e => e.id === ev2.id), 'Archived event must be hidden from default list');

    const withArchivedList = await requestJson(baseUrl, 'GET', '/api/events?includeArchived=true');
    const archivedItem = withArchivedList.data.data.find(e => e.id === ev2.id);
    assert(archivedItem && archivedItem.archived === 1, 'Archived event must appear when includeArchived=true');
    assert.strictEqual(archivedItem.registered_count, 1);
    assert.strictEqual(archivedItem.checked_in_count, 1);
    console.log('  [PASS] Event archived, hidden from normal lists, and data preserved.');

    // 7. Force Delete (?force=true)
    console.log('\n7. Force Delete (?force=true) removes event + registrations + attendance...');
    const forceDelRes = await requestJson(baseUrl, 'DELETE', `/api/events/${ev2.id}?force=true`);
    assert.strictEqual(forceDelRes.status, 200);
    assert.strictEqual(forceDelRes.data.data.action, 'FORCE_DELETED');
    assert.strictEqual(forceDelRes.data.data.counts.registrations, 1);
    assert.strictEqual(forceDelRes.data.data.counts.attendance, 1);

    const afterForce = await requestJson(baseUrl, 'GET', `/api/events/${ev2.id}`);
    assert.strictEqual(afterForce.status, 404);

    // Offline sync for deleted event must report EVENT_NOT_FOUND ("Event no longer exists.")
    const syncAfterDel = await requestJson(baseUrl, 'POST', '/api/attendance/sync', [
      { eventId: ev2.id, qrToken, clientScanId: `late-sync-${Date.now()}`, scannedAt: '2026-12-10 09:00:00' }
    ]);
    assert.strictEqual(syncAfterDel.status, 200);
    assert.strictEqual(syncAfterDel.data.data.results[0].status, 'EVENT_NOT_FOUND');
    assert(syncAfterDel.data.data.results[0].message.toLowerCase().includes('no longer exists'));
    console.log('  [PASS] Force delete removed event + child rows cleanly; offline sync reports "Event no longer exists."');

    // 8. Audit Log & Live Socket.IO Broadcasts
    console.log('\n8. Verifying audit_log entries & live Socket.IO broadcasts...');
    const auditRows = db.prepare(`SELECT action FROM audit_log WHERE entity = 'EVENT' AND entity_id IN (?, ?)`).all(ev1.id, ev2.id);
    const actions = auditRows.map(r => r.action);
    assert(actions.includes('CREATE'), 'audit_log must contain CREATE');
    assert(actions.includes('UPDATE'), 'audit_log must contain UPDATE');
    assert(actions.includes('STATUS_CHANGE'), 'audit_log must contain STATUS_CHANGE');
    assert(actions.includes('ARCHIVE'), 'audit_log must contain ARCHIVE');
    assert(actions.includes('DELETE'), 'audit_log must contain DELETE');

    // Give polling loop a moment to receive final packets
    await new Promise(r => setTimeout(r, 250));
    const eventNames = socketClient.receivedEvents.map(e => e.eventName);
    assert(eventNames.includes('event:updated'), 'Socket.IO must broadcast event:updated');
    assert(eventNames.includes('event:deleted'), 'Socket.IO must broadcast event:deleted');
    const deletedPayloads = socketClient.receivedEvents.filter(e => e.eventName === 'event:deleted').map(e => e.payload);
    assert(deletedPayloads.some(p => p.eventId === ev1.id && p.action === 'DELETED'));
    assert(deletedPayloads.some(p => p.eventId === ev2.id && p.action === 'ARCHIVED' && p.archived === true));
    assert(deletedPayloads.some(p => p.eventId === ev2.id && p.action === 'FORCE_DELETED'));
    console.log('  [PASS] audit_log & live Socket.IO broadcasts (event:updated, event:deleted) verified.');

    console.log('\n================================================================');
    console.log('   ALL EVENT CRUD & SAFE DELETE TESTS PASSED!                   ');
    console.log('================================================================\n');
  } finally {
    await socketClient.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

runCrudTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[CRUD TEST ERROR]', err);
    process.exit(1);
  });
