#!/usr/bin/env node
// 매일 공고를 수집해 data/latest.json과 data/jobs/YYYY-MM-DD.json을 만든다.
// 사용법: node scripts/collect.js [--dry-run]
const fs = require('fs');
const path = require('path');
const seoul = require('./sources/seoul');
const alio = require('./sources/alio');

const ROOT = path.join(__dirname, '..');
const MAX_RECOMMEND = 10;
const MIN_RECOMMEND = 5;
const RECOMMEND_SCORE = 70;
const REFERENCE_SCORE = 60;
// 하루 채점 비용의 상한. 키워드 순위 상위만 AI로 채점한다.
const MAX_SCORE_TARGETS = 40;
const URGENT_DAYS = 5;

// 그 자체로 유연근무인 형태
const FLEX_FORM = /시간제|시간\(선택\)제|파트\s*타임|촉탁|위촉|자문|고문|프리랜서/; // 재택은 희망 근무 형태에서 뺐다 (2026-11-11)
// 계약직은 주 5일 전일제가 대부분이라 중장년 가점이 있을 때만 통과시킨다
const CONTRACT_FORM = /계약직|기간의 정함이 있는|기간제/;
const CORE_WEIGHT = 2;
const BROAD_WEIGHT = 1;
const REMOTE_DENIED = /재택(근무)?\s*(불가|없음|안\s*됨)/g;
const CAREER_BONUS = '경력 10년 이상';
const BONUS = [
  ['중장년 우대', /(?<!청)장년/], // "청장년"은 청년+장년이라 제외
  ['신중년', /신중년/],
  ['퇴직전문인력', /퇴직\s*전문/],
  ['고령자 우대', /고령자|(?:4[5-9]|[5-6]\d)\s*세\s*이상/],
  [CAREER_BONUS, /경력\s*(1\d|[2-9]\d)\s*년\s*이상/],
];
// 직무 키워드와 무관하게 같은 글자가 들어가는 표현
const KEYWORD_NOISE = /통신판매|텔레마케|영업시간|영업장|영업일|송영/g; // 송영(送迎) 차량 운전

function seoulToday(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

function dedupe(jobs) {
  return [...new Map(jobs.map((job) => [`${job.org}|${job.title}|${job.deadline}`, job])).values()];
}

function isTargetRegion(job) {
  return job.region.startsWith('서울') || job.region.startsWith('경기 고양');
}

function hasAgeCap(text) {
  // "18세 미만 지원 불가" 같은 미성년자 문구는 나이 상한이 아니므로 20세 이상만 본다
  return [...text.matchAll(/(\d{2})\s*세\s*(?:이하|미만)/g)].some((m) => Number(m[1]) >= 20);
}

const bonusesOf = (job) => BONUS.filter(([, re]) => re.test(job._filter.allText)).map(([name]) => name);
// 경력 연수는 나이 조건이 아니므로 중장년 채용 여부에는 넣지 않는다
const isSeniorHiring = (job) => bonusesOf(job).some((name) => name !== CAREER_BONUS);

function passesFilter(job, today) {
  const { allText, career, days } = job._filter;
  if (!isTargetRegion(job)) return false;
  if (job.deadline && job.deadline < today) return false;
  if (hasAgeCap(allText) || career === '신입') return false;
  // 알리오는 고용유형 코드로 비정규 여부를 알려 준다
  if (job._filter.nonRegular !== undefined) return job._filter.nonRegular;
  const text = allText.replace(REMOTE_DENIED, '');
  const flexibleDays = days !== null && days >= 2 && days <= 4;
  if (flexibleDays || FLEX_FORM.test(text)) return true;
  return CONTRACT_FORM.test(text) && bonusesOf(job).length > 0;
}

// 다른 일치 키워드에 포함된 키워드는 빼서 "사업기획"과 "기획"을 두 번 세지 않는다
function matchKeywords(text, words) {
  const upper = text.replace(KEYWORD_NOISE, '').toUpperCase();
  const found = words.filter((word) => upper.includes(word.toUpperCase()));
  return found.filter((word) => !found.some((other) => other !== word && other.toUpperCase().includes(word.toUpperCase())));
}

function annotate(job, matching) {
  const core = matchKeywords(job._filter.titleAndJob, matching.coreKeywords);
  const broad = matchKeywords(job._filter.titleAndJob, matching.broadKeywords)
    .filter((word) => !core.some((c) => c.toUpperCase().includes(word.toUpperCase())));
  return {
    job,
    core,
    keywords: [...core, ...broad],
    weight: core.length * CORE_WEIGHT + broad.length * BROAD_WEIGHT,
    bonuses: bonusesOf(job),
  };
}

// AI 채점(Phase 3) 대상: 조건을 통과하고 경력 키워드 비중이 기준 이상인 공고
function candidates(jobs, matching) {
  return jobs
    .map((job) => annotate(job, matching))
    .filter((item) => item.weight >= matching.minWeight && (!item.job._filter.requireCore || item.core.length > 0));
}

const isUrgent = (job, today) => job.deadline !== null && daysBetween(today, job.deadline) <= URGENT_DAYS;
const byDeadline = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999');

// 키워드 비중과 가점 개수 순서. 채점 대상을 고르거나 채점 실패 시 추천에 쓴다.
function rankHeuristic(items, today) {
  return [...items].sort((a, b) =>
    b.weight - a.weight
    || b.bonuses.length - a.bonuses.length
    || isUrgent(b.job, today) - isUrgent(a.job, today)
    || byDeadline(a.job, b.job));
}

function heuristicReason({ job, keywords, bonuses }) {
  return [
    `제목·직종 일치: ${keywords.join(', ')}`,
    bonuses.length ? `가점: ${bonuses.join(', ')}` : '',
    job._filter.seniorExempt ? '공공기관 비정규 경력 채용' : '',
  ].filter(Boolean).join(' · ');
}

// CLAUDE.md 7단계: 70점 이상 점수순 최대 10건, 5건 미만이면 60점대로 5건까지 채우고 참고 표시.
// 동점이면 마감 D-5 이내를 먼저 둔다.
function pickRecommendations(scoredJobs, today) {
  const order = (a, b) => b.score - a.score || isUrgent(b, today) - isUrgent(a, today) || byDeadline(a, b);
  const top = scoredJobs.filter((j) => j.score >= RECOMMEND_SCORE).sort(order).slice(0, MAX_RECOMMEND);
  if (top.length >= MIN_RECOMMEND) return top.map((j) => ({ ...j, isReference: false }));
  const refs = scoredJobs
    .filter((j) => j.score >= REFERENCE_SCORE && j.score < RECOMMEND_SCORE)
    .sort(order)
    .slice(0, MIN_RECOMMEND - top.length);
  return [...top.map((j) => ({ ...j, isReference: false })), ...refs.map((j) => ({ ...j, isReference: true }))];
}

function toPublic({ _filter, ...job }) {
  return job;
}

function prepare(allJobs, matching, now) {
  const today = seoulToday(now);
  const yesterday = seoulToday(new Date(now.getTime() - 86400000));
  const unique = dedupe(allJobs);
  const seniorOk = (job) => !matching.seniorOnly || job._filter.seniorExempt || isSeniorHiring(job);
  const filtered = unique.filter((job) => passesFilter(job, today) && seniorOk(job));
  const matched = candidates(filtered, matching);
  const collected = unique.filter((job) => isTargetRegion(job) && job._filter.regDate && job._filter.regDate >= yesterday).length;
  return {
    today,
    ranked: rankHeuristic(matched, today),
    // filtered: 지역·근무형태 조건 통과, matched: 그중 경력 키워드 기준 통과 (AI 채점 대상)
    summary: { collected, filtered: filtered.length, matched: matched.length },
  };
}

function assemble(now, summary, jobs, isScored) {
  return { isSample: false, isScored, generatedAt: now.toISOString(), summary, jobs: jobs.map(toPublic) };
}

// 채점 없이 키워드 순위로 고른다 (AI 키가 없거나 채점이 실패했을 때)
function buildOutput(allJobs, matching, now = new Date()) {
  const { ranked, summary } = prepare(allJobs, matching, now);
  const jobs = ranked.slice(0, MAX_RECOMMEND).map((item) => ({ ...item.job, reason: heuristicReason(item) }));
  return assemble(now, summary, jobs, false);
}

// 출퇴근 시간을 붙이고 한도를 넘는 공고를 뺀다. 계산하지 못한 공고(주소 없음 등)는 남긴다.
async function applyCommute(items, commuter, maxMinutes, log) {
  const results = await commuter(items.map((item) => item.job), log);
  const withCommute = items.map((item) => {
    const c = results.get(item.job.id);
    return c ? { ...item, job: { ...item.job, commuteMin: c.min, commuteMode: c.mode } } : item;
  });
  const kept = withCommute.filter((item) => item.job.commuteMin == null || item.job.commuteMin <= maxMinutes);
  return { kept, computed: results.size, excluded: withCommute.length - kept.length };
}

// 상위 후보에 출퇴근 → AI 채점 순으로 적용한다. 각 단계가 실패하면 경고만 남기고 건너뛴다.
async function buildFinalOutput(allJobs, matching, { commuter, maxCommute, scorer, log = console.log } = {}, now = new Date()) {
  const { today, ranked, summary } = prepare(allJobs, matching, now);
  let targets = ranked.slice(0, MAX_SCORE_TARGETS);
  const sum = { ...summary };

  if (commuter) {
    try {
      const c = await applyCommute(targets, commuter, maxCommute, log);
      targets = c.kept;
      Object.assign(sum, { commuteComputed: c.computed, commuteExcluded: c.excluded });
    } catch (err) {
      log(`::warning::출퇴근 계산 실패: ${err.message} (출퇴근 없이 진행)`);
    }
  }

  if (scorer) {
    try {
      const { scores, usage } = await scorer(targets.map((item) => ({
        job: item.job,
        hints: { keywords: item.keywords, bonuses: item.bonuses },
      })));
      const scored = targets
        .filter((item) => scores.has(item.job.id))
        .map((item) => ({ ...item.job, ...scores.get(item.job.id) }));
      const output = assemble(now, { ...sum, scored: scored.length }, pickRecommendations(scored, today), true);
      return { output, usage, scored: scored.map(toPublic) };
    } catch (err) {
      log(`::warning::AI 채점 실패: ${err.message} (키워드 순위로 진행)`);
    }
  }

  const jobs = targets.slice(0, MAX_RECOMMEND).map((item) => ({ ...item.job, reason: heuristicReason(item) }));
  return { output: assemble(now, sum, jobs, false) };
}

function writeOutput(output) {
  const dateFile = path.join(ROOT, 'data', 'jobs', `${seoulToday(new Date(output.generatedAt))}.json`);
  const text = `${JSON.stringify(output, null, 2)}\n`;
  fs.mkdirSync(path.dirname(dateFile), { recursive: true });
  fs.writeFileSync(dateFile, text);
  fs.writeFileSync(path.join(ROOT, 'data', 'latest.json'), text);
}

async function main() {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* 배포 환경에는 .env가 없다 */ }
  const key = process.env.SEOUL_API_KEY?.trim();
  if (!key) throw new Error('SEOUL_API_KEY가 없습니다');

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const rows = await seoul.fetchAll(key);
  if (rows.length === 0) throw new Error('수집 결과가 0건입니다');
  const jobs = rows.map(seoul.normalize);

  // 알리오는 보조 소스라 실패해도 서울 공고로 계속 진행한다
  const alioKey = process.env.DATA_GO_KR_KEY?.trim();
  let alioCount = 0;
  if (alioKey) {
    try {
      const alioRows = await alio.fetchAll(alioKey);
      alioCount = alioRows.length;
      jobs.push(...alioRows.map(alio.normalize));
    } catch (err) {
      console.log(`::warning::${err.message} (서울 공고만으로 진행)`);
    }
  } else {
    console.log('DATA_GO_KR_KEY가 없어 알리오는 건너뜀');
  }

  // 출퇴근: 카카오·ODsay 키가 모두 있을 때만
  const kakaoKey = process.env.KAKAO_REST_KEY?.trim();
  const odsayKey = process.env.ODSAY_API_KEY?.trim();
  let commuter;
  if (kakaoKey && odsayKey) {
    const { createCommuter } = require('./commute');
    commuter = createCommuter({ kakaoKey, odsayKey, originQuery: config.origin.name });
  } else {
    console.log('출퇴근 계산 건너뜀 (KAKAO_REST_KEY 또는 ODSAY_API_KEY 없음)');
  }

  // AI 채점: Anthropic 키가 있을 때만
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  let scorer;
  let model;
  if (anthropicKey && !process.argv.includes('--no-score')) {
    const { createScorer, MODEL } = require('./score');
    scorer = createScorer({ apiKey: anthropicKey, config });
    model = MODEL;
  } else {
    console.log('AI 채점 건너뜀 (ANTHROPIC_API_KEY 없음 또는 --no-score)');
  }

  const result = await buildFinalOutput(jobs, config.matching, { commuter, maxCommute: config.commute.maxMinutes, scorer });
  const { output } = result;
  const s = output.summary;
  if (s.commuteComputed !== undefined) {
    console.log(`출퇴근 계산 ${s.commuteComputed}건 · ${config.commute.maxMinutes}분 초과로 제외 ${s.commuteExcluded}건`);
  }
  if (result.usage) {
    const u = result.usage;
    console.log(`AI 채점 ${model}: ${s.scored}건 · 입력 ${u.input} · 출력 ${u.output} 토큰 · 약 $${u.costUsd.toFixed(4)}`);
  }
  console.log(`원본 서울 ${rows.length}건 + 알리오 ${alioCount}건 · 신규 ${s.collected}건 · 조건 통과 ${s.filtered}건 · 키워드 일치 ${s.matched}건 · 추천 ${output.jobs.length}건`);

  if (process.argv.includes('--dry-run') || key === 'sample') {
    console.log('저장하지 않음 (--dry-run 또는 샘플 키)');
    (result.scored || output.jobs).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).forEach((j) => {
      const commute = j.commuteMin == null ? '출퇴근 미계산' : `${j.commuteMode === 'car' ? '자차' : '대중교통'} ${j.commuteMin}분`;
      console.log(`- [${j.source}] ${j.score ?? '-'}점 ${j.org} | ${j.title} | ${j.region} | ${commute}\n    이유: ${j.reason}`);
      j.careerTranslation.forEach((t) => console.log(`    번역: ${t.from} → ${t.to}`));
    });
    console.log(`추천 결과: ${output.jobs.map((j) => `${j.score ?? '-'}점${j.isReference ? '(참고)' : ''}`).join(', ') || '없음'}`);
    return;
  }
  writeOutput(output);
  await require('./notify').notify(output);
}

if (require.main === module) {
  main().catch((err) => {
    // 실패하면 파일을 쓰지 않아 어제의 추천이 그대로 유지된다
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { buildOutput, buildFinalOutput, pickRecommendations, passesFilter, hasAgeCap, dedupe };
