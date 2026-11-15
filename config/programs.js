// Single source of truth for BiPSU Main Campus Schools, Programs, and Majors.
// Shared by browser forms, validation, reports, and Node tests.

export const OTHER_SCHOOL_CODE = 'OTHER';
export const OTHER_SCHOOL_NAME = 'Other / Not listed';
export const ADMIN_OFFICE_SCHOOL = { code: 'ADMIN_OFFICE', name: 'Administrative / Office', programs: [] };
export const NEEDS_UPDATE_LABEL = 'Needs update';

export const PROGRAM_SCHOOLS = [
  {
    code: 'SCJE',
    name: 'School of Criminal Justice Education',
    programs: [
      { code: 'BSCRIM', name: 'Bachelor of Science in Criminology', shortName: 'BS Criminology' }
    ]
  },
  {
    code: 'STE',
    name: 'School of Teacher Education',
    programs: [
      { code: 'BECED', name: 'Bachelor of Early Childhood Education', shortName: 'B Early Childhood Education' },
      { code: 'BEED', name: 'Bachelor of Elementary Education', shortName: 'B Elementary Education' },
      { code: 'BPED', name: 'Bachelor of Physical Education', shortName: 'B Physical Education' },
      {
        code: 'BSED',
        name: 'Bachelor in Secondary Education',
        shortName: 'B Secondary Education',
        majors: ['English', 'Filipino', 'Math', 'Science', 'Social Studies']
      },
      { code: 'BSNED', name: 'Bachelor of Special Needs Education', shortName: 'B Special Needs Education' },
      { code: 'BTLED', name: 'Bachelor of Technology and Livelihood Education', shortName: 'B Technology & Livelihood Education' }
    ]
  },
  {
    code: 'SNHS',
    name: 'School of Nursing and Health Sciences',
    programs: [
      { code: 'BSN', name: 'Bachelor of Science in Nursing', shortName: 'BS Nursing' }
    ]
  },
  {
    code: 'SOE',
    name: 'School of Engineering',
    programs: [
      { code: 'BSCE', name: 'Bachelor of Science in Civil Engineering', shortName: 'BS Civil Engineering' },
      { code: 'BSEE', name: 'Bachelor of Science in Electrical Engineering', shortName: 'BS Electrical Engineering' },
      { code: 'BSME', name: 'Bachelor of Science in Mechanical Engineering', shortName: 'BS Mechanical Engineering' },
      { code: 'BSCPE', name: 'Bachelor of Science in Computer Engineering', shortName: 'BS Computer Engineering' }
    ]
  },
  {
    code: 'SAS',
    name: 'School of Arts and Sciences',
    programs: [
      { code: 'BACA', name: 'Bachelor of Arts, Major in Communication Arts', shortName: 'BA Communication Arts' },
      { code: 'BAECON', name: 'Bachelor of Arts, Major in Economics', shortName: 'BA Economics' },
      {
        code: 'BSBA',
        name: 'Bachelor of Science in Business Administration',
        shortName: 'BS Business Administration',
        majors: ['Financial Management', 'Marketing Management']
      }
    ]
  },
  {
    code: 'SME',
    name: 'School of Management and Entrepreneurship',
    programs: [
      { code: 'BSHM', name: 'Bachelor of Science in Hospitality Management', shortName: 'BS Hospitality Management' },
      { code: 'BSTM', name: 'Bachelor of Science in Tourism Management', shortName: 'BS Tourism Management' }
    ]
  },
  {
    code: 'STCS',
    name: 'School of Technology and Computer Studies',
    programs: [
      { code: 'BSCS', name: 'Bachelor of Science in Computer Science', shortName: 'BS Computer Science' },
      { code: 'BSIS', name: 'Bachelor of Science in Information Systems', shortName: 'BS Information Systems' },
      {
        code: 'BSIT',
        name: 'Bachelor of Science in Industrial Technology',
        shortName: 'BS Industrial Technology',
        majors: [
          'Automotive Technology',
          'Cosmetology',
          'Drafting',
          'Electricity',
          'Electronics',
          'Foods',
          'Garments',
          'Handicraft',
          'Machine Shop/Metal Fabrication',
          'RAC Technology'
        ]
      }
    ]
  }
];

const ORD = { 1: '1st Year', 2: '2nd Year', 3: '3rd Year', 4: '4th Year' };

export function findSchool(nameOrCode) {
  const q = String(nameOrCode ?? '').trim();
  if (!q) return null;
  if (q === ADMIN_OFFICE_SCHOOL.code || q === ADMIN_OFFICE_SCHOOL.name) return ADMIN_OFFICE_SCHOOL;
  return PROGRAM_SCHOOLS.find(s => s.name === q || s.code === q) || null;
}

export function findProgram(schoolNameOrCode, programNameOrCode) {
  const s = findSchool(schoolNameOrCode);
  const q = String(programNameOrCode ?? '').trim();
  if (!q) return null;
  if (s) return s.programs.find(p => p.name === q || p.code === q || p.shortName === q) || null;
  for (const sc of PROGRAM_SCHOOLS) {
    const p = sc.programs.find(x => x.name === q || x.code === q || x.shortName === q);
    if (p) return p;
  }
  return null;
}

export function findSchoolForProgram(programNameOrCode) {
  const q = String(programNameOrCode ?? '').trim();
  if (!q) return null;
  return PROGRAM_SCHOOLS.find(s => s.programs.some(p => p.name === q || p.code === q || p.shortName === q)) || null;
}

export function searchPrograms(query) {
  const q = String(query ?? '').trim().toLowerCase();
  const out = [];
  for (const s of PROGRAM_SCHOOLS) {
    for (const p of s.programs) {
      const hay = `${s.name} ${s.code} ${p.name} ${p.shortName} ${p.code} ${(p.majors || []).join(' ')}`.toLowerCase();
      if (!q || hay.includes(q)) out.push({ school: s, program: p });
    }
  }
  return out;
}

/** Validate school/department, program, and major against the official catalog. */
export function validateProgramSelection({ member_type, department, program, major, course }) {
  const s = v => String(v ?? '').trim();
  const mt = s(member_type);
  const dept = s(department);
  const prog = s(program);
  const maj = s(major);
  const crs = s(course);

  if (dept === OTHER_SCHOOL_NAME || dept === OTHER_SCHOOL_CODE) {
    const custom = prog || crs;
    if (!custom) return { error: 'Please specify your course / department', field: 'program' };
    if (custom.length > 100) return { error: 'Course / Department is too long', field: 'program' };
    if (maj) return { error: 'Major is not applicable for Other', field: 'major' };
    return { department: OTHER_SCHOOL_NAME, program: custom, major: null, course: custom };
  }

  if (mt === 'faculty' || mt === 'staff') {
    if (!dept) return { error: 'School / Office is required', field: 'department' };
    const sc = findSchool(dept);
    if (!sc) return { error: 'Select a valid School / Office', field: 'department' };
    if (maj) return { error: 'Major is not applicable for Faculty / Staff', field: 'major' };
    return { department: sc.name, program: null, major: null, course: sc.name };
  }

  if (!dept) return { error: 'School / College is required', field: 'department' };
  const sc = findSchool(dept);
  if (!sc || sc.code === ADMIN_OFFICE_SCHOOL.code) {
    return { error: 'Select a valid School / College', field: 'department' };
  }
  if (!prog) return { error: 'Program is required', field: 'program' };
  const pr = sc.programs.find(p => p.name === prog || p.code === prog || p.shortName === prog);
  if (!pr) return { error: 'Select a valid Program for this school', field: 'program' };

  const hasMajors = Array.isArray(pr.majors) && pr.majors.length > 0;
  if (hasMajors) {
    if (!maj || !pr.majors.includes(maj)) {
      return { error: 'Select a valid Major for this program', field: 'major' };
    }
  } else if (maj) {
    return { error: 'This program does not have majors', field: 'major' };
  }

  const shortCourse = pr.shortName + (maj ? ` (${maj})` : '');
  return { department: sc.name, program: pr.name, major: maj || null, course: shortCourse };
}

/** Short display label for tables, cards, and exports (e.g. "BS Computer Science - 3rd Year"). */
export function formatProgramShort(u) {
  if (!u) return '-';
  if (u.program_needs_update) return NEEDS_UPDATE_LABEL;
  const pr = u.program ? findProgram(u.department, u.program) : null;
  let base = pr ? pr.shortName : (u.program || u.course || u.department || '');
  if (!base) return '-';
  if (u.major && !base.includes(`(${u.major})`)) base += ` (${u.major})`;
  if (u.member_type === 'student' && u.year_level) {
    return `${base} - ${ORD[u.year_level] || `${u.year_level}th Year`}`;
  }
  return base;
}

/** Full official display label for tooltips and detail panels. */
export function formatProgramFull(u) {
  if (!u) return '-';
  if (u.program_needs_update) return `${NEEDS_UPDATE_LABEL}${u.course && u.course !== NEEDS_UPDATE_LABEL ? ` (${u.course})` : ''}`;
  const parts = [];
  if (u.program) parts.push(u.program + (u.major ? ` — Major in ${u.major}` : ''));
  else if (u.course) parts.push(u.course);
  if (u.department && u.department !== parts[0]) parts.push(u.department);
  if (u.member_type === 'student' && u.year_level) parts.push(ORD[u.year_level] || `${u.year_level}th Year`);
  return parts.join(' · ') || '-';
}
