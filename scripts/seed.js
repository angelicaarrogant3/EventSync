const readline = require('readline');

const { v4: uuidv4 } = require('uuid');

require('../server/src/config');
const { query, initializeDatabase, closeDatabase } = require('../server/src/db/connection');
const { generateSignedQrToken } = require('../server/src/utils/crypto');
const { createAdministrator, signupParticipant } = require('../server/src/services/auth.service');

const isDemo = process.argv.includes('--demo');
const autoConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

async function confirmWipe() {
  if (autoConfirm || !process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('This will wipe existing events, participants, registrations, and attendance data. Continue? (y/N): ', ans => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
  return answer === 'y' || answer === 'yes';
}

async function runSeed() {
  const ok = await confirmWipe();
  if (!ok) {
    console.log('[Seed] Cancelled.');
    process.exit(0);
  }

  console.log('[Seed] Initializing database schema...');
  await initializeDatabase();

  // Clear existing tables for a clean seed
  console.log('[Seed] Clearing existing tables...');
  await query.transaction(async (tx) => {
    await tx.run('DELETE FROM activity_logs');
    await tx.run('DELETE FROM audit_log');
    await tx.run('DELETE FROM attendance');
    await tx.run('DELETE FROM registrations');
    await tx.run('DELETE FROM participants');
    await tx.run('DELETE FROM events');
    if (isDemo) {
      await tx.run('DELETE FROM sessions');
      await tx.run('DELETE FROM users');
    }
  });

  // 1. Seed Events
  console.log('[Seed] Inserting 3 university events...');

const event1Id = 'e1111111-1111-4111-a111-111111111111';
const event2Id = 'e2222222-2222-4222-a222-222222222222';
const event3Id = 'e3333333-3333-4333-a333-333333333333';

const events = [
  {
    id: event1Id,
    title: 'CS & IT Tech Summit 2026: Distributed Systems & Cloud Innovations',
    description: 'Annual flagship symposium showcasing undergraduate research in parallel architectures, fault tolerance, and consensus protocols.',
    venue: 'University Grand Auditorium',
    event_date: '2026-11-15',
    start_time: '08:30',
    end_time: '16:30',
    capacity: 45,
    status: 'OPEN'
  },
  {
    id: event2Id,
    title: 'College of Engineering & Computing Industry Career Fair',
    description: 'On-campus recruitment and networking event with over 30 leading software and engineering partners.',
    venue: 'University Gymnasium Hall A',
    event_date: '2026-11-16',
    start_time: '13:00',
    end_time: '17:30',
    capacity: 35,
    status: 'OPEN'
  },
  {
    id: event3Id,
    title: 'Faculty Research & Academic Development Assembly',
    description: 'Strategic planning and peer review of inter-departmental STEM research proposals for the upcoming academic cycle.',
    venue: 'AVR 1, Engineering Complex',
    event_date: '2026-11-20',
    start_time: '09:00',
    end_time: '12:00',
    capacity: 20,
    status: 'DRAFT'
  }
];

for (const ev of events) {
  await query.run(
    `INSERT INTO events (id, title, description, venue, event_date, start_time, end_time, capacity, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ev.id, ev.title, ev.description, ev.venue, ev.event_date, ev.start_time, ev.end_time, ev.capacity, ev.status]
  );
}

// 2. Seed 40 Participants
console.log('[Seed] Generating 40 realistic student, faculty, and staff profiles...');

const rawParticipants = [
  // Students (BSCS)
  { school_id: '2023-10001', full_name: 'Sophia Nicole Ramirez', email: 'sophia.ramirez@university.edu', department_or_course: 'BS Computer Science', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10002', full_name: 'Liam Gabriel Santos', email: 'liam.santos@university.edu', department_or_course: 'BS Computer Science', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10003', full_name: 'Ethan Lucas Fernandez', email: 'ethan.fernandez@university.edu', department_or_course: 'BS Computer Science', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10004', full_name: 'Alyssa Marie Cruz', email: 'alyssa.cruz@university.edu', department_or_course: 'BS Computer Science', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10005', full_name: 'Marcus Andrei Reyes', email: 'marcus.reyes@university.edu', department_or_course: 'BS Computer Science', year_level: '2nd Year', role: 'STUDENT' },
  { school_id: '2023-10006', full_name: 'Chloe Isabella Villanueva', email: 'chloe.villanueva@university.edu', department_or_course: 'BS Computer Science', year_level: '2nd Year', role: 'STUDENT' },
  { school_id: '2023-10007', full_name: 'Daniel Joshua Bautista', email: 'daniel.bautista@university.edu', department_or_course: 'BS Computer Science', year_level: '1st Year', role: 'STUDENT' },
  { school_id: '2023-10008', full_name: 'Samantha Grace Tan', email: 'samantha.tan@university.edu', department_or_course: 'BS Computer Science', year_level: '1st Year', role: 'STUDENT' },

  // Students (BSIT)
  { school_id: '2023-10009', full_name: 'Alexander Kyle Ramos', email: 'kyle.ramos@university.edu', department_or_course: 'BS Information Technology', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10010', full_name: 'Beatriz Angela Lopez', email: 'beatriz.lopez@university.edu', department_or_course: 'BS Information Technology', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10011', full_name: 'Christian Dave Garcia', email: 'christian.garcia@university.edu', department_or_course: 'BS Information Technology', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10012', full_name: 'Hannah Mae Castor', email: 'hannah.castor@university.edu', department_or_course: 'BS Information Technology', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10013', full_name: 'Justin Carl Mendoza', email: 'justin.mendoza@university.edu', department_or_course: 'BS Information Technology', year_level: '2nd Year', role: 'STUDENT' },
  { school_id: '2023-10014', full_name: 'Kayla Denise Aquino', email: 'kayla.aquino@university.edu', department_or_course: 'BS Information Technology', year_level: '2nd Year', role: 'STUDENT' },
  { school_id: '2023-10015', full_name: 'Patrick Noel Flores', email: 'patrick.flores@university.edu', department_or_course: 'BS Information Technology', year_level: '1st Year', role: 'STUDENT' },
  { school_id: '2023-10016', full_name: 'Patricia Louise Salazar', email: 'patricia.salazar@university.edu', department_or_course: 'BS Information Technology', year_level: '1st Year', role: 'STUDENT' },

  // Students (BS Computer Engineering)
  { school_id: '2023-10017', full_name: 'Matthew James Dela Cruz', email: 'matthew.delacruz@university.edu', department_or_course: 'BS Computer Engineering', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10018', full_name: 'Jasmine Rose Ocampo', email: 'jasmine.ocampo@university.edu', department_or_course: 'BS Computer Engineering', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10019', full_name: 'Joshua Philip Rivera', email: 'joshua.rivera@university.edu', department_or_course: 'BS Computer Engineering', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10020', full_name: 'Erica Nicole Morales', email: 'erica.morales@university.edu', department_or_course: 'BS Computer Engineering', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10021', full_name: 'Adrian Paul Navarro', email: 'adrian.navarro@university.edu', department_or_course: 'BS Computer Engineering', year_level: '2nd Year', role: 'STUDENT' },
  { school_id: '2023-10022', full_name: 'Mia Angela Castillo', email: 'mia.castillo@university.edu', department_or_course: 'BS Computer Engineering', year_level: '2nd Year', role: 'STUDENT' },

  // Students (BS Electronics Engineering)
  { school_id: '2023-10023', full_name: 'Vincent Paul Mercado', email: 'vincent.mercado@university.edu', department_or_course: 'BS Electronics Engineering', year_level: '4th Year', role: 'STUDENT' },
  { school_id: '2023-10024', full_name: 'Camille Joy Domingo', email: 'camille.domingo@university.edu', department_or_course: 'BS Electronics Engineering', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10025', full_name: 'Francis Kevin Tolentino', email: 'francis.tolentino@university.edu', department_or_course: 'BS Electronics Engineering', year_level: '2nd Year', role: 'STUDENT' },

  // Students (BS Information Systems)
  { school_id: '2023-10026', full_name: 'Rachel Ann Valenzuela', email: 'rachel.valenzuela@university.edu', department_or_course: 'BS Information Systems', year_level: '3rd Year', role: 'STUDENT' },
  { school_id: '2023-10027', full_name: 'Kenneth Ray Gutierrez', email: 'kenneth.gutierrez@university.edu', department_or_course: 'BS Information Systems', year_level: '2nd Year', role: 'STUDENT' },
  { school_id: '2023-10028', full_name: 'Angelica Marie Cortez', email: 'angelica.cortez@university.edu', department_or_course: 'BS Information Systems', year_level: '1st Year', role: 'STUDENT' },

  // Faculty Members
  { school_id: '2023-FAC01', full_name: 'Dr. Raymond E. Valderrama', email: 'raymond.valderrama@university.edu', department_or_course: 'Dept of Computer Science', year_level: 'Professor', role: 'FACULTY' },
  { school_id: '2023-FAC02', full_name: 'Engr. Christine Joy Panganiban', email: 'christine.panganiban@university.edu', department_or_course: 'Dept of Computer Engineering', year_level: 'Associate Professor', role: 'FACULTY' },
  { school_id: '2023-FAC03', full_name: 'Prof. Mark Joseph Alcantara', email: 'mark.alcantara@university.edu', department_or_course: 'Dept of Information Technology', year_level: 'Assistant Professor', role: 'FACULTY' },
  { school_id: '2023-FAC04', full_name: 'Dr. Maricel B. Santos', email: 'maricel.santos@university.edu', department_or_course: 'Dept of Electronics Engineering', year_level: 'Department Chair', role: 'FACULTY' },
  { school_id: '2023-FAC05', full_name: 'Prof. Leonardo T. Pascual', email: 'leonardo.pascual@university.edu', department_or_course: 'Dept of Computer Science', year_level: 'Lecturer', role: 'FACULTY' },
  { school_id: '2023-FAC06', full_name: 'Engr. Dianne Michelle Romero', email: 'dianne.romero@university.edu', department_or_course: 'Dept of Information Technology', year_level: 'Instructor', role: 'FACULTY' },

  // Staff Members
  { school_id: '2023-STF01', full_name: 'Bernardo C. Macaraeg', email: 'bernardo.macaraeg@university.edu', department_or_course: 'College Registrar Office', year_level: 'Staff', role: 'STAFF' },
  { school_id: '2023-STF02', full_name: 'Teresa L. Guinto', email: 'teresa.guinto@university.edu', department_or_course: 'Office of Student Affairs', year_level: 'Staff', role: 'STAFF' },
  { school_id: '2023-STF03', full_name: 'Rodolfo M. Silverio', email: 'rodolfo.silverio@university.edu', department_or_course: 'IT Infrastructure & Operations', year_level: 'Staff', role: 'STAFF' },
  { school_id: '2023-STF04', full_name: 'Lorena S. Manaloto', email: 'lorena.manaloto@university.edu', department_or_course: 'Audio-Visual Services', year_level: 'Staff', role: 'STAFF' },
  { school_id: '2023-STF05', full_name: 'Melvin G. Dimaculangan', email: 'melvin.dimaculangan@university.edu', department_or_course: 'Campus Security & Facilities', year_level: 'Staff', role: 'STAFF' },
  { school_id: '2023-STF06', full_name: 'Glenda R. Evangelista', email: 'glenda.evangelista@university.edu', department_or_course: 'Dean Office Administration', year_level: 'Staff', role: 'STAFF' }
];

const participantMap = new Map();
for (const p of rawParticipants) {
  const pId = uuidv4();
  await query.run(
    `INSERT INTO participants (id, school_id, full_name, email, department_or_course, year_level, role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [pId, p.school_id, p.full_name, p.email, p.department_or_course, p.year_level, p.role]
  );
  participantMap.set(p.school_id, { id: pId, ...p });
}

// 3. Seed Registrations for Event 1 (25 participants)
console.log('[Seed] Seeding 25 registrations for Event 1...');

const event1Participants = rawParticipants.slice(0, 25);
const event1Registrations = [];

for (let i = 0; i < event1Participants.length; i++) {
  const p = participantMap.get(event1Participants[i].school_id);
  const regId = uuidv4();
  const qrToken = generateSignedQrToken(regId, event1Id);

  // Staggered registration timestamps
  const regMinutesAgo = 60 - i * 2;
  const regTime = new Date(Date.now() - regMinutesAgo * 60000).toISOString().replace('T', ' ').substring(0, 19);

  await query.run(
    `INSERT INTO registrations (id, event_id, participant_id, qr_token, status, registered_at, registered_by_node)
     VALUES (?, ?, ?, ?, 'REGISTERED', ?, 'node-2')`,
    [regId, event1Id, p.id, qrToken, regTime]
  );

  event1Registrations.push({
    regId,
    schoolId: p.school_id,
    fullName: p.full_name,
    qrToken
  });

  // Check in the first 14 participants to show live attendance activity
  if (i < 14) {
    const attMinutesAgo = 40 - i * 2;
    const attTime = new Date(Date.now() - attMinutesAgo * 60000).toISOString().replace('T', ' ').substring(0, 19);
    const clientScanId = uuidv4();
    const wasOffline = (i % 5 === 0) ? 1 : 0; // demonstrate offline sync flag

    await query.run(
      `INSERT INTO attendance (id, registration_id, event_id, checked_in_at, scanned_by_node, client_scan_id, was_offline_sync)
       VALUES (?, ?, ?, ?, 'node-3', ?, ?)`,
      [uuidv4(), regId, event1Id, attTime, clientScanId, wasOffline]
    );
  }
}

// 4. Seed Registrations for Event 2 (10 participants)
console.log('[Seed] Seeding 10 registrations for Event 2...');
const event2Participants = rawParticipants.slice(15, 25);
for (let i = 0; i < event2Participants.length; i++) {
  const p = participantMap.get(event2Participants[i].school_id);
  const regId = uuidv4();
  const qrToken = generateSignedQrToken(regId, event2Id);

  await query.run(
    `INSERT INTO registrations (id, event_id, participant_id, qr_token, status, registered_at, registered_by_node)
     VALUES (?, ?, ?, ?, 'REGISTERED', ?, 'node-2')`,
    [regId, event2Id, p.id, qrToken, new Date(Date.now() - (120 - i * 5) * 60000).toISOString().replace('T', ' ').substring(0, 19)]
  );
}

if (isDemo) {
  const demoAdminPass = process.env.DEMO_ADMIN_PASSWORD || 'DemoAdmin123!';
  const demoPartPass = process.env.DEMO_PARTICIPANT_PASSWORD || 'DemoUser123!';

  await createAdministrator({
    full_name: 'Demo Administrator',
    username: 'demoadmin',
    email: 'demoadmin@eventsync.local',
    password: demoAdminPass
  });

  await signupParticipant({
    full_name: 'Demo Participant',
    username: 'demouser',
    email: 'demouser@eventsync.local',
    password: demoPartPass,
    confirm_password: demoPartPass,
    contact_number: '09170000000',
    school_id: '2026-99999',
    department_or_course: 'BS Computer Science',
    year_level: '4th Year',
    participant_type: 'STUDENT'
  });

  console.log('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log('  WARNING: DEMO ACCOUNTS CREATED WITH DEFAULT PASSWORDS!');
  console.log('  Change these passwords immediately before any real deployment:');
  console.log(`    Admin:       demoadmin / ${demoAdminPass}`);
  console.log(`    Participant: demouser  / ${demoPartPass}`);
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
}

console.log('\n================================================================');
console.log('   SEED COMPLETED SUCCESSFULLY!                                 ');
console.log('================================================================');
console.log(`- Events created:        3 (2 OPEN, 1 DRAFT)`);
console.log(`- Participants created:  40 (across 6 departments)`);
console.log(`- Event 1 Registrations: 25 / 45 capacity`);
console.log(`- Event 1 Checked-In:    14 (with realistic check-in timeline & offline sync flag)`);
console.log(`- Event 2 Registrations: 10 / 35 capacity`);
console.log('\nSample Student for instant demo testing:');
console.log(`- School ID:  ${event1Registrations[0].schoolId}`);
console.log(`- Full Name:  ${event1Registrations[0].fullName}`);
console.log(`- Event:      CS & IT Tech Summit 2026`);
console.log('================================================================\n');

await closeDatabase();
}

runSeed().catch(err => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});
