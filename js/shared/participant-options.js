// ONE place to edit the dropdown choices used by the sign-up form, the profile page and the admin form.
export const MEMBER_TYPES = [
  { value: 'student', label: 'Student' },
  { value: 'faculty', label: 'Faculty' },
  { value: 'staff',   label: 'Staff' }
];

// Add / remove / rename courses here. "Other" shows a free-text box.
export const COURSES = ['BSIT', 'BSCS', 'BSBA', 'BSED', 'BEED', 'Engineering', 'Nursing'];
export const OTHER_COURSE = 'Other';

export const YEAR_LEVELS = [
  { value: 1, label: '1st year' }, { value: 2, label: '2nd year' },
  { value: 3, label: '3rd year' }, { value: 4, label: '4th year' }
];

export const PRIVACY_TEXT = 'I agree that my information will be used for event registration and attendance.';
export const MIN_PASSWORD = 8;
