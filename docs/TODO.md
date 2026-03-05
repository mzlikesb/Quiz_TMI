# docs/TODO.md
Interruption Quiz — Web + Cloud Run Implementation Tasks (Minimal)

> 목표: **실시간 음성 + barge-in + 점수 저장(Firestore)**를 60초 데모 루프로 재현 가능하게 만든다.
> 우선순위는 “데모 재현성” 기준. 각 티켓은 가능한 작게 쪼갠다.

---

## P0 — 반드시(데모 성립/제출 가능)

### T0-01 Repo/문서 뼈대 정리
- [x] `docs/ONEPAGER.md`, `docs/DEMO_SCRIPT.md`, `docs/ARCHITECTURE.md`, `docs/CLIENT_SPEC.md`, `docs/CONTENT_PIPELINE.md` 추가
- [x] `assets/questions.json` 자리(빈 파일) 생성
- 완료 기준: repo에 문서/폴더 구조가 잡힘

### T0-02 GCP 프로젝트 기본 세팅
- [x] GCP Project 생성, Vertex AI/Gemini Live 사용 권한 확인
- [x] Firestore(네이티브 모드) 생성
- [x] Cloud Run 서비스 생성(Hello/health)
- 완료 기준: Cloud Run URL 접근 + Firestore 콘솔 접근

### T0-03 Cloud Run WebSocket 엔드포인트 스켈레톤
- [x] `/ws` WebSocket 핸들러 구현(hello 메시지 수신/응답)
- [x] `state` 메시지 브로드캐스트(임시 더미)
- [x] Cloud Logging에 `session_connected` 기록
- 완료 기준: Web UI에서 WSS 연결 성공 + `state` 수신

### T0-04 Web UI/기본 UI 구축
- [x] 상태 배지(Status Badge) + 점수 패널 + Start/Reset 버튼
- [x] A/B/C 버튼(백업 입력)
- [x] 이벤트 타임라인 UI(최근 10개)
- 완료 기준: UI만으로 상태/점수/이벤트 표시 가능

### T0-05 Web WSS 클라이언트 연결/재연결
- [x] WSS 연결 + `hello(userId, displayName, version)` 전송
- [x] 서버 `state/score` 수신 처리
- [x] 재연결(지수 백오프) + `Reconnecting…` 상태 표시
- [x] `Simulate Drop` 버튼(소켓 강제 close)
- 완료 기준: 끊었다가 자동 복구되는 UX 시연 가능

### T0-06 문제은행 로딩 + 문제 선택(서버 권위)
- [x] `assets/questions.json` 로드(서버)
- [x] `start_run` 요청 시 `qId/runId/startedAt` 생성
- [x] `question_meta`를 클라이언트로 전송
- 완료 기준: Web UI에 `qId/runId` 표시됨

- [x] T0-07 Gemini Live 연결(서버) + 루카 음성 출력(클라 재생)
- [ ] Cloud Run에서 Live 세션 열고 “문제+선택지+뇌절” 말하게 함
- [ ] Live 오디오 출력 스트림을 Web로 전달(`audio_out_chunk`)
- [ ] Web `AudioOut` 큐 재생 구현
- 완료 기준: 루카 음성이 Web UI에서 들린다(지연이 크더라도 OK)

- [x] T0-08 barge-in 핵심(로컬 즉시 stop + 서버 답 제출)
- [ ] Web: `Speaking` 중 사용자 입력(A/B/C 버튼) → **즉시 AudioSource.Stop + 큐 Clear**
- [ ] 서버로 `barge_in(answer, t_ms)` 전송
- [ ] UI 상태 전이: `Speaking → Interrupted → Judging`
- 완료 기준: 버튼으로 barge-in이 확실히 “뚝” 끊김

- [x] T0-09 채점/점수 계산(서버) + Firestore 저장
- [ ] 서버: `elapsed_ms` 계산( startedAt 기준)
- [ ] 정답 비교 + 점수(delta/total) 계산
- [ ] Firestore `scores/{userId}` 업데이트(누적/최고/횟수)
- [ ] Web: `score` 수신 → `Scored` 표시 + 누적 점수 갱신
- 완료 기준: Firestore 문서가 실제로 업데이트되고 Web UI에 반영됨

- [x] T0-10 루카 리액션(서버) + 다음 라운드 준비
- [ ] 채점 후 루카가 짧은 리액션 + “오케이 채점!” 출력(짧게)
- [ ] 데모는 2문제만 반복되면 충분(연속 라운드 2회)
- 완료 기준: barge-in 2회 시나리오가 끊김 없이 연속 재현

---

## P1 — 강력 추천(바닐라 탈출/심사 인상 상승)

### T1-01 VAD(에너지 기반) barge-in 트리거 추가
- [ ] Mic 입력 RMS 계산 + threshold 슬라이더
- [ ] `Speaking` 중 발화 감지되면 barge-in(단, 정답 제출은 버튼/음성 A/B/C 인식 중 택1)
- 완료 기준: “말 끊기”가 버튼 없이도 시연 가능(완벽하지 않아도 됨)

### T1-02 이벤트 타임라인 표준화
- [ ] `question_start → speaking → barge_in → judging → scored → score_saved`
- [ ] 서버 이벤트를 클라에 보내 타임라인을 “근거” 있게
- 완료 기준: 영상에서 barge-in 흐름이 한 눈에 보임

### T1-03 Cloud Logging 구조화 로그
- [ ] JSON 형태로 이벤트 로그 남기기
- [ ] 데모 영상에서 로그 스트림을 2~3초 보여주기 쉽도록 키 필드 통일
- 완료 기준: Logging 화면에서 “게임이 운영된다”가 보임

### T1-04 안전한 뇌절 톤 가드레일
- [ ] 시스템 프롬프트에 “모욕/혐오/성적/정치 금지, 짧게, 스포일러 금지” 고정
- 완료 기준: 루카가 과하게 나가지 않고 안정적으로 코믹함 유지

---

## P2 — 있으면 멋짐(시간 남을 때만)

### T2-01 리더보드 UI
- [ ] Firestore 상위 N명 쿼리 + Web UI에 표시
- 완료 기준: “프로젝트성” 상승(포폴 예쁨)

### T2-02 runs 로그 저장 + 간단 리플레이
- [ ] `runs/{runId}` 저장(답, 시간, 점수)
- [ ] Web UI에서 최근 3회 기록 보기
- 완료 기준: “아키텍처/데이터” 어필 강화

### T2-03 문제 생성 파이프라인(루카 생성 → 서버 저장)
- [ ] `CONTENT_PIPELINE.md`의 루카 프롬프트로 문제 생성
- [ ] JSON 검증/중복 체크(간단)
- 완료 기준: “콘텐츠 생성도 에이전트로” 어필 가능

---

## 데모/제출 체크리스트(최종)
- [ ] barge-in 2회 연속 재현(오디오 즉시 stop)
- [ ] 점수 반영 + Firestore 저장 화면 컷
- [ ] Cloud Run 로그/콘솔 컷
- [ ] 4분 영상 완성(대본대로)
- [ ] README 실행/배포 방법 정리

---
