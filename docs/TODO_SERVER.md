# docs/TODO_SERVER.md
Interruption Quiz — Server (Cloud Run) TODO (Minimal, Hackathon)

> 목표: **Web 프론트엔드와 WSS로 연결**되고, **Gemini Live로 루카 음성**을 흘려주며,  
> **barge-in → 채점 → Firestore 저장**까지 60초 데모 루프로 재현 가능하게 만든다.

---

## P0 — 반드시(데모 성립/제출 가능)

### S0-01 프로젝트/환경 변수 설계
- [x] `.env.example` 작성
  - `GCP_PROJECT_ID`
  - `FIRESTORE_DATABASE`(선택)
  - `VERTEX_LOCATION`(예: `us-central1`)
  - `GEMINI_MODEL`(Live 모델명)
  - `ALLOWED_ORIGINS`(개발용)
- [x] 런타임에서 Secret/Env로 주입(키/자격정보는 클라에 넣지 않음)
- 완료 기준: 로컬/Cloud Run에서 동일하게 실행 가능

### S0-02 Cloud Run 서비스 스켈레톤
- [x] HTTP 서버 부팅 + `/health` 엔드포인트
- [x] 구조화 로깅 도입(최소 `event`, `runId`, `userId`)
- 완료 기준: Cloud Run에 배포되고 `/health` OK + Logging에 부팅 로그

### S0-03 WebSocket 엔드포인트 `/ws`
- [x] WSS 업그레이드 처리
- [x] 연결 시 `session_connected` 로그 남기기
- [x] ping/pong(또는 idle timeout 대비)
- [x] Web UI 연결/재연결 통합 테스트 확인
- 완료 기준: Web UI에서 WSS 연결 성공

### S0-04 메시지 라우터 구현(JSON 프레임)
- [x] 수신 메시지 타입 분기:
  - `hello`
  - `start_run`
  - `barge_in`
  - `simulate_drop`(데모용)
- [x] 송신 메시지 헬퍼:
  - `state`
  - `question_meta`
  - `audio_out_chunk`
  - `score`
- [x] Web UI `state/score` 수신 반영 동작 확인
- 완료 기준: 더미 상태/메타를 Web UI에 보낼 수 있음

### S0-05 세션/런 상태 저장(메모리 기반)
- [ ] `Session` 구조체:
  - `userId`, `displayName`, `ws`
  - `currentRunId`, `questionStartedAtMs`
  - `currentQuestion`(qId/answer/choices/tmi)
  - `answered` 플래그
  - `liveSessionHandle`(Gemini Live)
- 완료 기준: start_run → runId 생성/저장

### S0-06 문제은행 로딩(SSOT)
- [x] `assets/questions.json` 로드(서버 시작 시 1회)
- [x] 문제 선택 함수:
  - 랜덤 또는 순차(데모는 2문제만 반복해도 OK)
- 완료 기준: `start_run` 시 `qId`가 정해짐

### S0-07 Gemini Live 세션 연결(서버) — “루카 말하기” 최소 구현
- [ ] start_run 시:
  - `state: speaking`
  - Live에 “문제 + 선택지 + tmi_stream 일부” 말하게 요청
- [ ] Live 오디오 출력 수신 → Web UI에 `audio_out_chunk` 전달
- 완료 기준: Web UI에서 루카 음성이 실제로 들림(1문제)

> 주의: “정답 판정”은 Live가 하지 않음. 말하기만.

### S0-08 barge_in 처리(서버)
- [ ] 첫 `barge_in`만 인정(중복 제출 방지)
- [ ] `elapsed_ms` 계산: `now - questionStartedAtMs`
- [ ] `state: interrupted → judging`
- [ ] (가능하면) Live 출력 중단 요청 or 다음 발화 금지
- 완료 기준: Web barge-in 후 서버가 판단 단계로 넘어감

### S0-09 채점/점수 계산(서버 권위) + Firestore 저장
- [ ] 정답 비교: `answer == currentQuestion.answer`
- [ ] 점수 룰 구현:
  - `base=100`
  - `speed_bonus=max(0, 80 - floor(elapsed_ms/250)*5)`
  - `delta=base+speed_bonus` (정답일 때)
- [ ] Firestore 업데이트:
  - `scores/{userId}` totalScore 증가, plays 증가, bestScore 갱신, updatedAt
- [ ] Web UI에 `score {delta,total,correct,elapsed_ms}` 전송
- 완료 기준: Firestore 문서가 실제 갱신 + Web 점수 표시

### S0-10 루카 리액션(짧게) + 다음 라운드 준비
- [ ] 채점 후:
  - Live에 “reaction_on_interrupt 1줄 + 정답 발표 1줄” 말하기 요청(짧게)
  - `state: scored`
- [ ] 데모용으로 2문제 루프만 구현
- 완료 기준: 라운드 2회 연속 재현 가능

---

## P1 — 강력 추천(운영감/심사 인상 상승)

### S1-01 Cloud Logging 이벤트 표준화(구조화)
- [ ] 아래 이벤트를 통일된 필드로 기록:
  - `session_connected`, `session_disconnected`
  - `question_start(runId,qId)`
  - `barge_in(runId,answer,elapsed_ms)`
  - `judge_result(correct,delta)`
  - `score_saved(userId,totalScore)`
  - `reconnect_attempt(n)`
- 완료 기준: Logging 화면에서 흐름이 한 눈에 보임(영상용)

### S1-02 Firestore `runs/{runId}` 로그 저장(선택)
- [ ] run별 기록 저장:
  - qId, answer, correct, elapsedMs, scoreDelta, createdAt
- 완료 기준: “아키텍처/데이터” 어필 강화

### S1-03 재연결 전략(세션 복구 최소)
- [ ] 클라이언트 재접속 시 `hello(userId)`를 받으면:
  - 새 ws로 세션 바인딩 교체
  - 진행 중이던 run은 “종료 처리”하고 새 run 유도(최소 버전)
- 완료 기준: 끊겨도 다시 시작 가능(데모 안정)

### S1-04 Live 오류/타임아웃 핸들링
- [ ] Live 연결 실패/응답 끊김 시:
  - `state: error` 전송
  - “fallback 안내” (짧은 텍스트/오디오)
  - 다음 문제로 스킵
- 완료 기준: 데모에서 망가지지 않고 복구 가능

---

## P2 — 있으면 멋짐(시간 남을 때만)

### S2-01 리더보드 쿼리 API
- [ ] `get_leaderboard` 메시지 처리
- [ ] Firestore에서 top N 가져와 Web로 전송
- 완료 기준: 리더보드 UI 구현 가능

### S2-02 문제 생성 파이프라인(루카 생성 → 검수 → 저장)
- [ ] `/admin/import_questions` 같은 개발용 엔드포인트
- [ ] JSON schema 검증 + 금칙어 필터 + 중복 검사(간단)
- 완료 기준: 문제은행을 확장 가능

### S2-03 멀티 카테고리/난이도 선택
- [ ] `start_run`에 `category/difficulty` 옵션 추가
- 완료 기준: 데모 확장용

---

## 배포/운영 체크리스트(최종)
- [ ] Cloud Run이 WSS를 안정적으로 유지(타임아웃/keepalive)
- [ ] Firestore 쓰기 권한(Service Account) 정상
- [ ] Live 세션 오류 시에도 서버가 죽지 않음
- [ ] Logging에 핵심 이벤트가 남아 “배포 증명” 가능
- [ ] 4분 데모에서 barge-in 2회 + 점수 저장 + 로그 컷 확보

---
