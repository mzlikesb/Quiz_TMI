# docs/ARCHITECTURE.md
Interruption Quiz — System Architecture (Unity + Cloud Run + Gemini Live + Firestore)

## 목적
- **실시간 음성(양방향) + barge-in(말 끊기)**를 “게임 규칙”으로 만든다.
- “대화 데모”가 아니라 **게임 엔진(정답/점수) + 저장(리더보드) + 운영(로그/복구)**가 있는 프로젝트로 만든다.

---

## 1) 구성 요소
### Unity Client
- 마이크 캡처 → 오디오 스트리밍 송신
- 서버에서 받은 오디오 재생(버퍼 포함)
- **barge-in 감지**(VAD/단축키/버튼) 후 즉시 로컬 재생 중단
- UI 상태 표시: `Listening / Speaking / Interrupted / Judging / Scored / Error / Reconnecting`
- (옵션) 이벤트 타임라인 표시

### Cloud Run Backend (권위/SSOT)
- WebSocket 세션 관리(클라이언트 연결 유지)
- Gemini Live 세션 생성/유지(루카 음성 출력)
- **게임 엔진(SSOT)**:
  - 문제 선택, 정답 판정, 점수 계산, 중복 제출 방지
  - 타이머(문제 시작 시간) 관리
- Firestore 저장(점수/리더보드, 런 로그)
- Cloud Logging 기록(증빙/디버깅)
- 재연결/에러 처리(세션 유실 시 복구)

### Gemini Live (Luca)
- 문제 낭독 + 뇌절 멘트 + 끊겼을 때 리액션(연기)
- 정답 판정/점수 계산은 **절대 하지 않음**

### Firestore
- `scores/{userId}`: 누적 점수/최고 기록/플레이 횟수
- `runs/{runId}`(선택): 세션 이벤트 로그(증빙/분석)

---

## 2) 핵심 설계 원칙 (SSOT)
**정답/점수/시간은 서버만 믿는다.**
- LLM이 문제/정답을 “판정”하면 흔들릴 수 있으므로 금지.
- 문제은행(`assets/questions.json` 또는 Firestore `questions`)은 서버가 들고 있고,
  서버가 선택한 문제(`qId`)가 그 라운드의 권위.

---

## 3) 상태 머신(게임 플로우)
### 서버 상태(라운드 단위)
1. `IDLE`
2. `ASKING` (루카가 문제 + 선택지 + 뇌절 스트림 말하는 중)
3. `INTERRUPTED` (유저가 barge-in으로 답 제출)
4. `JUDGING` (정답 판정/점수 계산)
5. `SCORING` (Firestore 저장/클라 전송)
6. `REVEAL` (루카 리액션 + 정답 발표 1줄)
7. `NEXT` (다음 문제 준비)

### 클라이언트 상태(UX 단위)
- `Listening` (유저 입력 대기)
- `Speaking` (루카 음성 재생 중)
- `Interrupted` (유저가 끊음 → 즉시 stop)
- `Judging` (채점 중)
- `Scored` (점수 표시)
- `Reconnecting` (WS 재연결)
- `Error`

---

## 4) barge-in 처리 (지연 최소화가 핵심)
### 목표
- 유저가 “A/B/C”를 말한 순간 **0.5초 이내 체감**으로 루카 발화가 끊겨야 한다.

### 구현 전략
- **클라이언트 로컬에서 즉시 `AudioSource.Stop()`** (체감 지연 최소)
- 동시에 서버로 `barge_in` 이벤트 전송
- 서버는 Gemini Live 세션에 “현재 출력 중단”을 요청(가능한 경우)하고,
  이후에는 루카가 더 말하지 않도록 다음 단계로 전환

> 핵심: “재생 중단”은 클라이언트가 즉시, “모델 중단”은 서버가 동기화.

---

## 5) 통신 프로토콜 (Client ↔ Cloud Run, WebSocket)
모든 메시지는 JSON 프레임(바이너리는 오디오 청크만 별도 프레임로 처리 가능).

### Client → Server
- `hello`
  - `{ "type":"hello", "userId":"u123", "displayName":"Mint", "clientVersion":"0.1" }`
- `start_run`
  - `{ "type":"start_run" }`
- `audio_in_chunk` *(선택: 음성 인식 서버 처리 시 필요)*
  - `{ "type":"audio_in_chunk", "codec":"pcm16", "seq":12, "ts":..., "data":"<base64>" }`
- `barge_in`
  - `{ "type":"barge_in", "runId":"r789", "answer":"A", "t_ms": 1830 }`
- `simulate_drop` *(데모용 디버그)*
  - `{ "type":"simulate_drop" }`

### Server → Client
- `state`
  - `{ "type":"state", "value":"speaking|interrupted|judging|scored|reconnecting|error" }`
- `question_meta`
  - `{ "type":"question_meta", "runId":"r789", "qId":"q012", "startedAt": 1710000000 }`
- `audio_out_chunk` *(루카 음성)*
  - `{ "type":"audio_out_chunk", "codec":"pcm16", "seq":34, "data":"<base64>" }`
- `score`
  - `{ "type":"score", "runId":"r789", "delta":145, "total":980, "correct":true, "elapsed_ms": 820 }`
- `leaderboard` *(선택)*
  - `{ "type":"leaderboard", "top":[{"name":"Mint","score":980}, ...] }`
- `stop_playback` *(선택: 클라 로컬 stop과 동기화용)*
  - `{ "type":"stop_playback" }`

---

## 6) 점수 계산(서버 권위)
### 입력
- `elapsed_ms = now_ms - question_started_ms`
- `correct = (answer == question.answer)`

### 예시 룰(단순/데모 친화)
- 정답:
  - `base = 100`
  - `speed_bonus = max(0, 80 - floor(elapsed_ms / 250)*5)`
  - `delta = base + speed_bonus`
- 오답:
  - `delta = 0`

### 중복 제출 방지
- `runId`당 첫 `barge_in`만 인정
- 이후 들어오는 `barge_in`은 무시하거나 “already_answered” 응답

---

## 7) 문제은행 관리
- 서버 파일: `assets/questions.json` (정적 배포가 가장 단순)
- 또는 Firestore `questions` 컬렉션(관리 편리)

### 필드
- `id, category, difficulty, question, choices(A/B/C), answer, explain, tmi_stream[], reaction_on_interrupt[]`

---

## 8) Firestore 스키마(최소)
### scores/{userId}
- `userId: string`
- `displayName: string`
- `totalScore: number`
- `bestScore: number`
- `plays: number`
- `updatedAt: timestamp`

### runs/{runId} (선택)
- `userId: string`
- `qId: string`
- `startedAt: timestamp`
- `answer: "A"|"B"|"C"`
- `correct: bool`
- `elapsedMs: number`
- `scoreDelta: number`
- `createdAt: timestamp`

---

## 9) 로그(Cloud Logging) — 제출 증빙 포인트
서버는 최소 아래 이벤트를 구조화 로그로 남긴다.
- `session_connected`, `session_disconnected`
- `question_start (runId, qId)`
- `barge_in (runId, answer, elapsed_ms)`
- `judge_result (correct, delta)`
- `score_saved (userId, totalScore)`
- `reconnect_attempt (n)`

> 데모 영상에서 Logging 화면을 2~3초 보여주면 “GCP에서 운영” 증빙이 쉬움.

---

## 10) 장애/복구(필수 최소)
### WebSocket 끊김
- 클라이언트: `Reconnecting...` 표시 후 재시도(지수 백오프)
- 서버: 재접속 시 `hello(userId)`로 세션 재구성
- 라운드 진행 중 끊기면:
  - 최소 버전: 해당 run을 종료하고 새 run 시작
  - (옵션) run 상태를 Firestore에 저장해 재개

### Gemini Live 오류
- 서버가 “fallback 문구(짧은 음성/텍스트)”로 클라에 안내 후 다음 문제로 스킵
- 오류를 Logging에 남겨 데모에서 “운영 감각” 어필

---

## 11) 배포 구조(권장)
- Cloud Run 1개 서비스:
  - `/ws` : WebSocket endpoint
  - (옵션) `/health` : 헬스체크
  - (옵션) `/admin` : 문제은행 갱신(개발용)

---

## 12) 보안/프라이버시 최소 원칙
- 사용자 식별은 `userId`(임의 문자열)로 충분 (개인정보 수집 최소)
- 음성 원본 저장은 MVP에서 하지 않음
- 저장하는 것은 점수/이벤트 로그(필요 최소)만

---