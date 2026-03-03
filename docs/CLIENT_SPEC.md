# docs/CLIENT_SPEC.md
Interruption Quiz — Web Client Spec (Minimal, Hackathon)

## 목표
Web 프론트엔드는 “게임”이 아니라 **실시간 음성 UX + barge-in 체감 + 상태 시각화**를 책임진다.

**클라이언트 책임**
- 마이크 입력 캡처
- 서버로 오디오/이벤트 전송 (WSS)
- 서버에서 받은 루카 오디오 재생
- **barge-in(말 끊기)**: 유저가 말하면 즉시 루카 재생을 멈추고 답(A/B/C)을 전송
- 상태 UI/타임라인 표시
- 재연결/오류 UX

**클라이언트가 하지 않는 것**
- 정답 판정/점수 계산(서버 권위)
- 문제 선택(서버 권위)
- 문제은행 생성(루카가 생성 가능하되 서버에 저장)

---

## 1) 타겟 플랫폼(권장)
### 1차(권장): Desktop(Windows/macOS)
- 마이크 권한/오디오 장치가 비교적 안정적
- 데모 녹화 편함

### 2차(선택): Quest/Android
- 마이크 권한/오디오 경로가 변수가 더 큼
- 해커톤 MVP에선 1차 완료 후 추가

---

## 2) 화면(UI) 구성 (한 화면, 한 눈에)
### 필수 UI 요소
- **Status Badge**: `Listening | Speaking | Interrupted | Judging | Scored | Reconnecting | Error`
- **Score Panel**: `delta`, `total`, `best` (서버에서 받은 값)
- **Big Buttons**:
  - `Start Run`
  - `Stop / Reset`
  - `A / B / C` (디버그/백업 입력)
- **Mic Level Meter** (barge-in이 왜 발생했는지 “보이게”)
- (선택) **Event Timeline**: 최근 8~12개 이벤트
  - 예: `question_start → speaking → barge_in(A) → judging → scored(+145)`

### 데모 친화 규칙
- barge-in이 발생하면 UI가 확실히 바뀌어야 함:
  - `Speaking → Interrupted → Judging → Scored`
- 오디오도 확실히 “뚝” 끊겨야 함(Stop이 체감되어야 함)

---

## 3) 클라이언트 상태 머신
### 상태 정의
- `Idle`: 시작 전
- `Listening`: 유저 입력 대기(또는 유저 발화 감지 대기)
- `Speaking`: 루카 음성 재생 중
- `Interrupted`: 유저가 끊어서 로컬 재생을 중단한 순간(짧게)
- `Judging`: 서버 채점 대기
- `Scored`: 점수 표시(짧게)
- `Reconnecting`: WSS 재연결 중
- `Error`: 치명 오류(재시도 버튼 제공)

### 상태 전이(요약)
- `Idle → Listening` : Start Run
- `Speaking → Interrupted` : barge-in 감지(유저 발화 or A/B/C 버튼)
- `Interrupted → Judging` : 서버로 `barge_in` 전송 완료
- `Judging → Scored` : 서버 `score` 수신
- `* → Reconnecting` : WSS 끊김 감지
- `Reconnecting → Listening` : 재연결 성공

---

## 4) 오디오 파이프라인(최소 안정 버전)
### 입력(Mic)
- 샘플레이트: 16kHz 또는 24kHz (서버/Live API와 맞춤)
- 포맷: PCM16 권장(단순, 디버그 쉬움)
- 버퍼 크기: 20ms~60ms 단위 청크(너무 작으면 오버헤드, 너무 크면 지연)

### 출력(Speaker)
- `AudioSource`로 재생
- 재생 버퍼(큐) 운영:
  - 수신 `audio_out_chunk`를 큐에 넣고 순서대로 재생
  - **barge-in 발생 시**: 큐를 즉시 비우고 `AudioSource.Stop()` 호출

### barge-in 체감 최적화(핵심)
- “모델 중단”보다 **클라이언트 로컬 Stop이 먼저**
- 순서:
  1) `AudioSource.Stop()` + 오디오 큐 Clear
  2) 상태 `Interrupted`
  3) 서버에 `barge_in(answer)` 전송

---

## 5) barge-in 감지 방식 (MVP 권장 2단계)
### 5.1 데모/안정용: 음성 + 버튼 혼합
- **음성 VAD 감지** + **A/B/C 버튼 백업**
- 데모 때 음성 인식이 애매하면 버튼으로 즉시 수습 가능

### 5.2 간단 VAD(에너지 기반) 스펙
- RMS/에너지 계산(20~30ms 프레임)
- 임계치(threshold) 초과가 `150~250ms` 지속되면 “발화 시작”으로 판단
- 발화 시작 시:
  - `Speaking` 상태이면 즉시 barge-in 트리거(오디오 Stop)
- 발화 종료 판단은 MVP에선 필수 아님(정답 제출만 중요)

> 주의: 주변 소음이 큰 환경이면 threshold가 흔들리니, UI에서 threshold를 슬라이더로 조절 가능하게 하면 좋음(디버그용).

### 5.3 정답 입력(강제 단순화)
- 유저 답은 “A/B/C”만 허용
- 음성으로 A/B/C 추출이 불안하면:
  - “A/B/C 버튼”을 보조 채널로 제공
- **정답 판정은 서버** (클라는 “사용자가 무엇을 제출했는지”만 보냄)

---

## 6) 네트워크(WSS) 스펙
### 연결
- Cloud Run WSS endpoint: `/ws`
- 연결 직후 `hello(userId, displayName, clientVersion)` 송신
- 서버 `state` 수신으로 클라 상태 동기화

### 재연결 정책(필수)
- 연결 끊김 감지 시:
  - 상태 `Reconnecting`
  - 지수 백오프: 0.5s → 1s → 2s → 4s (최대 4~8s)
- 재연결 성공 시:
  - 다시 `hello`
  - 서버가 “새 run 시작”을 요구하면 클라가 UI에 표시

### 데모용 디버그
- `Simulate Drop` 버튼:
  - 로컬에서 소켓 강제 Close(또는 서버에 simulate_drop 요청)
  - `Reconnecting…` 흐름을 영상에서 확실히 보여주기 위함

---

## 7) 이벤트 타임라인(프로젝트성 강화)
클라에서 최근 이벤트를 8~12개 표시(텍스트 박스가 아니라 “시스템 로그” 느낌).

**권장 이벤트**
- `question_start(qId)`
- `speaking_start`
- `barge_in(answer)`
- `stop_playback(local)`
- `judging`
- `scored(+delta)`
- `score_total(total)`
- `ws_disconnected / ws_reconnected`

> 심사/시청자 입장에서 “barge-in이 실제로 구현됐다”가 한 눈에 보임.

---

## 8) 최소 파일/씬 구조(권장)
- `Scenes/Main.unity`
- `Scripts/`
  - `WsClient.cs` (WSS 연결/메시지 라우팅)
  - `AudioIn.cs` (Mic 캡처/청크 생성)
  - `AudioOut.cs` (수신 오디오 큐/재생/Stop)
  - `VAD.cs` (RMS 기반 감지)
  - `UIController.cs` (상태/점수/타임라인)

---

## 9) 데모 성공 기준(클라 관점)
- [ ] `Speaking` 중 유저 발화(또는 버튼)로 **즉시 재생 중단**이 체감됨
- [ ] 상태가 `Interrupted → Judging → Scored`로 깔끔히 바뀜
- [ ] 라운드 2회 연속 재현 가능(재현성)
- [ ] (선택) Simulate Drop으로 `Reconnecting…` 한 번 시연 가능
- [ ] 마이크 레벨 미터가 움직여 “라이브” 느낌이 남

---

## 10) 구현 순서(클라 단독 기준)
1) UI(상태/점수/버튼) 뼈대
2) WSS 연결 + `state/score` 메시지 수신만
3) AudioOut(오디오 재생) → **Stop 즉시 동작 확인**
4) VAD 붙이기(임계치 조절 UI 포함)
5) barge-in 이벤트 전송 + 타임라인 표시
6) 재연결/Simulate Drop 추가

---