import {
  PROGRAM_SCHOOLS, ADMIN_OFFICE_SCHOOL, OTHER_SCHOOL_NAME,
  findSchool, findProgram, searchPrograms
} from '/js/shared/participant-options.js';
import { esc } from '/js/core/ui.js';

/**
 * Shared grouped & searchable BiPSU School -> Program -> Major selector.
 * Used by signup, participant profile, and admin assisted registration.
 */
export function mountProgramSelector(root, { idPrefix = 'ps', memberType = '', initial = {}, onChange } = {}) {
  let mt = memberType || '';

  root.innerHTML = `<div class="prog-sel">
    <div class="fld" id="${idPrefix}_search_wrap">
      <label for="${idPrefix}_search">Search program (optional)</label>
      <div class="prog-search-wrap">
        <input id="${idPrefix}_search" type="search" autocomplete="off" placeholder="Type e.g. comp, nursing, BSED...">
        <div class="prog-results" id="${idPrefix}_results" role="listbox" hidden></div>
      </div>
    </div>
    <div class="fld" data-f="department">
      <label for="${idPrefix}_dept" id="${idPrefix}_dept_lbl">School / College *</label>
      <select id="${idPrefix}_dept"></select>
      <div class="ferr" id="err_department" role="alert"></div>
    </div>
    <div class="fld" data-f="program" id="${idPrefix}_prog_wrap" hidden>
      <label for="${idPrefix}_prog" id="${idPrefix}_prog_lbl">Program *</label>
      <select id="${idPrefix}_prog"></select>
      <input id="${idPrefix}_other" placeholder="Type your course / department" maxlength="100" hidden style="margin-top:.4rem">
      <div class="ferr" id="err_program" role="alert"></div>
    </div>
    <div class="fld" data-f="major" id="${idPrefix}_maj_wrap" hidden>
      <label for="${idPrefix}_maj">Major *</label>
      <select id="${idPrefix}_maj"></select>
      <div class="ferr" id="err_major" role="alert"></div>
    </div>
  </div>`;

  const el = k => root.querySelector(`#${idPrefix}_${k}`);
  const deptEl = el('dept'), progEl = el('prog'), otherEl = el('other'), majEl = el('maj');
  const searchEl = el('search'), resultsEl = el('results');

  function populateSchools(keepVal = deptEl.value) {
    const isStaff = mt === 'faculty' || mt === 'staff';
    el('dept_lbl').textContent = isStaff ? 'School / Office *' : 'School / College *';
    el('search_wrap').hidden = isStaff;
    const opts = ['<option value="">Select…</option>'];
    if (isStaff) opts.push(`<option value="${esc(ADMIN_OFFICE_SCHOOL.name)}">${esc(ADMIN_OFFICE_SCHOOL.name)}</option>`);
    for (const s of PROGRAM_SCHOOLS) opts.push(`<option value="${esc(s.name)}">${esc(s.name)}</option>`);
    opts.push(`<option value="${esc(OTHER_SCHOOL_NAME)}">${esc(OTHER_SCHOOL_NAME)}</option>`);
    deptEl.innerHTML = opts.join('');
    if (keepVal && [...deptEl.options].some(o => o.value === keepVal)) deptEl.value = keepVal;
  }

  function populatePrograms(keepProg = progEl.value) {
    const dept = deptEl.value;
    const isOther = dept === OTHER_SCHOOL_NAME;
    const isStaff = mt === 'faculty' || mt === 'staff';
    const sc = findSchool(dept);

    if (isOther) {
      el('prog_wrap').hidden = false;
      el('prog_lbl').textContent = 'Course / Department *';
      progEl.hidden = true;
      otherEl.hidden = false;
      el('maj_wrap').hidden = true;
      majEl.innerHTML = '';
      return;
    }

    otherEl.hidden = true;
    progEl.hidden = false;

    if (isStaff || !sc || !sc.programs.length) {
      el('prog_wrap').hidden = true;
      progEl.innerHTML = '';
      el('maj_wrap').hidden = true;
      majEl.innerHTML = '';
      return;
    }

    el('prog_wrap').hidden = false;
    el('prog_lbl').textContent = 'Program *';
    progEl.innerHTML = '<option value="">Select…</option>' +
      sc.programs.map(p => `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.code)})</option>`).join('');
    if (keepProg && [...progEl.options].some(o => o.value === keepProg)) progEl.value = keepProg;
    populateMajors();
  }

  function populateMajors(keepMaj = majEl.value) {
    const pr = findProgram(deptEl.value, progEl.value);
    if (pr?.majors?.length) {
      el('maj_wrap').hidden = false;
      majEl.innerHTML = '<option value="">Select…</option>' + pr.majors.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      if (keepMaj && pr.majors.includes(keepMaj)) majEl.value = keepMaj;
    } else {
      el('maj_wrap').hidden = true;
      majEl.innerHTML = '';
    }
  }

  function renderSearch() {
    const q = searchEl.value.trim();
    if (!q) { resultsEl.hidden = true; resultsEl.innerHTML = ''; return; }
    const hits = searchPrograms(q);
    if (!hits.length) {
      resultsEl.innerHTML = '<div class="prog-empty">No matching programs</div>';
      resultsEl.hidden = false;
      return;
    }
    const groups = new Map();
    for (const h of hits) {
      if (!groups.has(h.school.name)) groups.set(h.school.name, []);
      groups.get(h.school.name).push(h.program);
    }
    resultsEl.innerHTML = [...groups.entries()].map(([sName, progs]) => `
      <div class="prog-grp">${esc(sName)}</div>
      ${progs.map(p => `<button type="button" class="prog-opt" role="option" data-sc="${esc(sName)}" data-pr="${esc(p.name)}">
        <span>${esc(p.name)}</span><small class="muted">${esc(p.code)}</small>
      </button>`).join('')}
    `).join('');
    resultsEl.hidden = false;
  }

  searchEl.addEventListener('input', renderSearch);
  searchEl.addEventListener('focus', () => { if (searchEl.value.trim()) renderSearch(); });
  resultsEl.addEventListener('click', ev => {
    const btn = ev.target.closest('button.prog-opt');
    if (!btn) return;
    deptEl.value = btn.dataset.sc;
    populatePrograms(btn.dataset.pr);
    searchEl.value = '';
    resultsEl.hidden = true;
    onChange?.(values());
    if (!el('maj_wrap').hidden) majEl.focus();
  });
  document.addEventListener('click', ev => {
    if (!root.contains(ev.target)) resultsEl.hidden = true;
  });

  deptEl.onchange = () => { populatePrograms(''); onChange?.(values()); };
  progEl.onchange = () => { populateMajors(''); onChange?.(values()); };
  majEl.onchange = () => onChange?.(values());
  otherEl.oninput = () => onChange?.(values());

  function values() {
    const dept = deptEl.value;
    const isOther = dept === OTHER_SCHOOL_NAME;
    const prog = isOther ? otherEl.value.trim() : (el('prog_wrap').hidden ? '' : progEl.value);
    const maj = el('maj_wrap').hidden ? '' : majEl.value;
    const pr = !isOther && prog ? findProgram(dept, prog) : null;
    const course = isOther ? prog : (pr ? pr.shortName + (maj ? ` (${maj})` : '') : dept);
    return { department: dept, program: prog, major: maj, course };
  }

  function setValues(v = {}) {
    populateSchools(v.department || '');
    populatePrograms(v.program || '');
    if (v.department === OTHER_SCHOOL_NAME) otherEl.value = v.program || v.course || '';
    populateMajors(v.major || '');
  }

  function setMemberType(nextMt) {
    mt = nextMt || '';
    const cur = values();
    populateSchools(cur.department);
    populatePrograms(cur.program);
    populateMajors(cur.major);
  }

  function showErrors(errs = {}) {
    ['department', 'program', 'major'].forEach(k => {
      const box = root.querySelector(`#err_${k}`);
      if (box) box.textContent = errs[k] || '';
    });
    deptEl.classList.toggle('bad', !!errs.department);
    progEl.classList.toggle('bad', !!errs.program);
    otherEl.classList.toggle('bad', !!errs.program && deptEl.value === OTHER_SCHOOL_NAME);
    majEl.classList.toggle('bad', !!errs.major);
    if (errs.department) return deptEl;
    if (errs.program) return deptEl.value === OTHER_SCHOOL_NAME ? otherEl : progEl;
    if (errs.major) return majEl;
    return null;
  }

  function reset() {
    searchEl.value = '';
    resultsEl.hidden = true;
    deptEl.value = '';
    otherEl.value = '';
    populateSchools('');
    populatePrograms('');
    showErrors({});
  }

  populateSchools();
  setValues(initial);

  return { setMemberType, setValues, values, showErrors, reset };
}
