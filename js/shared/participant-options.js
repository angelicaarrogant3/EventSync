// ONE place for member types, year levels, and BiPSU program choices (from config/programs.js).
export {
  PROGRAM_SCHOOLS,
  ADMIN_OFFICE_SCHOOL,
  OTHER_SCHOOL_CODE,
  OTHER_SCHOOL_NAME,
  NEEDS_UPDATE_LABEL,
  findSchool,
  findProgram,
  findSchoolForProgram,
  searchPrograms,
  validateProgramSelection,
  formatProgramShort,
  formatProgramFull
} from '../../config/programs.js';

export const MEMBER_TYPES = [
  { value: 'student', label: 'Student' },
  { value: 'faculty', label: 'Faculty' },
  { value: 'staff',   label: 'Staff' }
];

export const YEAR_LEVELS = [
  { value: 1, label: '1st year' }, { value: 2, label: '2nd year' },
  { value: 3, label: '3rd year' }, { value: 4, label: '4th year' }
];

export const PRIVACY_TEXT = 'I agree that my information will be used for event registration and attendance.';
export const MIN_PASSWORD = 8;
