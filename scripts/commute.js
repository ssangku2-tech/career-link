// 출발지(화정역)에서 근무지까지 편도 시간을 구한다.
// 서울 = ODsay 대중교통, 경기(고양) = 카카오모빌리티 자차. 주소 → 좌표는 카카오 로컬.
// ODsay 키는 URI 방식(앱 주소 등록)이라 호출할 때 앱 주소를 Referer로 보낸다 (CLAUDE.md).
const KAKAO_LOCAL = 'https://dapi.kakao.com/v2/local/search';
const KAKAO_DIRECTIONS = 'https://apis-navi.kakaomobility.com/v1/directions';
const ODSAY_TRANSIT = 'https://api.odsay.com/v1/api/searchPubTransPathT';
const APP_ORIGIN = 'https://ssangku2-tech.github.io';
const WALK_METERS_PER_MIN = 67; // ODsay가 700m 이내라 경로를 주지 않을 때 걷는 시간으로 본다

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} JSON 아님`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body.message || body.msg || ''}`.trim());
  return body;
}

function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.y - a.y);
  const dLng = rad(b.x - a.x);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.y)) * Math.cos(rad(b.y)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ODsay 응답에서 가장 빠른 경로의 분을 꺼낸다. 700m 이내(-98)는 도보 시간으로 대신한다.
function parseTransit(body, from, to) {
  const error = Array.isArray(body.error) ? body.error[0] : body.error;
  if (error) {
    if (String(error.code) === '-98') return Math.max(1, Math.round(distanceMeters(from, to) / WALK_METERS_PER_MIN));
    throw new Error(`ODsay ${error.code}: ${error.msg || error.message}`);
  }
  const times = (body.result?.path || []).map((p) => p.info?.totalTime).filter((t) => Number.isFinite(t));
  if (!times.length) throw new Error('ODsay 경로 없음');
  return Math.min(...times);
}

function parseDriving(body) {
  const route = body.routes?.[0];
  if (!route || route.result_code !== 0) throw new Error(`카카오 길찾기 ${route?.result_code}: ${route?.result_msg}`);
  return Math.round(route.summary.duration / 60);
}

function createCommuter({ kakaoKey, odsayKey, originQuery }) {
  const kakao = { Authorization: `KakaoAK ${kakaoKey}` };
  const geocache = new Map();

  async function geocode(query) {
    if (!query) return null;
    if (geocache.has(query)) return geocache.get(query);
    let doc = (await getJson(`${KAKAO_LOCAL}/address.json?query=${encodeURIComponent(query)}`, kakao)).documents?.[0];
    if (!doc) doc = (await getJson(`${KAKAO_LOCAL}/keyword.json?query=${encodeURIComponent(query)}`, kakao)).documents?.[0];
    const point = doc ? { x: Number(doc.x), y: Number(doc.y) } : null;
    geocache.set(query, point);
    return point;
  }

  async function transitMinutes(from, to) {
    const url = `${ODSAY_TRANSIT}?SX=${from.x}&SY=${from.y}&EX=${to.x}&EY=${to.y}&apiKey=${encodeURIComponent(odsayKey)}`;
    return parseTransit(await getJson(url, { Referer: `${APP_ORIGIN}/`, Origin: APP_ORIGIN }), from, to);
  }

  async function drivingMinutes(from, to) {
    return parseDriving(await getJson(`${KAKAO_DIRECTIONS}?origin=${from.x},${from.y}&destination=${to.x},${to.y}`, kakao));
  }

  // 반환값: Map(id → {min, mode}). 주소가 없거나 계산에 실패한 공고는 빠진다.
  return async function commute(jobs, log = console.log) {
    const origin = await geocode(originQuery);
    if (!origin) throw new Error(`출발지 "${originQuery}" 좌표를 찾지 못함`);
    const results = new Map();
    const failures = [];
    for (const job of jobs) {
      const mode = job.region.startsWith('서울') ? 'transit' : 'car';
      try {
        const to = await geocode(job.address);
        if (!to) continue;
        const min = mode === 'transit' ? await transitMinutes(origin, to) : await drivingMinutes(origin, to);
        results.set(job.id, { min, mode });
      } catch (err) {
        failures.push(err.message.split(odsayKey).join('***').split(kakaoKey).join('***'));
      }
    }
    if (failures.length) log(`출퇴근 계산 실패 ${failures.length}건 (예: ${failures[0]})`);
    if (jobs.length && failures.length === jobs.length) throw new Error(`모든 공고 계산 실패: ${failures[0]}`);
    return results;
  };
}

module.exports = { createCommuter, parseTransit, parseDriving, distanceMeters };
