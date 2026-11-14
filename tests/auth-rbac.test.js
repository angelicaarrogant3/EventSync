/**
 * EventSync: Authentication, RBAC, Socket.IO Auth, Migration & Report Tests
 * Runs against an isolated in-process HTTP + Socket.IO server on an ephemeral port.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const http = require('http');
const assert = require('assert');
const Database = require('better-sqlite3');
const { initializeDatabase, db } = require('../server/src/db/connection');
const app = require('../server/src/app');
const { initializeSockets } = require('../server/src/sockets/socketManager');
const { createAdministrator, failedLoginBuckets } = require('../server/src/services/auth.service');
const { buildStartupLinks, getLocalIpAddresses, formatStartupBanner } = require('../server/src/utils/network');

function requestJson(baseUrl, method, urlPath, body = null, cookie = '') {
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
          'Accept': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'];
          const nextCookie = Array.isArray(setCookie) && setCookie.length > 0
            ? setCookie[0].split(';')[0]
            : null;
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw), setCookie: nextCookie });
          } catch {
            resolve({ status: res.statusCode, raw, setCookie: nextCookie });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runAuthRbacTests() {
  console.log('\n================================================================');
  console.log('   EVENTSYNC: AUTH, RBAC, SOCKET AUTH & REPORTS TEST SUITE      ');
  console.log('================================================================\n');

  initializeDatabase();
  const server = http.createServer(app);
  initializeSockets(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ts = Date.now();

  try {
    // 1. Startup link-building & banner builder tests
    console.log('1. Startup link-building & banner builder...');
    const fakeIfaces = {
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.25.80.1' }],
      'Link-Local': [{ family: 'IPv4', internal: false, address: '169.254.10.20' }],
      'Local Area Connection* 10': [{ family: 'IPv4', internal: false, address: '192.168.137.1' }],
      'Ethernet': [{ family: 'IPv4', internal: false, address: '10.0.0.25' }],
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.14' }]
    };
    const detected = getLocalIpAddresses(fakeIfaces);
    const links = buildStartupLinks({ protocol: 'http', port: 3000, lanAddresses: detected });
    assert.strictEqual(links.hasNetwork, true);
    assert.strictEqual(links.localUrl, 'http://localhost:3000');
    assert.strictEqual(links.networkUrl, 'http://192.168.1.14:3000');
    assert.strictEqual(links.hotspotUrl, 'http://192.168.137.1:3000');
    assert.strictEqual(links.loginUrl, 'http://192.168.1.14:3000/login');
    assert.strictEqual(links.signupUrl, 'http://192.168.1.14:3000/signup');

    const banner = formatStartupBanner({ links, copied: true, hasAdmin: true });
    assert(banner.includes('EventSync is running!'));
    assert(banner.includes('- Local:    http://localhost:3000'));
    assert(banner.includes('- Network:  http://192.168.1.14:3000'));
    assert(banner.includes('Copied local address to clipboard!'));

    const offlineLinks = buildStartupLinks({ protocol: 'http', port: 3000, lanAddresses: [] });
    assert.strictEqual(offlineLinks.hasNetwork, false);
    assert.strictEqual(offlineLinks.networkUrl, null);
    const offlineBanner = formatStartupBanner({ links: offlineLinks, copied: false, hasAdmin: false });
    assert(offlineBanner.includes('No network detected. Connect to Wi-Fi to use other devices.'));
    assert(offlineBanner.includes('No administrator yet. Run: npm run create-admin'));
    console.log('  [PASS] Startup links & banner builder handle LAN, virtual/hotspot priority, and offline state.');

    // 2. Public signup cannot create an Administrator
    console.log('\n2. Public participant signup & role-escalation prevention...');
    const pUsername = `part_${ts}`;
    const signupRes = await requestJson(baseUrl, 'POST', '/api/auth/signup', {
      full_name: 'Alice Participant',
      username: pUsername,
      email: `${pUsername}@university.edu`,
      password: 'Password123!',
      confirm_password: 'Password123!',
      contact_number: '09171112222',
      school_id: `SID-${ts}`,
      department_or_course: 'BSCS',
      year_level: '3rd Year',
      role: 'administrator' // Attempted privilege escalation!
    });
    assert.strictEqual(signupRes.status, 201);
    assert.strictEqual(signupRes.data.data.user.role, 'participant', 'Public signup must always force role=participant');

    // Second participant for cross-user isolation tests
    const p2Username = `part2_${ts}`;
    await requestJson(baseUrl, 'POST', '/api/auth/signup', {
      full_name: 'Bob Participant',
      username: p2Username,
      email: `${p2Username}@university.edu`,
      password: 'Password123!',
      confirm_password: 'Password123!',
      school_id: `SID2-${ts}`,
      department_or_course: 'BSIT',
      year_level: '2nd Year'
    });
    console.log('  [PASS] Public signup created participant and ignored role=administrator.');

    // 3. Login, wrong password, rate limiting, logout
    console.log('\n3. Login, wrong password, rate limiting, role redirection, logout...');
    const badPw = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      usernameOrEmail: pUsername,
      password: 'WrongPassword!'
    });
    assert.strictEqual(badPw.status, 401);

    // Trigger rate limit (10 failed attempts total)
    for (let i = 0; i < 9; i++) {
      await requestJson(baseUrl, 'POST', '/api/auth/login', {
        usernameOrEmail: pUsername,
        password: 'WrongPassword!'
      });
    }
    const rateLimited = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      usernameOrEmail: pUsername,
      password: 'Password123!'
    });
    assert.strictEqual(rateLimited.status, 429, '11th attempt within 10 minutes must be rate-limited');
    failedLoginBuckets.clear(); // Reset for subsequent login tests

    const partLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      usernameOrEmail: pUsername,
      password: 'Password123!'
    });
    assert.strictEqual(partLogin.status, 200);
    assert.strictEqual(partLogin.data.data.redirectTo, '/app');
    const partCookie = partLogin.setCookie;
    assert(partCookie, 'Login must set httpOnly session cookie');

    const part2Login = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      usernameOrEmail: p2Username,
      password: 'Password123!'
    });
    const part2Cookie = part2Login.setCookie;

    const adminUser = createAdministrator({
      full_name: 'Test Admin',
      username: `admin_${ts}`,
      email: `admin_${ts}@university.edu`,
      password: 'AdminPassword123!'
    });
    const adminLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      usernameOrEmail: adminUser.username,
      password: 'AdminPassword123!'
    });
    assert.strictEqual(adminLogin.status, 200);
    assert.strictEqual(adminLogin.data.data.redirectTo, '/admin');
    const adminCookie = adminLogin.setCookie;
    console.log('  [PASS] Login, wrong password, rate limiting, and role redirection verified.');

    // 4. Unauthenticated = 401; Participant on Admin endpoints = 403
    console.log('\n4. Unauthenticated (401) & Participant RBAC (403) enforcement...');
    const adminEndpoints = [
      ['POST', '/api/events', { title: 'X', venue: 'V', event_date: '2026-12-01', start_time: '09:00', end_time: '10:00', capacity: 10 }],
      ['GET', '/api/admin/users', null],
      ['POST', '/api/admin/users/admin', { username: 'x', email: 'x@x.com', password: 'Password123!' }],
      ['GET', '/api/admin/participants', null],
      ['GET', '/api/admin/records', null],
      ['GET', '/api/admin/activity', null],
      ['GET', '/api/reports/summary', null],
      ['GET', '/api/nodes', null],
      ['POST', '/api/attendance/scan', { eventId: '1', qrToken: 'abc' }],
      ['POST', '/api/attendance/sync', []],
      ['POST', '/api/attendance/manual', { eventId: '1', schoolId: '1' }],
      ['POST', '/api/registrations', { eventId: '1', participant: {} }]
    ];

    for (const [m, ep, body] of adminEndpoints) {
      const unauth = await requestJson(baseUrl, m, ep, body, '');
      assert.strictEqual(unauth.status, 401, `Unauthenticated ${m} ${ep} must return 401`);
      const forbidden = await requestJson(baseUrl, m, ep, body, partCookie);
      assert.strictEqual(forbidden.status, 403, `Participant ${m} ${ep} must return 403`);
    }
    console.log('  [PASS] All Administrator endpoints returned 401 unauthenticated and 403 for Participant.');

    // 5. Participant self-registration, own QR, cross-participant isolation, QR reissue, Reports
    console.log('\n5. Participant own-data isolation, QR reissue & Report totals...');
    const evRes = await requestJson(baseUrl, 'POST', '/api/events', {
      title: `RBAC Event ${ts}`,
      category: 'Workshop',
      venue: 'Room 101',
      event_date: '2026-12-20',
      start_time: '09:00',
      end_time: '12:00',
      capacity: 10,
      status: 'OPEN'
    }, adminCookie);
    assert.strictEqual(evRes.status, 201);
    const evId = evRes.data.data.id;

    // Report on 0 registrations must show 0% attendance rate and 0 absent
    const emptyRep = await requestJson(baseUrl, 'GET', `/api/events/${evId}/report`, null, adminCookie);
    assert.strictEqual(emptyRep.status, 200);
    assert.strictEqual(emptyRep.data.data.summary.attendanceRate, 0);
    assert.strictEqual(emptyRep.data.data.summary.totalAbsent, 0);

    // Participant 1 self-registers
    const myReg = await requestJson(baseUrl, 'POST', '/api/my/registrations', { eventId: evId }, partCookie);
    assert.strictEqual(myReg.status, 201);
    const regId = myReg.data.data.registration.id;
    const oldToken = myReg.data.data.registration.qrToken;

    // Participant 1 can read own QR; Participant 2 gets 403
    const ownQr = await requestJson(baseUrl, 'GET', `/api/registrations/${regId}/qr`, null, partCookie);
    assert.strictEqual(ownQr.status, 200);
    const otherQr = await requestJson(baseUrl, 'GET', `/api/registrations/${regId}/qr`, null, part2Cookie);
    assert.strictEqual(otherQr.status, 403);

    // Admin reissues QR -> old token must be rejected by scanner
    const reissue = await requestJson(baseUrl, 'POST', `/api/registrations/${regId}/reissue`, {}, adminCookie);
    assert.strictEqual(reissue.status, 200);
    assert.strictEqual(reissue.data.data.token_version, 2);
    const newToken = reissue.data.data.qr_token;

    const scanOld = await requestJson(baseUrl, 'POST', '/api/attendance/scan', { eventId: evId, qrToken: oldToken }, adminCookie);
    assert.strictEqual(scanOld.status, 400);

    const scanNew = await requestJson(baseUrl, 'POST', '/api/attendance/scan', { eventId: evId, qrToken: newToken }, adminCookie);
    assert.strictEqual(scanNew.status, 200);

    // Report totals match dashboard summary
    const repData = await requestJson(baseUrl, 'GET', `/api/events/${evId}/report`, null, adminCookie);
    const dashSummary = await requestJson(baseUrl, 'GET', '/api/reports/summary', null, adminCookie);
    const evInSummary = dashSummary.data.data.events.find(e => e.id === evId);
    assert.strictEqual(evInSummary.registered, repData.data.data.summary.totalRegistered);
    assert.strictEqual(evInSummary.present, repData.data.data.summary.totalPresent);
    assert.strictEqual(evInSummary.attendanceRate, repData.data.data.summary.attendanceRate);

    // Clean up test event
    await requestJson(baseUrl, 'DELETE', `/api/events/${evId}?force=true`, null, adminCookie);
    console.log('  [PASS] Own-data isolation, QR reissue invalidation, and report/dashboard parity verified.');

    // 6. Socket.IO authentication & role-scoped broadcasts
    console.log('\n6. Socket.IO authentication & broadcast isolation...');
    const httpReqText = (url, method = 'GET', body = null, cookie = '') => new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) } : {})
        }
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

    // Unauthenticated socket handshake must be rejected on namespace connect ('40')
    const unauthHs = await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling`);
    const unauthSid = JSON.parse(unauthHs.body.replace(/^\d+/, '').replace(/^0/, '')).sid;
    await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${unauthSid}`, 'POST', '40');
    const unauthReply = await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${unauthSid}`);
    assert(unauthReply.body.includes('UNAUTHORIZED') || unauthReply.body.startsWith('44'), 'Unauthenticated socket must be rejected with 44 / UNAUTHORIZED');

    // Authenticated participant socket must connect, and must NOT receive node:status admin broadcasts
    const pHs = await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling`, 'GET', null, partCookie);
    const pSid = JSON.parse(pHs.body.replace(/^\d+/, '').replace(/^0/, '')).sid;
    await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${pSid}`, 'POST', '40', partCookie);
    const pConnAck = await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${pSid}`, 'GET', null, partCookie);
    assert(pConnAck.body.includes('40{'), 'Authenticated participant socket must connect');

    await requestJson(baseUrl, 'POST', '/api/nodes/heartbeat', { deviceId: 'test-node', role: 'SCANNER' }, adminCookie);
    // Poll briefly with timeout to ensure no node:status packet was queued for participant
    const pollRes = await Promise.race([
      httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${pSid}`, 'GET', null, partCookie),
      new Promise(r => setTimeout(() => r({ body: '' }), 200))
    ]);
    assert(!pollRes.body.includes('node:status'), 'Participant socket must NOT receive node:status admin broadcasts');
    await httpReqText(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${pSid}`, 'POST', '41', partCookie).catch(() => {});
    console.log('  [PASS] Unauthenticated socket rejected & Participant socket isolated from admin broadcasts.');

    // 7. Session expiry & Logout
    console.log('\n7. Session expiry & Logout...');
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = ?`).run(Date.now() - 1000, part2Login.data.data.user.id);
    const expiredMe = await requestJson(baseUrl, 'GET', '/api/auth/me', null, part2Cookie);
    assert.strictEqual(expiredMe.status, 401);

    await requestJson(baseUrl, 'POST', '/api/auth/logout', null, partCookie);
    const afterLogout = await requestJson(baseUrl, 'GET', '/api/auth/me', null, partCookie);
    assert.strictEqual(afterLogout.status, 401);
    console.log('  [PASS] Expired session and logged-out session both rejected with 401.');

    // 8. Migration preservation test on a temporary legacy SQLite DB
    console.log('\n8. Legacy DB migration preserves existing data...');
    const tmpDbPath = path.join(os.tmpdir(), `eventsync-mig-test-${ts}.db`);
    const legacyDb = new Database(tmpDbPath);
    legacyDb.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, venue TEXT NOT NULL, event_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('DRAFT','OPEN','CLOSED','ENDED')) DEFAULT 'DRAFT', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE participants (id TEXT PRIMARY KEY, school_id TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, email TEXT NOT NULL, department_or_course TEXT NOT NULL, year_level TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STUDENT', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE registrations (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, participant_id TEXT NOT NULL, qr_token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'REGISTERED', registered_at TEXT NOT NULL DEFAULT (datetime('now')), registered_by_node TEXT NOT NULL DEFAULT 'SYSTEM', UNIQUE(event_id, participant_id));
      CREATE TABLE attendance (id TEXT PRIMARY KEY, registration_id TEXT UNIQUE NOT NULL, event_id TEXT NOT NULL, checked_in_at TEXT NOT NULL DEFAULT (datetime('now')), scanned_by_node TEXT NOT NULL DEFAULT 'SYSTEM', client_scan_id TEXT UNIQUE NOT NULL, was_offline_sync INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE node_status (node_id TEXT PRIMARY KEY, role TEXT NOT NULL, last_seen TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'OFFLINE', ip_address TEXT DEFAULT '127.0.0.1');
      INSERT INTO events (id, title, venue, event_date, start_time, end_time, capacity, status) VALUES ('ev-1', 'Legacy Event', 'Gym', '2026-10-01', '08:00', '12:00', 50, 'OPEN');
      INSERT INTO participants (id, school_id, full_name, email, department_or_course, year_level) VALUES ('p-1', '2020-0001', 'Legacy Student', 'legacy@edu.ph', 'BSCS', '4th Year');
      INSERT INTO registrations (id, event_id, participant_id, qr_token) VALUES ('r-1', 'ev-1', 'p-1', 'tok-1');
      INSERT INTO attendance (id, registration_id, event_id, client_scan_id) VALUES ('a-1', 'r-1', 'ev-1', 'scan-1');
    `);
    legacyDb.close();

    // Run schema + migration against the temp DB using a child node process with DB_PATH=tmpDbPath
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, ['-e', `
      process.env.DB_PATH = ${JSON.stringify(tmpDbPath)};
      const { initializeDatabase, db } = require('./server/src/db/connection');
      initializeDatabase();
      const ev = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
      const p = db.prepare('SELECT COUNT(*) AS c FROM participants').get().c;
      const r = db.prepare('SELECT COUNT(*) AS c FROM registrations').get().c;
      const a = db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c;
      if (ev !== 1 || p !== 1 || r !== 1 || a !== 1) throw new Error('Data lost during migration!');
      db.prepare("INSERT INTO events (id, title, venue, event_date, start_time, end_time, capacity, status) VALUES ('ev-2', 'New', 'Hall', '2026-10-02', '09:00', '10:00', 10, 'ONGOING')").run();
      db.close();
    `], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    fs.unlinkSync(tmpDbPath);
    console.log('  [PASS] Legacy database migrated safely with 100% data preserved.');

    // 9. Station static assets, /config, /favicon.ico, and /api/attendance/live?eventId=
    console.log('\n9. Station static assets & small bug fixes...');
    const orgManifest = await httpReqText(`${baseUrl}/organizer/manifest.json`);
    assert.strictEqual(orgManifest.status, 200);
    const regManifest = await httpReqText(`${baseUrl}/registration/manifest.json`);
    assert.strictEqual(regManifest.status, 200);
    const scanManifest = await httpReqText(`${baseUrl}/scanner/manifest.json`);
    assert.strictEqual(scanManifest.status, 200);
    const cfgRes = await requestJson(baseUrl, 'GET', '/config');
    assert.strictEqual(cfgRes.status, 200);
    assert(cfgRes.data.node1Url);
    const favRes = await httpReqText(`${baseUrl}/favicon.ico`);
    assert.strictEqual(favRes.status, 200);

    // Station HTML and APIs remain protected
    const unauthOrgPage = await httpReqText(`${baseUrl}/organizer`);
    assert.strictEqual(unauthOrgPage.status, 302);
    const unauthLive = await requestJson(baseUrl, 'GET', `/api/attendance/live?eventId=${evId}`);
    assert.strictEqual(unauthLive.status, 401);
    const adminLive = await requestJson(baseUrl, 'GET', `/api/attendance/live?eventId=${evId}`, null, adminCookie);
    assert.strictEqual(adminLive.status, 200);
    assert.strictEqual(adminLive.data.ok, true);
    console.log('  [PASS] Static station assets return 200 without auth; station HTML & /api/attendance/live remain protected.');

    console.log('\n================================================================');
    console.log('   ALL AUTH, RBAC, SOCKET & MIGRATION TESTS PASSED!             ');
    console.log('================================================================\n');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

runAuthRbacTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[AUTH/RBAC TEST FAILED]', err);
    process.exit(1);
  });
