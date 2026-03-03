# docs/DEPLOY_NOTES.md
Interruption Quiz — Deploy & Runtime Notes (Cloud Run + WebSockets + Live Audio)

## 0) TL;DR (데모가 안 터지게 하는 3가지)
1) **Cloud Run request timeout을 60분으로 올리기**(기본 5분이라 WS가 끊김)
2) **클라이언트 자동 재연결**(끊김은 전제로 설계)
3) **오디오는 PCM16 기반으로 단순하게**(입력 16k mono, 출력 24k)

---

## 1) Cloud Run + WebSocket: 반드시 알아야 할 것들

### 1.1 WebSocket은 Cloud Run에서 “긴 HTTP 요청” 취급
- Cloud Run은 WebSocket 연결을 “긴 요청”처럼 취급해서 **request timeout**이 적용됨.
- 기본이 짧으면(기본값) **연결이 강제로 끊김**.

### 1.2 request timeout 올리기 (권장: 3600s)
#### gcloud
```bash
gcloud run services update <SERVICE_NAME> --timeout=3600
## 2) Cloud Run 상세 설정 (안정성)
### 2.1 Concurrency (동시성)
- 기본 80, 최대 1000. WebSocket 연결이 많아질 경우 `concurrency` 값을 늘려야 함. 데모용으로는 80도 충분.

### 2.2 Min Instances (최소 인스턴스)
- 콜드 스타트 지연을 피하려면 `min-instances`를 1 이상으로 설정.
- `gcloud run services update <SERVICE_NAME> --min-instances=1`

### 2.3 Keepalive (연결 유지)
- WebSocket 연결이 유휴 상태일 때 끊어지지 않도록 서버/클라이언트 양쪽에서 정기적으로 Ping/Pong(또는 더미 메시지) 전송.

### 2.4 재연결(Reconnect) 전략
- 클라이언트(Web)에서 연결 끊김 감지 시 지수 백오프(Exponential Backoff)를 적용하여 재연결 시도 (예: 1초, 2초, 4초, 8초...).
