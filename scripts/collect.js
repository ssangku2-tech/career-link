#!/usr/bin/env node
// 매일 공고를 수집해 data/latest.json과 data/jobs/YYYY-MM-DD.json을 만든다.
// 사용법: node scripts/collect.js [--dry-run]
const fs = require('fs');
const path = require('path');
const seoul = require('./sources/seoul');

const ROOT = path.join(__dirname, '..');
const MAX_RECOMMEND = 10;
const URGENT_DAYS = 5;

const WORK_FORM = /시간제|시간\(선택\)제|파트\s*타임|계약직|기간의 정함이 있는|기간제|촉탁|위촉|자문|고문|프리랜서|재택/;
const REMOTE_DENIED = /재택(근무)?\s*(불가|없음|안\s*됨)/g;
const BONUS = [
  ['중장년 우대', /중장년/],
  ['신중년', /신중년/],
  ['퇴직전문인력', /퇴직\s*전문/],
  ['고령자 우대', /고령자/],
  ['경력 10년 이상', /경력\s*(1\d|[2-9]\d)\s*년\s*이상/],
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

function passesFilter(job, today) {
  const { allText, career, days } = job._filter;
  if (!isTargetRegion(job)) return false;
  if (job.deadline && job.deadline < today) return false;
  if (hasAgeCap(allText) || career === '신입') return false;
  const flexibleDays = days !== null && days >= 2 && days <= 4;
  return flexibleDays || WORK_FORM.test(allText.replace(REMOTE_DENIED, ''));
}

function annotate(job, jobKeywords) {
  const titleAndJob = job._filter.titleAndJob.replace(KEYWORD_NOISE, '');
  return {
    job,
    keywords: jobKeywords.filter((word) => titleAndJob.toUpperCase().includes(word.toUpperCase())),
    bonuses: BONUS.filter(([, re]) => re.test(job._filter.allText)).map(([name]) => name),
  };
}

// AI 채점(Phase 3) 전까지는 직무 키워드와 가점 개수로 순서를 정한다.
function selectJobs(jobs, jobKeywords, today) {
  const urgent = (job) => job.deadline !== null && daysBetween(today, job.deadline) <= URGENT_DAYS;
  return jobs
    .map((job) => annotate(job, jobKeywords))
    .filter((item) => item.keywords.length > 0)
    .sort((a, b) =>
      b.keywords.length - a.keywords.length
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

function buildOutput(allJobs, jobKeywords, now = new Date()) {
  const today = seoulToday(now);
  const yesterday = seoulToday(new Date(now.getTime() - 86400000));
  const unique = dedupe(allJobs);
  const matched = unique.filter((job) => passesFilter(job, today));
  const collected = unique.filter((job) => isTargetRegion(job) && job._filter.regDate && job._filter.regDate >= yesterday).length;
  return {
    isSample: false,
    isScored: false,
    generatedAt: now.toISOString(),
    summary: { collected, matched: matched.length },
    jobs: selectJobs(matched, jobKeywords, today).map(toPublic),
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

  const output = buildOutput(rows.map(seoul.normalize), config.matching.jobKeywords);
  console.log(`원본 ${rows.length}건 · 신규 ${output.summary.collected}건 · 조건 일치 ${output.summary.matched}건 · 추천 ${output.jobs.length}건`);

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
