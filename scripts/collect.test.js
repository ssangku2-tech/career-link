const test = require('node:test');
const assert = require('node:assert');
const { normalize, parseDate, parseSalary, parseSchedule } = require('./sources/seoul');
const { buildOutput, hasAgeCap } = require('./collect');

const KEYWORDS = ['영업', '기획', '통신'];
const NOW = new Date('2026-11-10T00:00:00+09:00');

const row = (over = {}) => ({
  COMPANY: '가상기업',
  TITLE: 'B2B 영업 고문',
  CAREER: '경력',
  REG_DT: '26-11-09',
  CLOSE_DT: '26-11-20',
  REGION: '서울 마포구',
  JOBS_NM: '영업 관리자',
  JOB_CONT: '거래처 관리',
  EMP_TP_NM: '기간의 정함이 있는 근로계약',
  SAL_TP_NM: '월급2,000,000원 이상,',
  SAL_TP_CD: 'M',
  PF_COND: '',
  SUBMIT_DOC: '이력서',
  WORK_REGION: '(04100)  서울특별시 마포구 가상로 1',
  WORKDAY_WORKHR_CONT: '평일 : (근무시간) (오전) 9시 00분 ~ (오후) 6시 00분, 주 3일 근무',
  FOUR_INS: '국민연금 고용보험 산재보험 의료보험',
  EMP_CHARGER_DPT: '담당자명',
  CONTACT_TELNO: '02-000-0000',
  ...over,
});
const run = (...rows) => buildOutput(rows.map(normalize), KEYWORDS, NOW);

test('마감일 형식을 해석한다', () => {
  assert.equal(parseDate('26-11-13'), '2026-11-13');
  assert.equal(parseDate('채용시까지  26-11-15'), '2026-11-15');
  assert.equal(parseDate('채용시까지'), null);
});

test('오전·오후와 정오를 24시간으로 바꾼다', () => {
  assert.equal(parseSchedule('(오전) 8시 30분 ~ (오후) 6시 00분', '').workHours, '08:30~18:00');
  assert.equal(parseSchedule('(오후) 12시 00분 ~ (오후) 5시 00분', '').workHours, '12:00~17:00');
});

test('임금을 월로 환산하고 근무량을 모르면 null로 둔다', () => {
  const week = parseSchedule('(오후) 1시 00분 ~ (오후) 5시 00분, 주 5일 근무', '');
  assert.equal(parseSalary('시급13,400원 이상,', 'H', week).salaryMonthly, 1164000);
  assert.equal(parseSalary('시급13,400원 이상,', 'H', parseSchedule('', '')).salaryMonthly, null);
  assert.equal(parseSalary('연봉36,000,000원 이상', 'Y', week).salaryMonthly, 3000000);
  assert.deepEqual(parseSalary('', 'M', week), { salaryText: '협의', salaryMonthly: null });
});

test('나이 상한은 제외하되 미성년자 문구와 하한은 통과시킨다', () => {
  assert.equal(hasAgeCap('만 39세 이하 지원 가능'), true);
  assert.equal(hasAgeCap('18세 미만 지원 불가'), false);
  assert.equal(hasAgeCap('(준)고령자(50세이상)'), false);
});

test('지역·마감·신입·근무형태로 거른다', () => {
  assert.equal(run(row()).summary.matched, 1);
  assert.equal(run(row({ REGION: '경기 고양시' })).summary.matched, 1);
  assert.equal(run(row({ REGION: '경기 남양주시' })).summary.matched, 0);
  assert.equal(run(row({ CLOSE_DT: '26-11-09' })).summary.matched, 0);
  assert.equal(run(row({ CAREER: '신입' })).summary.matched, 0);
  assert.equal(run(row({
    TITLE: '영업 직원',
    EMP_TP_NM: '기간의 정함이 없는 근로계약',
    WORKDAY_WORKHR_CONT: '주 5일 근무',
  })).summary.matched, 0);
});

test('재택 불가 문구만으로는 유연근무로 보지 않는다', () => {
  assert.equal(run(row({
    TITLE: '영업 직원',
    EMP_TP_NM: '기간의 정함이 없는 근로계약',
    WORKDAY_WORKHR_CONT: '주 5일 근무',
    JOB_CONT: '재택근무 불가',
  })).summary.matched, 0);
});

test('같은 기관·제목·마감일은 한 건으로 합친다', () => {
  assert.equal(run(row(), row()).summary.matched, 1);
});

test('직무 키워드가 없거나 표현만 겹치면 추천하지 않는다', () => {
  assert.equal(run(row({ TITLE: '요양보호사', JOBS_NM: '요양보호사' })).jobs.length, 0);
  assert.equal(run(row({ TITLE: '영업시간 안내 시간제', JOBS_NM: '안내원' })).jobs.length, 0);
});

test('가점이 많은 공고를 먼저 추천한다', () => {
  const { jobs } = run(
    row({ TITLE: 'A 영업 고문' }),
    row({ TITLE: 'B 영업 고문', PF_COND: '(준)고령자(50세이상)' }),
  );
  assert.match(jobs[0].title, /^B/);
  assert.match(jobs[0].reason, /고령자 우대/);
});

test('담당자 정보와 내부 필드는 결과에 남지 않는다', () => {
  const text = JSON.stringify(run(row()));
  assert.ok(!text.includes('담당자명'));
  assert.ok(!text.includes('02-000-0000'));
  assert.ok(!text.includes('_filter'));
});
