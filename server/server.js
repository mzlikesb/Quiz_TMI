const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { startLiveSpeak } = require("./live");
const { updateScore, getScore, saveRun } = require("./firestore");

const PORT = Number(process.env.PORT || 8080);
const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "interruption-quiz-server",
    ts: new Date().toISOString(),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 10 }); // Issue #7: 10KB 제한
const sessions = new Map();
const QUESTIONS_FILE_PATH = path.join(__dirname, "data", "questions.json");
let questionBank = [];

function loadQuestionBank() {
  const raw = fs.readFileSync(QUESTIONS_FILE_PATH, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("question_bank_empty_or_invalid");
  }

  return parsed;
}

function selectRandomQuestion() {
  const index = Math.floor(Math.random() * questionBank.length);
  return questionBank[index];
}

function logEvent(event, data = {}) {
  const payload = {
    severity: "INFO",
    event,
    runId: data.runId || null,
    userId: data.userId || null,
    ...data,
    ts: new Date().toISOString(),
  };
  console.log(JSON.stringify(payload));
}

function sendFrame(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getOrCreateSession(ws) {
  if (!sessions.has(ws)) {
    sessions.set(ws, {
      userId: null,
      displayName: null,
      version: null,
      currentRunId: null,
      questionStartedAtMs: null,
      currentQuestion: null,
      answered: false,
      lastRunAtMs: 0,
      isAlive: true,
      liveSession: null,   // Gemini Live 세션 핸들
    });
  }
  return sessions.get(ws);
}

function handleMessage(ws, raw) {
  const session = getOrCreateSession(ws);
  let msg;

  try {
    msg = JSON.parse(raw.toString());
  } catch (_err) {
    sendFrame(ws, "state", { state: "error", reason: "invalid_json" });
    return;
  }

  const { type } = msg;
  switch (type) {
    case "hello": {
      session.userId = msg.userId || "anonymous";
      session.displayName = msg.displayName || "Anonymous";
      session.version = msg.version || null;

      logEvent("hello_received", {
        userId: session.userId,
        version: session.version,
      });

      // Firestore에서 기존 점수 불러오기
      getScore(session.userId).then((s) => {
        sendFrame(ws, "state", {
          state: "connected",
          userId: session.userId,
          displayName: session.displayName,
          score: { total: s.totalScore, best: s.bestScore, plays: s.plays },
        });
      }).catch(() => {
        sendFrame(ws, "state", {
          state: "connected",
          userId: session.userId,
          displayName: session.displayName,
        });
      });
      break;
    }
    case "start_run": {
      // Issue #8: start_run 스팸 방지 (3초 쿨다운)
      const now = Date.now();
      if (session.lastRunAtMs && now - session.lastRunAtMs < 3000) {
        sendFrame(ws, "state", { state: "error", reason: "rate_limit_exceeded" });
        return;
      }
      session.lastRunAtMs = now;
      // 이전 Live 세션 정리
      if (session.liveSession) {
        try { session.liveSession.close(); } catch {}
        session.liveSession = null;
      }

      const selectedQuestion = selectRandomQuestion();
      session.currentRunId = createRunId();
      session.questionStartedAtMs = Date.now();
      session.answered = false;
      session.currentQuestion = selectedQuestion;

      logEvent("question_start", {
        runId: session.currentRunId,
        userId: session.userId,
        qId: session.currentQuestion.id,
      });

      sendFrame(ws, "state", { state: "speaking", runId: session.currentRunId });
      sendFrame(ws, "question_meta", {
        runId: session.currentRunId,
        qId: session.currentQuestion.id,
        choices: session.currentQuestion.choices,
      });

      // Gemini Live 세션 시작 (문제+선택지+뇌절 멘트 조합)
      const q = session.currentQuestion;
      const tmi = (q.tmi_stream || []).slice(0, 2).join(' ');
      const speakText = [
        `문제! ${q.question}`,
        `A: ${q.choices.A}`,
        `B: ${q.choices.B}`,
        `C: ${q.choices.C}`,
        tmi ? `그리고... ${tmi}` : '',
      ].filter(Boolean).join(' ');

      const runId = session.currentRunId; // 클로저용

      startLiveSpeak({
        text: speakText,
        onAudioChunk: ({ data, mimeType }) => {
          // 현재 run이 여전히 유효한지 확인
          if (session.currentRunId !== runId) return;
          if (ws.readyState !== ws.OPEN) return;
          sendFrame(ws, "audio_out_chunk", {
            runId,
            data,       // base64 PCM16
            mimeType,
            sampleRate: 24000,
            codec: 'pcm16',
          });
        },
        onInterrupted: () => {
          logEvent("live_interrupted", { runId, userId: session.userId });
          sendFrame(ws, "stop_playback");
        },
        onDone: (err) => {
          if (err) {
            logEvent("live_error", { runId, userId: session.userId, message: err?.message });
          } else {
            logEvent("live_done", { runId, userId: session.userId });
          }
          // Live 세션 정리
          if (session.liveSession) {
            session.liveSession = null;
          }
        },
      })
        .then((handle) => {
          // 비동기로 handle이 반환됨 — 아직 run이 유효하면 저장
          if (session.currentRunId === runId) {
            session.liveSession = handle;
            // Issue #5: 60초 후 세션 자동 종료 타임아웃
            setTimeout(() => {
              if (session.liveSession === handle) {
                logEvent("live_timeout", { runId, userId: session.userId });
                try { handle.close(); } catch {}
                session.liveSession = null;
              }
            }, 60000);
          } else {
            // 이미 barge_in이 왔으면 즉시 닫기
            try { handle.close(); } catch {}
          }
        })
        .catch((err) => {
          logEvent("live_connect_error", {
            runId,
            userId: session.userId,
            message: err?.message,
          });
          sendFrame(ws, "state", { state: "error", reason: "live_connect_failed" });
        });

      break;
    }
    case "barge_in": {
      if (!session.currentRunId || !session.questionStartedAtMs) {
        sendFrame(ws, "state", { state: "error", reason: "no_active_run" });
        return;
      }
      if (!session.currentQuestion || !session.currentQuestion.answer) {
        sendFrame(ws, "state", {
          state: "error",
          reason: "no_active_question",
        });
        return;
      }

      if (session.answered) {
        sendFrame(ws, "state", { state: "duplicate_barge_in_ignored" });
        return;
      }

      session.answered = true;

      // Gemini Live 출력 즉시 중단
      if (session.liveSession) {
        try { session.liveSession.close(); } catch {}
        session.liveSession = null;
      }

      const elapsedMs = Date.now() - session.questionStartedAtMs;
      const answer = String(msg.answer || "").toUpperCase();
      const correct = answer === session.currentQuestion.answer;
      const base = 100;
      const speedBonus = Math.max(0, 80 - Math.floor(elapsedMs / 250) * 5);
      const delta = correct ? base + speedBonus : 0;

      logEvent("barge_in", {
        runId: session.currentRunId,
        userId: session.userId,
        answer,
        elapsedMs,
      });

      sendFrame(ws, "state", { state: "interrupted", runId: session.currentRunId });
      sendFrame(ws, "state", { state: "judging", runId: session.currentRunId });

      const savedRunId = session.currentRunId;
      const savedQuestion = session.currentQuestion;

      // T0-09: Firestore 점수 저장 + run 로그
      Promise.all([
        updateScore(session.userId, delta, correct),
        saveRun({
          runId: savedRunId,
          userId: session.userId,
          qId: savedQuestion.id,
          answer,
          correct,
          elapsedMs,
          scoreDelta: delta,
        }),
      ])
        .then(([scoreData]) => {
          const total = scoreData.totalScore;
          const best  = scoreData.bestScore;
          logEvent("score_saved", { runId: savedRunId, userId: session.userId, total, best });

          sendFrame(ws, "score", {
            runId: savedRunId,
            correct,
            delta,
            elapsed_ms: elapsedMs,
            total,
            best,
          });
          sendFrame(ws, "state", { state: "scored", runId: savedRunId });

          // T0-10: 루카 리액션 (짧게 말하기)
          const reactionText = correct
            ? `정답이야! ${savedQuestion.answer}번! 역시 빠르네~`
            : `땡! 정답은 ${savedQuestion.answer}번이었어. 다음엔 더 빨리 끊어봐!`;

          startLiveSpeak({
            text: reactionText,
            onAudioChunk: ({ data, mimeType }) => {
              if (ws.readyState !== ws.OPEN) return;
              sendFrame(ws, "audio_out_chunk", { runId: savedRunId, data, mimeType, sampleRate: 24000, codec: 'pcm16' });
            },
            onInterrupted: () => {},
            onDone: () => {
              logEvent("reaction_done", { runId: savedRunId, userId: session.userId });
            },
          }).then((handle) => {
            // Issue #2: 리액션 세션 핸들도 세션에 저장하여 관리
            if (session.currentRunId === savedRunId) {
              session.liveSession = handle;
            } else {
              try { handle.close(); } catch {}
            }
          }).catch((err) => {
            logEvent("reaction_error", { runId: savedRunId, message: err?.message });
          });
        })
        .catch((err) => {
          logEvent("firestore_error", { runId: savedRunId, userId: session.userId, message: err?.message });
          // Firestore 실패해도 클라에는 점수 전송
          sendFrame(ws, "score", { runId: savedRunId, correct, delta, elapsed_ms: elapsedMs });
          sendFrame(ws, "state", { state: "scored", runId: savedRunId });
        });
      break;
    }
    case "stop_reset": {
      if (session.liveSession) {
        try { session.liveSession.close(); } catch {}
        session.liveSession = null;
      }
      session.currentRunId = null;
      session.currentQuestion = null;
      session.answered = false;
      logEvent("stop_reset", { userId: session.userId });
      sendFrame(ws, "state", { state: "listening" });
      break;
    }
    default: {
      sendFrame(ws, "state", {
        state: "error",
        reason: "unknown_message_type",
        receivedType: type || null,
      });
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const session = getOrCreateSession(ws);
  session.isAlive = true;
  logEvent("session_connected", { userId: session.userId });

  ws.on("pong", () => {
    const current = getOrCreateSession(ws);
    current.isAlive = true;
  });

  ws.on("message", (raw) => handleMessage(ws, raw));

  ws.on("close", (code, reason) => {
    const current = getOrCreateSession(ws);
    logEvent("session_disconnected", {
      userId: current.userId,
      runId: current.currentRunId,
      code,
      reason: reason.toString(),
    });
    sessions.delete(ws);
  });

  ws.on("error", (err) => {
    const current = getOrCreateSession(ws);
    logEvent("ws_error", {
      userId: current.userId,
      runId: current.currentRunId,
      message: err.message,
    });
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const session = getOrCreateSession(ws);
    if (!session.isAlive) {
      ws.terminate();
      return;
    }
    session.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  questionBank = loadQuestionBank();
  logEvent("question_bank_loaded", {
    count: questionBank.length,
    source: QUESTIONS_FILE_PATH,
  });
  logEvent("server_started", { port: PORT });
});
