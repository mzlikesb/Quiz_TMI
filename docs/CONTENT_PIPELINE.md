# docs/CONTENT_PIPELINE.md
Interruption Quiz — Content Pipeline (Question Bank + Luca Prompts)

## 목적
이 프로젝트에서 **문제 생성은 LLM(루카)**가 담당할 수 있지만, **정답 판정의 권위(SSOT)**는 반드시 서버(Cloud Run)와 문제은행이 갖는다.

- 루카: 문제/뇌절 멘트/리액션 생성, 진행(낭독/리액션)
- 서버: 문제 선택/정답 판정/점수 계산/저장, 이벤트 로그

이 분업을 지키면 데모가 흔들리지 않는다.

---

## 1) 문제은행(JSON) 스키마
문제는 3지선다(A/B/C) 고정. 정답/해설 포함.

```json
{
  "id": "q001",
  "category": "general|science|history|pop|korea|tech",
  "difficulty": 1,
  "question": "문제 본문(한국어)",
  "choices": {"A":"...", "B":"...", "C":"..."},
  "answer": "A|B|C",
  "explain": "정답 해설 1~2문장",
  "tmi_stream": [
    "뇌절 멘트 1 (짧게, 5~12단어)",
    "뇌절 멘트 2",
    "뇌절 멘트 3"
  ],
  "reaction_on_interrupt": [
    "유저가 끊으면 나오는 리액션 1(짧게)",
    "리액션 2"
  ]
}
## 2) 문제 생성 → 검수 → 배포 플로우
1. **문제 생성 (루카)**
   - 대장이 루카에게 프롬프트를 주면, 루카가 `tmi_stream`과 `reaction_on_interrupt`가 포함된 문제를 생성.
   - 예: "루카, '과일' 카테고리로 뇌절 퀴즈 5개 만들어줘."
2. **검수 (서버/관리자)**
   - **금칙어 필터링**: 모욕, 혐오, 정치, 스포일러 등 부적절한 단어 검사.
   - **중복 검사**: 기존 문제은행(`assets/questions.json` 또는 Firestore)에 동일한 문제가 있는지 확인.
   - **JSON 스키마 검증**: 필수 필드 누락 검사.
3. **배포 (서버)**
   - 검수를 통과한 문제를 문제은행에 추가.
   - 서버를 재시작하거나, Firestore를 사용하여 런타임에 동적으로 반영.
