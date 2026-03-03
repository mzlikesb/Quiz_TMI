const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

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
const QUESTIONS_FILE_PATH = path.join(__dirname, "..", "data", "questions.json");
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
      });
      break;
    }
    case "start_run": {
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
      sendFrame(ws, "audio_out_chunk", {
        runId: session.currentRunId,
        chunk: "",
        format: "pcm16-placeholder",
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
      sendFrame(ws, "score", {
        runId: session.currentRunId,
        correct,
        delta,
        elapsed_ms: elapsedMs,
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
