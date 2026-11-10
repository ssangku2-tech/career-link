// 텔레그램으로 고득점 추천을 요약해 보낸다 (CLAUDE.md 8단계: 80점 이상).
const APP_URL = 'https://ssangku2-tech.github.io/career-link/';
const NOTIFY_SCORE = 80;

function commuteText(job) {
  if (job.commuteMin == null) return '';
  return `${job.commuteMode === 'car' ? '자차' : '대중교통'} ${job.commuteMin}분`;
}

function formatDate(iso) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(iso));
}

// 보낼 공고가 없으면 null. test=true면 점수와 관계없이 상위 3건을 [테스트]로 보낸다.
function buildMessage(output, { test = false } = {}) {
  const jobs = test
    ? output.jobs.slice(0, 3)
    : output.jobs.filter((j) => j.score != null && j.score >= NOTIFY_SCORE);
  if (!jobs.length) return null;
  const head = test
    ? `[테스트] 경력잇기 · ${formatDate(output.generatedAt)}\n알림 연결 확인용입니다. 점수 기준과 관계없이 상위 ${jobs.length}건을 보냅니다.`
    : `경력잇기 · ${formatDate(output.generatedAt)}\n${NOTIFY_SCORE}점 이상 추천 ${jobs.length}건`;
  const body = jobs.map((j) => [
    `${j.score ?? '채점 전'}${j.score != null ? '점' : ''} ${j.title}`,
    [j.org, j.region, commuteText(j), j.deadline ? `${j.deadline.slice(5).replace('-', '/')} 마감` : ''].filter(Boolean).join(' · '),
    j.reason,
  ].join('\n'));
  return [head, ...body, `앱에서 보기: ${APP_URL}`].join('\n\n');
}

async function sendTelegram({ token, chatId, text }) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`텔레그램 ${res.status}: ${String(body.description || '응답 오류').split(token).join('***')}`);
  }
  return body.result.message_id;
}

// 수집이 끝난 뒤 호출한다. 실패해도 수집 결과에는 영향을 주지 않는다.
async function notify(output, { test = false, log = console.log } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    log('텔레그램 알림 건너뜀 (TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 없음)');
    return;
  }
  const text = buildMessage(output, { test });
  if (!text) {
    log(`텔레그램 알림 없음 (${NOTIFY_SCORE}점 이상 추천 없음)`);
    return;
  }
  try {
    await sendTelegram({ token, chatId, text });
    log(`텔레그램 알림 보냄${test ? ' (테스트)' : ''}`);
  } catch (err) {
    log(`::warning::${err.message}`);
  }
}

// 수집 없이 현재 data/latest.json으로 테스트 메시지를 보낸다: node scripts/notify.js --test
if (require.main === module) {
  const path = require('path');
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* Actions에는 .env가 없다 */ }
  const output = require(path.join(__dirname, '..', 'data', 'latest.json'));
  notify(output, { test: process.argv.includes('--test') });
}

module.exports = { buildMessage, sendTelegram, notify, NOTIFY_SCORE };
