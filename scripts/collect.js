#!/usr/bin/env node
// 매일 공고를 수집해 data/latest.json과 data/jobs/YYYY-MM-DD.json을 만든다.
// 사용법: node scripts/collect.js [--dry-run]
const fs = require('fs');
const path = require('path');
const seoul = require('./sources/seoul');

const ROOT = path.join(__dirname, '..');
const MAX_RECOMMEND = 10;
const URGENT_DAYS = 5;

// 그 자체로 유연근무인 형태
const FLEX_FORM = /시간제|시간\(선택\)제|파트\s*타임|촉탁|위촉|자문|고문|프리랜서|재택/;
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
const KEYWORD_NOISE = /통신판매|텔레마케|영업시간|영업장|영업일/g;

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
    keywords: [...core, ...broad],
    weight: core.length * CORE_WEIGHT + broad.length * BROAD_WEIGHT,
    bonuses: bonusesOf(job),
  };
}

// AI 채점(Phase 3) 대상: 조건을 통과하고 경력 키워드 비중이 기준 이상인 공고
function candidates(jobs, matching) {
  return jobs.map((job) => annotate(job, matching)).filter((item) => item.weight >= matching.minWeight);
}

// AI 채점 전까지는 키워드 비중과 가점 개수로 순서를 정한다.
function selectJobs(items, today) {
  const urgent = (job) => job.deadline !== null && daysBetween(today, job.deadline) <= URGENT_DAYS;
  return [...items]
    .sort((a, b) =>
      b.weight - a.weight
      || b.bonuses.length - a.bonuses.length
      || urgent(b.job) - urgent(a.job)
      || (a.job.deadline || '9999').localeCompare(b.job.deadline || '9999'))
    .slice(0, MAX_RECOMMEND)
    .map(({ job, keywords, bonuses }) => ({
      ...job,
      reason: [`제목·직종 일치: ${keywords.join(', ')}`, bonuses.length ? `가점: ${bonuses.join(', ')}` : ''].filter(Boolean).join(' · '),
    }));
}

function toPublic({ _filter, ...job }) {
  return job;
}

function buildOutput(allJobs, matching, now = new Date()) {
  const today = seoulToday(now);
  const yesterday = seoulToday(new Date(now.getTime() - 86400000));
  const unique = dedupe(allJobs);
  const filtered = unique.filter((job) => passesFilter(job, today) && (!matching.seniorOnly || isSeniorHiring(job)));
  const matched = candidates(filtered, matching);
  const collected = unique.filter((job) => isTargetRegion(job) && job._filter.regDate && job._filter.regDate >= yesterday).length;
  return {
    isSample: false,
    isScored: false,
    generatedAt: now.toISOString(),
    // filtered: 지역·근무형태 조건 통과, matched: 그중 경력 키워드 기준 통과 (AI 채점 대상)
    summary: { collected, filtered: filtered.length, matched: matched.length },
    jobs: selectJobs(matched, today).map(toPublic),
  };
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

  const output = buildOutput(rows.map(seoul.normalize), config.matching);
  const s = output.summary;
  console.log(`원본 ${rows.length}건 · 신규 ${s.collected}건 · 조건 통과 ${s.filtered}건 · 키워드 일치 ${s.matched}건 · 추천 ${output.jobs.length}건`);

  if (process.argv.includes('--dry-run') || key === 'sample') {
    console.log('저장하지 않음 (--dry-run 또는 샘플 키)');
    output.jobs.forEach((j) => console.log(`- ${j.org} | ${j.title} | ${j.region} | ${j.salaryText} | ${j.reason}`));
    return;
  }
  writeOutput(output);
}

if (require.main === module) {
  main().catch((err) => {
    // 실패하면 파일을 쓰지 않아 어제의 추천이 그대로 유지된다
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { buildOutput, passesFilter, hasAgeCap, dedupe };
