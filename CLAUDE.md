# 경력잇기 (career-link) — 중장년 재취업 공고 비서 PWA

## 목적

50~60대 경력자를 위해 매일 아침 조건에 맞는 채용공고를 5~10건 골라, 적합도 점수와 이유를 붙여 보여주는 개인용 PWA. "검색하는 앱"이 아니라 "골라서 알려주는 앱"이다.

## 사용자 프로필 (매칭 기준)

* 통신 대기업 30년 경력: 사업기획, B2B 영업, 서비스 기획, 마케팅, 대리점(채널) 관리
* 희망: 유연근무(주 2~4일, 시간제, 위촉, 재택 가점), 중소기업·공공기관·협회 무관
* 근무지: 서울 전역 + 경기 고양시
* 출발 기준: 고양시 덕양구 화정역 / 서울 = 대중교통, 경기 = 자차 / 편도 70분 이내
* 희망 급여: 없음 (config.json의 desiredSalaryMonthly = null, 필터 미적용)

## 아키텍처 (기존 my-agent / english39 패턴 재사용)

* 프론트: 단일 index.html PWA (manifest + service worker), GitHub Pages 배포
* 데이터 생성: GitHub Actions 크론 (매일 06:30 KST = 21:30 UTC 전날) → scripts/collect.js 실행 → data/jobs/YYYY-MM-DD.json + data/latest.json 커밋·푸시
* 클라이언트는 data/latest.json 만 fetch. API 키는 절대 클라이언트에 두지 않는다 (모두 GitHub Secrets)
* 저장함·지원현황: localStorage (추후 Firebase 동기화 옵션)

## 데이터 소스 (우선순위)

1. 서울 열린데이터광장 — 서울시 일자리포털 채용정보 (고용24 기반, 코드값 포함) : SEOUL_API_KEY
2. 고용24 오픈API — 채용정보 (고양 지역 포함) : WORK24_API_KEY
3. 공공데이터포털 — 기획재정부 공공기관 채용정보(알리오) : DATA_GO_KR_KEY
4. (후순위) 지자체 신중년 경력형 일자리 공고 — API 없으면 페이지 확인 방식, 약관 확인 후
   * 서울시50플러스 일자리몽땅: 공개 API 없음, 이용약관이 사전 승낙 없는 복제·제3자 제공을 금지하므로 수집하지 않는다 (앱에서 링크만 제공)
   * 알리오 API: 재정경제부_공공기관 채용정보 조회서비스 (data.go.kr 15125273, https://apis.data.go.kr/1051000/recruitment) — scripts/sources/alio.js
     - 보조 소스: 실패해도 경고만 남기고 서울 공고로 진행. 근무지역이 시·도 단위라 경기는 공고 문구에 고양·일산·덕양이 있을 때만 통과
     - 2026-11-10 측정: 진행 중 494건 중 대상 공고 0~1건. 수확은 적지만 공공기관 전문위원 공고를 놓치지 않으려고 유지

* 민간 사이트(사람인·잡코리아 등) 크롤링은 하지 않는다

## 처리 파이프라인 (collect.js)

1. 소스별 수집 → 공통 스키마로 정규화
2. 중복 제거 (기관명 + 제목 + 마감일 기준)
3. 1차 키워드 필터
   * 지역: 서울 전역, 고양시
   * 근무형태 포함: 시간제, 주2일~주4일, 촉탁, 위촉, 자문, 고문, 프리랜서, 재택, 파트타임
   * 계약직(기간제)은 아래 가점이 하나 이상 있을 때만 포함 (주 5일 전일제 계약직이 대부분이라 수천 건이 통과했음)
   * 제외: "OO세 이하/미만"(20세 이상 상한만, 미성년자 문구는 무시), 신입 전용
   * 가점: 중장년 우대, 신중년, 퇴직전문인력, 고령자 우대, 경력 10년 이상
   * 중장년 전용(config matching.seniorOnly=true): 중장년·신중년·고령자·퇴직전문인력·"45~69세 이상" 표시가 있는 공고만 통과. "청장년"과 "경력 10년 이상"만 있는 공고는 제외
   * 알리오(공공기관) 예외: 공공기관은 나이 조건을 쓰지 않으므로 중장년 표시 대신 "경력직 + 비정규(전문위원·위촉·계약직) + 핵심 키워드 일치"로 통과 (2026-11-10 사용자 결정)
   * 경력 키워드(제목·직종): config.json matching. 핵심 키워드 2점, 넓은 키워드(기획·마케팅·홍보) 1점, 합계 minWeight(2) 이상만 AI 채점 대상
   * 다른 일치 키워드에 포함된 키워드는 한 번만 센다 (사업기획 ⊃ 기획)
4. 급여 정규화: 시급/일급/활동비/수수료 → 월 환산(salaryMonthly). 미기재 = "협의"(필터에서 제외하지 않음)
5. AI 적합도 채점: 1차 통과분만 Claude haiku로 0~100점 + 한 줄 이유 + 항목별 일치(B2B영업/통신산업/근무형태 등) + 경력 번역 2~3줄
   * 모델: claude-haiku 계열, 공고는 묶어서 한 번에 보냄, max_tokens 작게 (비용 최소화)
   * 키: ANTHROPIC_API_KEY (Console에서 키별 월 사용량 제한 설정)
   * 구현: scripts/score.js. @anthropic-ai/sdk의 messages.parse + zod 구조화 출력, claude-haiku-5-5, effort low, 10건씩 묶음, 하루 최대 40건(키워드 순위 상위)
   * 채점 실패(키 없음·오류·거부) 시 경고만 남기고 키워드 순위로 추천 (isScored=false)
6. 출퇴근 계산: 근무지 주소 → 좌표(카카오 로컬) → 서울은 ODsay 대중교통, 경기는 자차 길찾기 → commuteMin, commuteMode
   * 구현: scripts/commute.js. 키 KAKAO_REST_KEY(카카오 로컬 + 카카오모빌리티 자차), ODSAY_API_KEY
   * ODsay 키는 URI 방식(https://ssangku2-tech.github.io 등록). Actions IP가 매번 바뀌어 서버(IP) 키를 쓸 수 없으므로, 호출 시 앱 주소를 Referer/Origin으로 보낸다 (2026-11-10 사용자 결정)
   * AI 채점 전에 계산해 편도 한도(config commute.maxMinutes) 초과 공고를 빼서 채점 비용을 줄인다. 주소가 없거나 계산 실패한 공고는 남긴다
   * 출퇴근 단계 전체가 실패하면 경고만 남기고 출퇴근 없이 진행
7. 추천 선정: 70점 이상 점수순 최대 10건 / 5건 미만이면 60점대로 채우고 isReference=true / 동점이면 마감 D-5 이내 우선
8. 결과 JSON 저장 + (선택) 텔레그램으로 80점 이상 요약 발송
   * 구현: scripts/notify.js. 키 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. 80점 이상이 없으면 보내지 않음, 실패해도 수집 결과에 영향 없음
   * 연결 확인: 로컬 `node scripts/notify.js --test` 또는 Actions 수동 실행에서 notify_test 선택 (점수 기준 무시하고 [테스트]로 발송)

## 공통 공고 스키마

{ id, source, org, orgType, title, region, address, employType, workDays, workHours, remote, salaryText, salaryMonthly, insurance(4대보험|위촉|기타), contractTerm, ageCondition, documents, deadline, url, score, reason, matchItems[{name, level}], careerTranslation[{from, to}], commuteMin, commuteMode(transit|car), isReference }

## 화면 (디자인 시안 기준)

* 톤: 차분한 비즈니스 톤. 배경 #F5F4F0, 카드 #FFFFFF, 메인 네이비 #1F3A68, 마감임박 앰버 #A04A05
* 폰트: Noto Sans KR, 일반 크기(본문 13~16px, 제목 20~22px). 일부러 키우지 않는다
* 하단 탭 4개: 오늘 추천 · 저장·지원 · 지원사업 · 내 경력
* ① 오늘 추천: 헤더(날짜·업데이트 시각, "오늘의 추천 N건"), 요약 4칸(신규 수집/조건 일치/추천/마감 임박), 카드(기관·유형, 제목, 점수 배지, 칩[근무형태·계약·지역·D-day], 급여 굵게 + 핵심조건 한 줄, 추천 이유, "화정역 → 대중교통/자차 약 N분")
* ② 공고 상세: 적합도 막대, 경력 번역(내 경력 → 공고 언어), 근무 조건표(급여·시간·재택·계약·4대보험·연령·서류·출퇴근), 하단 버튼 [공고 원문 보기] [자기소개서 초안]. 위촉(4대보험 미적용)은 앰버색으로 강조
* ③ 내 경력: 경력 프로필 칩, 직무 키워드, 관심 산업, 조건(희망급여·4대보험·재택·출발기준·이동수단·출퇴근한도·알림)
* 터치 영역 44px 이상, 이모지 아이콘 대신 선 아이콘(SVG)

## 개발 단계

* Phase 1: PWA 골격 + 샘플 data/latest.json(예시 공고 7건)으로 3개 화면 구현, GitHub Pages 배포
* Phase 2: collect.js — 서울 열린데이터광장 소스부터 수집·정규화·필터 → Actions 크론 연결
* Phase 3: haiku 적합도 채점 + 추천 선정 규칙
* Phase 4: 출퇴근 계산 (카카오 로컬 + ODsay + 자차)
* Phase 5: 고용24·알리오 소스 추가, 저장·지원 탭, 텔레그램 알림, 지원사업 캘린더

## 작업 규칙

* 한 단계씩 진행하고, 단계마다 무엇을 왜 바꾸는지 짧게 설명할 것
* 비밀키는 .env(로컬, .gitignore) / GitHub Secrets(배포)에만. 커밋 전 키 노출 여부 확인
* 커밋·푸시는 확인받은 뒤에
