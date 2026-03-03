# docs/WORKPLAN.md
Interruption Quiz — Work Plan (Web Client + Cloud Run)

## 목표
해커톤 제출용 최소 버전(MVP1):
- Web client(React/Vite) + Cloud Run backend(Node.js)로
- barge-in(말 끊기) UX + 점수/Firestore 저장 + **Cloud Run/Logging 증빙**을 60초 데모로 재현

## SSOT(권위)
- 게임 상태/정답/점수: 서버(Cloud Run)
- 문제은행: `data/questions.json` (서버가 로드)
- 클라이언트: UI/오디오 stop(체감) + 이벤트 전송만

## MVP 단계
### MVP1 (필수 제출 - 현재 진행 중)
- [x] Web(React) + Server(Node) 모노레포 환경 세팅
- [x] Web(WSS) 클라이언트 자동 재연결 로직 및 기본 UI(상태, 점수, 타임라인) 구현
- [x] Server(WSS) 엔드포인트 및 기본 라우팅(`hello`, `start_run`, `barge_in`, `simulate_drop`) 뼈대 구축
- [ ] Firestore `scores/{userId}` 업데이트 연결
- [ ] Cloud Logging 구조화 이벤트 기록 연동
- [ ] 문제은행(`data/questions.json`) 로드 및 서버 권위 판정 고도화

### MVP2 (Gemini Live 연동 및 오디오)
- [ ] Gemini Live 오디오 출력 스트리밍을 웹으로 전달(`audio_out_chunk`)
- [ ] Web Audio 큐 재생 및 barge-in 시 오디오 큐 flush + 즉시 stop 구현
- [ ] (선택) VAD를 이용해 버튼 대신 음성으로 끊기 감지

### MVP3 (비주얼 & 디테일)
- [x] 생성된 스프라이트(`sprites/`) 에셋을 Web UI에 적용 (상태에 따른 표정 변화)
- [x] "정답!", "실패..." 텍스트 스프라이트 팝업 연출

## 인터페이스(고정)
- WSS: `wss://<cloud-run-host>/ws` (로컬은 `ws://localhost:8080/ws`)
- Client→Server: `hello`, `start_run`, `barge_in`, `simulate_drop`
- Server→Client: `state`, `question_meta`, `score`, `audio_out_chunk`, `stop_playback`
*(자세한 계약은 `docs/ARCHITECTURE.md` 참고)*

## 산출물/완료 기준(DoD)
- barge-in 2회가 1분 내 재현(오디오 stop + UI/스프라이트 상태 전환)
- Firestore에 점수 저장되는 화면 캡처 가능
- Cloud Run 로그에 이벤트가 찍힘(증빙 컷 가능)
- 데모 영상은 `docs/DEMO_SCRIPT.md`대로 촬영

## 구현 파일 위치
- `server/` : Cloud Run backend (Node.js, Express, ws)
- `web/` : React + Vite Web client (App.tsx)
- `docs/` : 아키텍처, TODO 등 기획 문서
- `data/` : 문제은행 JSON 파일
- `sprites/` : UI에 적용될 루카 캐릭터 및 텍스트 이미지 에셋
