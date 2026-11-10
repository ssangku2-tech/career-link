// 알리오: 재정경제부_공공기관 채용정보 조회서비스 (data.go.kr 15125273)
// 공공기관은 나이 조건을 쓰지 않으므로 중장년 표시 대신 경력직·비정규·핵심 키워드로 거른다 (CLAUDE.md).
const BASE = 'https://apis.data.go.kr/1051000/recruitment/list';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const RETRIES = 3;
const DETAIL_URL = 'https://job.alio.go.kr/recruitview.do?idx=';

async function fetchPage(key, pageNo) {
  const url = `${BASE}?serviceKey=${encodeURIComponent(key)}&resultType=json&numOfRows=${PAGE_SIZE}&pageNo=${pageNo}&ongoingYn=Y`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 인증키 오류 등은 XML로 올 수 있다
      if (text.trimStart().startsWith('<')) {
        const msg = text.match(/<returnAuthMsg>([^<]*)</)?.[1] || text.match(/<errMsg>([^<]*)</)?.[1] || 'XML 오류 응답';
        throw new Error(msg);
      }
      const body = JSON.parse(text);
      if (Number(body.resultCode) !== 200) throw new Error(`${body.resultCode}: ${body.resultMsg}`);
      return { total: Number(body.totalCount) || 0, rows: body.result || [] };
    } catch (err) {
      lastError = new Error(String(err.message).split(key).join('***').split(encodeURIComponent(key)).join('***'));
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`알리오 ${pageNo}페이지 조회 실패: ${lastError.message}`);
}

async function fetchAll(key) {
  const first = await fetchPage(key, 1);
  const rows = [...first.rows];
  const pages = Math.min(Math.ceil(first.total / PAGE_SIZE), MAX_PAGES);
  for (let page = 2; page <= pages; page++) rows.push(...(await fetchPage(key, page)).rows);
  if (rows.length < Math.min(first.total, PAGE_SIZE * MAX_PAGES) * 0.95) {
    throw new Error(`알리오 수집 건수 부족: ${rows.length}/${first.total}`);
  }
  return rows;
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const ymd = (v) => (/^\d{8}$/.test(clean(v)) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);

// 목록의 근무지역은 시·도 단위라, 경기는 공고 문구에 고양이 나올 때만 고양으로 본다
function region(row, text) {
  const areas = clean(row.workRgnNmLst);
  if (areas.split(',').includes('서울')) return '서울';
  if (areas.split(',').includes('경기') && /고양|일산|덕양/.test(text)) return '경기 고양시';
  return areas;
}

function employType(title) {
  if (/위촉/.test(title)) return '위촉';
  if (/전문위원/.test(title)) return '전문위원';
  if (/촉탁/.test(title)) return '촉탁';
  if (/단시간|시간제/.test(title)) return '시간제';
  return '계약직';
}

function normalize(row) {
  const title = clean(row.recrutPbancTtl);
  const text = [title, row.aplyQlfcCn, row.prefCn, row.prefCondCn].map(clean).join(' ');
  const hire = clean(row.hireTypeNmLst);
  const employ = employType(title);
  return {
    id: `alio-${row.recrutPblntSn}`,
    source: 'alio',
    org: clean(row.instNm),
    orgType: '공공기관',
    title,
    region: region(row, text),
    address: '',
    employType: employ,
    workDays: '',
    workHours: '공고 확인',
    remote: /재택/.test(text) ? 'partial' : 'none',
    salaryText: '공고문 확인',
    salaryMonthly: null,
    insurance: employ === '위촉' ? '위촉' : '기타',
    contractTerm: '',
    ageCondition: '제한 없음 (공공기관)',
    documents: '공고문 확인',
    deadline: ymd(row.pbancEndYmd),
    url: `${DETAIL_URL}${encodeURIComponent(row.recrutPblntSn)}`,
    score: null,
    reason: '',
    matchItems: [],
    careerTranslation: [],
    commuteMin: null,
    commuteMode: null,
    isReference: false,
    _filter: {
      allText: text,
      titleAndJob: title, // NCS 분류(예: 정보통신)는 너무 넓어 키워드 대상에서 뺀다
      career: clean(row.recrutSeNm),
      regDate: ymd(row.pbancBgngYmd),
      days: null,
      // 비정규직이면 유연근무 조건을 대신하고, 인턴·일용직은 제외한다
      nonRegular: hire.split(',').includes('비정규직') && !/인턴|일용/.test(title),
      seniorExempt: true,
      requireCore: true,
    },
  };
}

module.exports = { fetchAll, normalize };
