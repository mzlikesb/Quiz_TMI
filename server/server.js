const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { startLiveSpeak } = require("./live");

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
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map();
const userScores = new Map(); // Issue #4: 영구 점수 저장용
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

      sendFrame(ws, "state", {
        state: "connected",
        userId: session.userId,
        displayName: session.displayName,
        score: userScores.get(session.userId) || { total: 0, best: 0 },
      });
      break;
    }
    case "start_run": {
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
      // Issue #4: 서버에서 점수 계산 및 저장
      const currentScore = userScores.get(session.userId) || { total: 0, best: 0 };
      currentScore.total += delta;
      currentScore.best = Math.max(currentScore.best, currentScore.total);
      userScores.set(session.userId, currentScore);
      sendFrame(ws, "score", {
        runId: session.currentRunId,
        correct,
        delta,
        elapsed_ms: elapsedMs,
        total: userScores.get(session.userId).total,
        best: userScores.get(session.userId).best,
      });
      break;
    }
    case "simulate_drop": {
      logEvent("simulate_drop", {
        runId: session.currentRunId,
        userId: session.userId,
      });
      sendFrame(ws, "state", { state: "disconnecting", reason: "simulate_drop" });
      ws.close(4000, "simulate_drop");
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
