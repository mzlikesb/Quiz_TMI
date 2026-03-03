# docs/ONEPAGER.md

## 프로젝트명
**The Interruption Quiz — Luca Barge-In Trivia**

## 한 줄 소개
루카가 “뇌절(쓸데없는 말)”을 하며 문제를 내고, 사용자는 **대화 중간에 끊어(barge-in)** 정답을 외쳐야 점수를 얻는 **저지연 실시간 음성 퀴즈**.

## 왜 이게 ‘프로젝트’인가 (SDK 데모 탈출 포인트)
- 단순 음성 대화가 아니라 **게임 룰(타이밍 기반) + 점수/랭킹(영속 DB) + 이벤트 로그(아키텍처)**가 있다.
- barge-in이 옵션이 아니라 **승리 조건**이다. (끊어야만 점수를 얻음)

---

## 핵심 UX (60초 데모 루프)
1) 루카가 문제를 내며 일부러 TMI로 떠듦(“뇌절 스트림”)
2) 사용자는 기다리면 손해. **중간에 끊고 정답을 외침**
3) 루카는 즉시 멈추고(오디오 중단), “악! 내 말—” 리액션
4) 정답 판정 + 점수 반영
5) Firestore 리더보드/세션 로그 저장 (GCP 증빙 겸)

---

## 게임 규칙 (MVP)
### 문제 형태
- **3지선다(A/B/C)** 고정 (판정 안정성 위해)
- 문제/정답은 **서버의 문제은행**이 권위(SSOT: single source of truth)

### 입력(유저)
- 음성으로 **“A / B / C”**를 외쳐서 buzzer + 답 제출
- (안전장치) 인식이 애매할 때를 대비해 UI에 A/B/C 버튼을 **디버그/백업으로** 제공 (데모는 음성 중심)

### 점수
- 정답이면: `base(100) + speed_bonus`
- speed_bonus 예시: `max(0, 80 - floor(elapsed_ms / 250)*5)`
  - 즉, **빠를수록 더 큼**
- 오답이면: 0점
- 1문제당 1회만 채점(중복 제출 방지)

### barge-in 정의
- 루카가 말하는 도중 유저가 발화 시작(또는 답 확정) → **즉시 루카 오디오 stop + 새 턴 처리**
- 시각적으로 `INTERRUPTED → JUDGE → SCORE` 타임라인이 찍혀야 한다.

---

## 필수 기능 명세 (제출 가능한 최소)
### Client (Unity)
- 마이크 캡처 + 오디오 스트리밍 송신
- 루카 응답 오디오 재생 + **즉시 중단(Stop)**
- 상태 UI: `Listening / Speaking / Interrupted / Judging / Error / Reconnecting`
- (선택) 이벤트 타임라인: `question_start`, `barge_in`, `judge`, `score`

### Backend (Cloud Run)
- WebSocket 세션 유지
- Gemini Live 세션 생성/유지(루카 음성 출력)
- 문제은행/정답 판정/점수 계산(서버 권위)
- Firestore에 점수/랭킹 저장
- Cloud Logging에 핵심 이벤트 로깅(증빙)

### Storage (Firestore)
- `scores/{userId}`: 누적 점수, 최고 기록, 마지막 플레이
- `runs/{runId}`: 세션 이벤트(선택, 디버깅/증빙용)
- `leaderboard`는 `scores` 컬렉션 쿼리로 구성

---

## 기술 스택 (포트폴리오/증빙용)
- **Unity**: 클라이언트(UI + 오디오 I/O)
- **Google Cloud Run**: 백엔드 호스팅
- **Gemini Live API (Vertex AI)**: 실시간 음성(루카)
- **Firestore**: 점수/리더보드 저장 (GCP 서비스 사용 명확)
- **Cloud Logging**: 운영/증빙

---

## 아키텍처(요약)
```mermaid
flowchart LR
  U[Unity Client\nMic In / Audio Out\nBarge-in + UI] -->|WSS| R[Cloud Run\nSession + Game Engine\nScoring + Judge]
  R -->|Live WS| G[Gemini Live\nLuca Voice Output]
  R --> F[(Firestore)\nScores + Runs]
  R --> L[(Cloud Logging)]
  G --> R --> U