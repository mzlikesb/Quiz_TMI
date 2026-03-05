# Quiz TMI - Interruption Quiz with Gemini Live

루카의 뇌절 퀴즈! Gemini Live API를 활용하여 실시간 음성 퀴즈와 Barge-in(말 끊기) 시스템을 구현한 프로젝트입니다.

## 📚 프로젝트 문서 (docs/)

프로젝트의 설계와 진행 상황은 `docs/` 폴더 내의 문서들을 참고하세요.

- **[TODO.md](./docs/TODO.md)**: 전체 프로젝트 통합 작업 목록 (P0~P2 우선순위 관리)
- **[TODO_SERVER.md](./docs/TODO_SERVER.md)**: 백엔드(Cloud Run) 상세 작업 목록
- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)**: 전체 시스템 구조 및 데이터 흐름
- **[CLIENT_SPEC.md](./docs/CLIENT_SPEC.md)**: 프론트엔드 요구사항 및 상태 관리 정의
- **[ONEPAGER.md](./docs/ONEPAGER.md)**: 프로젝트 요약 및 핵심 가치
- **[DEMO_SCRIPT.md](./docs/DEMO_SCRIPT.md)**: 데모 영상 시나리오 및 촬영 가이드

## 🛠️ 작업 규칙 (Mandatory)

모든 작업은 아래의 규칙을 엄격히 준수합니다.

1. **보안 우선 (No Secrets in Git)**
   - API Key, Firebase Config 등 민감한 정보는 절대로 커밋하지 않습니다.
   - `.env` 또는 `.env.local` 파일을 사용하며, 이 파일들은 `.gitignore`에 등록되어 있어야 합니다.

2. **작업 프로세스**
   - **Step 1: TODO 확인** - `docs/TODO.md`에서 다음 작업 대상을 확인합니다.
   - **Step 2: 작업 PR** - 기능별로 브랜치를 생성하여 작업 후 Pull Request를 올립니다.
   - **Step 3: 리뷰 및 머지** - 리뷰어(또는 대장)의 승인을 받은 후 머지합니다.
   - **Step 4: TODO 업데이트** - 머지가 완료되면 관련 항목을 `[x]`로 체크하여 상태를 최신화합니다.

3. **코드 스타일**
   - 서버는 Node.js (Express), 클라이언트는 React (TypeScript + Vite) 기반입니다.
   - 로그는 Google Cloud Logging에서 확인하기 쉽도록 `logEvent` 헬퍼를 사용해 구조화된 로그를 남깁니다.

## 🚀 시작하기

### 서버 (server/)
```bash
cd server
npm install
npm start
```

### 클라이언트 (web/)
```bash
cd web
npm install
npm run dev
```
