const test = require('node:test');
const assert = require('node:assert');
const { normalize, parseDate, parseSalary, parseSchedule } = require('./sources/seoul');
const { buildOutput, hasAgeCap } = require('./collect');
const alio = require('./sources/alio');

const MATCHING = {
  coreKeywords: ['사업기획', '영업', '통신', 'B2B', '고문'],
  broadKeywords: ['기획', '마케팅', '홍보'],
  minWeight: 2,
};
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
const run = (...rows) => buildOutput(rows.map(normalize), MATCHING, NOW);
const fullTime = { TITLE: '영업 관리', EMP_TP_NM: '기간의 정함이 있는 근로계약', WORKDAY_WORKHR_CONT: '주 5일 근무' };

test('주 5일 계약직은 중장년 가점이 있을 때만 통과한다', () => {
  assert.equal(run(row(fullTime)).summary.filtered, 0);
  assert.equal(run(row({ ...fullTime, PF_COND: '(준)고령자(50세이상)' })).summary.filtered, 1);
  assert.equal(run(row({ ...fullTime, EMP_TP_NM: '기간의 정함이 있는 근로계약(시간(선택)제)' })).summary.filtered, 1);
});

test('다른 키워드에 포함된 키워드는 한 번만 센다', () => {
  const [job] = run(row({ TITLE: '사업기획 고문', JOBS_NM: '기획 전문가' })).jobs;
  assert.match(job.reason, /일치: 사업기획, 고문$/);
});

test('중장년 전용이면 중장년 채용 표시가 있는 공고만 남긴다', () => {
  const senior = (...rows) => buildOutput(rows.map(normalize), { ...MATCHING, seniorOnly: true }, NOW).summary.filtered;
  assert.equal(senior(row()), 0);
  assert.equal(senior(row({ PF_COND: '(준)고령자(50세이상)' })), 1);
  assert.equal(senior(row({ JOB_CONT: '신중년 경력형 일자리' })), 1);
  assert.equal(senior(row({ JOB_CONT: '55세 이상 지원 가능' })), 1);
  assert.equal(senior(row({ JOB_CONT: '청장년 누구나' })), 0);
  assert.equal(senior(row({ JOB_CONT: '경력 10년 이상' })), 0);
});

test('HTML 엔티티를 원래 문자로 돌린다', () => {
  assert.equal(normalize(row({ TITLE: '강남구청 &amp; 고용센터' })).title, '강남구청 & 고용센터');
});

const alioRow = (over = {}) => ({
  recrutPblntSn: 1001,
  instNm: '가상진흥원',
  hireTypeNmLst: '비정규직',
  workRgnNmLst: '서울',
  recrutSeNm: '경력',
  pbancBgngYmd: '20261109',
  pbancEndYmd: '20261125',
  recrutPbancTtl: '사업기획 전문위원 채용',
  aplyQlfcCn: '관련 경력 10년 이상',
  prefCn: '',
  prefCondCn: '',
  ...over,
});
const runMixed = (seoulRows, alioRows) => buildOutput(
  [...seoulRows.map(normalize), ...alioRows.map(alio.normalize)],
  { ...MATCHING, seniorOnly: true },
  NOW,
);

test('알리오는 중장년 표시 없이 경력직·비정규·핵심 키워드로 통과한다', () => {
  const out = runMixed([], [alioRow()]);
  assert.equal(out.summary.matched, 1);
  assert.equal(out.jobs[0].url, 'https://job.alio.go.kr/recruitview.do?idx=1001');
  assert.equal(out.jobs[0].deadline, '2026-11-25');
  assert.match(out.jobs[0].reason, /공공기관 비정규 경력 채용/);
});

test('알리오의 신입·정규직·인턴·일용직·넓은 키워드만 일치는 제외한다', () => {
  const matched = (over) => runMixed([], [alioRow(over)]).summary.matched;
  assert.equal(matched({ recrutSeNm: '신입' }), 0);
  assert.equal(matched({ hireTypeNmLst: '정규직' }), 0);
  assert.equal(matched({ recrutPbancTtl: '사업기획 인턴 채용' }), 0);
  assert.equal(matched({ recrutPbancTtl: '통신 설비 일용근로자 모집' }), 0);
  assert.equal(matched({ recrutPbancTtl: '마케팅 홍보 계약직 채용' }), 0);
});

test('알리오의 경기 공고는 고양 언급이 있을 때만 통과한다', () => {
  const matched = (over) => runMixed([], [alioRow({ workRgnNmLst: '경기', ...over })]).summary.matched;
  assert.equal(matched({}), 0);
  assert.equal(matched({ aplyQlfcCn: '근무지: 고양시 덕양구' }), 1);
});

test('넓은 키워드 하나만 있으면 채점 대상이 아니다', () => {
  assert.equal(run(row({ TITLE: '홍보 담당 시간제', JOBS_NM: '사무원' })).summary.matched, 0);
  assert.equal(run(row({ TITLE: '마케팅 홍보 시간제', JOBS_NM: '사무원' })).summary.matched, 1);
});

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
