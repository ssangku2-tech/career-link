// 서울 열린데이터광장 OA-23047 "서울시 일자리포털 채용정보" (서비스명 recMntList)
// 담당 부서·전화번호(EMP_CHARGER_DPT, CONTACT_TELNO)는 공개 리포에 올리지 않도록 읽지 않는다.
const crypto = require('crypto');

const BASE = 'http://openapi.seoul.go.kr:8088';
const SERVICE = 'recMntList';
const PAGE_SIZE = 1000;
const SAMPLE_LIMIT = 5; // 샘플 키는 한 번에 5건까지만 허용된다
const RETRIES = 3;
const WEEKS_PER_MONTH = 4.345;
const WORK24_SEARCH = 'https://www.work24.go.kr/wk/a/b/1200/retriveDtlEmpSrchList.do';

async function fetchPage(key, start, end) {
  const url = `${BASE}/${encodeURIComponent(key)}/json/${SERVICE}/${start}/${end}/`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // 인증키 오류 같은 일부 응답은 json을 요청해도 XML로 온다
      if (text.trimStart().startsWith('<')) {
        const tag = (name) => text.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim() ?? '';
        const error = new Error(`${tag('CODE') || '알 수 없는 응답'}: ${tag('MESSAGE').split('\n')[0]}`);
        error.fatal = /^INFO-100|^ERROR-3/.test(tag('CODE'));
        throw error;
      }
      const body = JSON.parse(text);
      const data = body[SERVICE] || body;
      const code = data.RESULT?.CODE;
      if (code === 'INFO-200') return { total: 0, rows: [] };
      if (code !== 'INFO-000') throw new Error(`${code}: ${data.RESULT?.MESSAGE}`);
      return { total: data.list_total_count, rows: data.row || [] };
    } catch (err) {
      // 인증키가 URL에 들어가므로 오류 메시지에서 가린다
      lastError = new Error(String(err.message).split(key).join('***'));
      if (err.fatal) break; // 키·요청 오류는 다시 시도해도 같다
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`서울 API ${start}-${end} 조회 실패: ${lastError.message}`);
}

async function fetchAll(key) {
  if (key === 'sample') return (await fetchPage(key, 1, SAMPLE_LIMIT)).rows;
  const first = await fetchPage(key, 1, PAGE_SIZE);
  const rows = [...first.rows];
  for (let start = PAGE_SIZE + 1; start <= first.total; start += PAGE_SIZE) {
    const page = await fetchPage(key, start, Math.min(start + PAGE_SIZE - 1, first.total));
    rows.push(...page.rows);
  }
  // 일부 페이지만 받은 결과로 어제 데이터를 덮어쓰지 않는다
  if (rows.length < first.total * 0.95) {
    throw new Error(`수집 건수 부족: ${rows.length}/${first.total}`);
  }
  return rows;
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// "26-11-13", "채용시까지  26-11-15" → "2026-11-13". 날짜가 없으면 상시 채용(null).
function parseDate(text) {
  const m = clean(text).match(/(\d{2})-(\d{2})-(\d{2})$/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

function to24h(ampm, hour, minute) {
  let h = Number(hour) % 12;
  if (ampm === '오후') h += 12;
  return h * 60 + Number(minute);
}

function parseSchedule(workText, jobText) {
  const fmt = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const times = [...workText.matchAll(/\((오전|오후)\)\s*(\d{1,2})시\s*(\d{1,2})분/g)].map((m) => to24h(m[1], m[2], m[3]));
  const hasTimes = times.length >= 2;
  const dailyMinutes = hasTimes && times[1] > times[0] ? times[1] - times[0] : null;

  const search = `${workText} ${jobText}`;
  const range = search.match(/주\s*([1-6])\s*[~-]\s*([1-7])\s*일/);
  const single = search.match(/주\s*([1-7])\s*일/);
  let days = null;
  let label = '';
  if (range) {
    days = Number(range[2]);
    label = `주 ${range[1]}~${range[2]}일`;
  } else if (single) {
    days = Number(single[1]);
    label = `주 ${days}일`;
  }

  const avg = workText.match(/평균근무시간\s*:?\s*(\d+(?:\.\d+)?)/);
  let weeklyHours = avg ? Number(avg[1]) : null;
  if (!weeklyHours && dailyMinutes && days) {
    // 8시간을 넘는 근무는 법정 휴게 1시간을 뺀다
    const paid = dailyMinutes > 480 ? dailyMinutes - 60 : dailyMinutes;
    weeklyHours = (paid / 60) * days;
  }

  return {
    workDays: label,
    days,
    weeklyHours,
    workHours: hasTimes ? `${fmt(times[0])}~${fmt(times[1])}` : '공고 확인',
  };
}

// 임금은 하한을 기준으로 월 환산한다. 환산에 필요한 근무량을 모르면 null로 둔다.
function parseSalary(text, code, schedule) {
  const raw = clean(text);
  const amounts = [...raw.matchAll(/([\d,]+)\s*원/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter(Boolean);
  if (!amounts.length) return { salaryText: '협의', salaryMonthly: null };

  const [min, max] = amounts;
  const kind = { H: '시급', D: '일급', M: '월급', Y: '연봉' }[code] || (raw.match(/^(시급|일급|월급|연봉)/)?.[1] ?? '급여');
  let monthly = null;
  if (code === 'M') monthly = min;
  else if (code === 'Y') monthly = min / 12;
  else if (code === 'D' && schedule.days) monthly = min * schedule.days * WEEKS_PER_MONTH;
  else if (code === 'H' && schedule.weeklyHours) monthly = min * schedule.weeklyHours * WEEKS_PER_MONTH;
  const salaryMonthly = monthly === null ? null : Math.round(monthly / 1000) * 1000;

  const won = (n) => `${n.toLocaleString('ko-KR')}원`;
  let salaryText = max && max !== min ? `${kind} ${won(min)} ~ ${won(max)}` : `${kind} ${won(min)}${/이상/.test(raw) ? ' 이상' : ''}`;
  if (code !== 'M' && salaryMonthly) salaryText += ` (월 환산 약 ${Math.round(salaryMonthly / 10000)}만원)`;
  return { salaryText, salaryMonthly };
}

function employType(title, emp, text) {
  const head = `${title} ${emp}`;
  for (const word of ['위촉', '촉탁', '자문', '고문', '프리랜서']) {
    if (head.includes(word) || (word === '위촉' && /위촉\s*(계약|직)/.test(text))) return word;
  }
  if (/시간\(선택\)제|시간제|파트\s*타임/.test(head)) return '시간제';
  if (/기간의 정함이 있는|기간제|계약직/.test(head)) return '계약직';
  if (/기간의 정함이 없는/.test(emp)) return '정규직';
  return '기타';
}

function contractTerm(emp) {
  if (/기간의 정함이 있는|기간제/.test(emp)) return '기간제 (공고 확인)';
  if (/기간의 정함이 없는/.test(emp)) return '기간 정함 없음';
  return '';
}

function remoteType(text) {
  const t = text.replace(/재택(근무)?\s*(불가|없음|안\s*됨)/g, '');
  if (/(전면|완전|100%)\s*재택/.test(t)) return 'full';
  return /재택/.test(t) ? 'partial' : 'none';
}

function insuranceType(fourIns, employ) {
  if (['위촉', '자문', '고문', '프리랜서'].includes(employ)) {
    return employ === '위촉' ? '위촉' : '기타';
  }
  return ['국민연금', '고용보험', '산재보험'].every((w) => fourIns.includes(w)) && /의료보험|건강보험/.test(fourIns) ? '4대보험' : '기타';
}

function orgType(name) {
  if (/협회|연합회|조합/.test(name)) return '협회';
  if (/공단|공사$|재단|진흥원|시청|구청|연구원|센터$/.test(name)) return '공공·비영리';
  return '기업';
}

function makeId(org, title, deadline) {
  return `seoul-${crypto.createHash('sha1').update(`${org}|${title}|${deadline}`).digest('hex').slice(0, 12)}`;
}

function work24SearchUrl(title) {
  // API가 긴 제목을 "..."로 자르고, 고용24 검색어는 30자까지 받는다
  const keyword = encodeURIComponent(title.replace(/(\.{2,}|…)$/, '').slice(0, 30));
  return `${WORK24_SEARCH}?srcKeyword=${keyword}&keywordWantedTitle=Y&srckeywordWantedTitle=Y`;
}

function normalize(row) {
  const org = clean(row.COMPANY);
  const title = clean(row.TITLE);
  const emp = clean(row.EMP_TP_NM);
  const workText = clean(row.WORKDAY_WORKHR_CONT);
  const jobText = clean(row.JOB_CONT);
  const pfCond = clean(row.PF_COND);
  const deadline = parseDate(row.CLOSE_DT);
  const schedule = parseSchedule(workText, jobText);
  const employ = employType(title, emp, jobText);
  const allText = `${title} ${emp} ${workText} ${jobText} ${pfCond}`;

  return {
    id: makeId(org, title, deadline),
    source: 'seoul',
    org,
    orgType: orgType(org),
    title,
    region: clean(row.REGION),
    address: clean(row.WORK_REGION).replace(/^\(\d+\)\s*/, ''),
    employType: employ,
    workDays: schedule.workDays,
    workHours: schedule.workHours,
    remote: remoteType(allText),
    ...parseSalary(row.SAL_TP_NM, clean(row.SAL_TP_CD), schedule),
    insurance: insuranceType(clean(row.FOUR_INS), employ),
    contractTerm: contractTerm(emp),
    ageCondition: /고령자|중장년|신중년/.test(pfCond) ? pfCond : '공고 확인',
    documents: clean(row.SUBMIT_DOC) || '공고 확인',
    deadline,
    // API에 공고별 고유 링크가 없어 고용24 제목 검색으로 연결한다
    url: work24SearchUrl(title),
    score: null,
    reason: '',
    matchItems: [],
    careerTranslation: [],
    commuteMin: null,
    commuteMode: null,
    isReference: false,
    // 필터 전용 값. 저장 전에 제거한다.
    _filter: {
      allText,
      titleAndJob: `${title} ${clean(row.JOBS_NM)}`,
      career: clean(row.CAREER),
      regDate: parseDate(row.REG_DT),
      days: schedule.days,
    },
  };
}

module.exports = { fetchAll, normalize, parseDate, parseSalary, parseSchedule };
