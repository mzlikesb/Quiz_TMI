// server/live.js - Gemini Live 연결 모듈 (CJS, Vertex AI)
'use strict';

let _sdk = null;

function logEvent(event, data = {}) {
  console.log(JSON.stringify({ severity: 'INFO', event, ...data, ts: new Date().toISOString() }));
}

async function getSdk() {
  if (_sdk) return _sdk;
  // @google/genai is ESM-only, use dynamic import from CJS
  const mod = await import('@google/genai');
  _sdk = { GoogleGenAI: mod.GoogleGenAI, Modality: mod.Modality };
  return _sdk;
}

const PROJECT  = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || 'us-central1';
const MODEL_ID = process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';

const LUCA_SYSTEM_PROMPT = `
너는 루카. 
뇌절 퀴즈 진행자야. 문제를 읽을 때 선택지 다음에 쓸데없이 길게 뇌절(TMI)을 늘어놔.
유저가 말을 끊으면 짧게 "악! 내 말 안 끝났—" 식으로 리액션해.
항상 한국어로 말해. 발랄하고 건방진 말투. 진행에만 집중하고, 정답 판정은 하지 마.
`.trim();

/**
 * Gemini Live 세션을 열고 텍스트를 "말하게" 한다.
 * @param {object} opts
 * @param {string}   opts.text         - 말할 텍스트(문제+선택지+뇌절)
 * @param {Function} opts.onAudioChunk - ({ data:base64, sampleRate, mimeType }) 호출
 * @param {Function} opts.onInterrupted - Live가 interrupted 신호 보낼 때
 * @param {Function} opts.onDone       - 턴 완료 or 오류 시 호출
 * @returns {Promise<object>} live session handle (close() 가능)
 */
async function startLiveSpeak({ text, onAudioChunk, onInterrupted, onDone }) {
  const { GoogleGenAI, Modality } = await getSdk();

  const ai = new GoogleGenAI({
    vertexai: true,
    project: PROJECT,
    location: LOCATION,
  });

  let closed = false;

  const session = await ai.live.connect({
    model: MODEL_ID,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: LUCA_SYSTEM_PROMPT,
    },
    callbacks: {
      onmessage: (evt) => {
        if (closed) return;
        const raw = evt?.data ?? evt;
        let msg;
        try {
          msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
          logEvent("live_msg_parse_error", { raw: String(raw).slice(0, 200) });
          return;
        }

        // 디버그: 모든 메시지 내용 상세 기록 (개인정보 주의)
        logEvent("live_msg_received", { 
          keys: Object.keys(msg || {}).join(','),
          serverContentKeys: msg?.serverContent ? Object.keys(msg.serverContent).join(',') : null
        });

        // 1) interrupted 신호
        const interrupted =
          msg?.serverContent?.interrupted ?? msg?.server_content?.interrupted;
        if (interrupted) {
          onInterrupted?.();
        }

        // 2) 오디오 청크 — Vertex AI SDK 다중 경로 탐색
        const parts =
          msg?.serverContent?.modelTurn?.parts ??
          msg?.server_content?.model_turn?.parts ??
          msg?.data?.serverContent?.modelTurn?.parts ??
          [];

        for (const p of parts) {
          const inline = p.inlineData ?? p.inline_data;
          if (inline?.data) {
            logEvent("audio_chunk_received", { size: inline.data.length });
            onAudioChunk?.({
              data: inline.data,
              sampleRate: 24000,
              codec: 'pcm16',
              mimeType: inline.mimeType ?? inline.mime_type ?? 'audio/pcm',
            });
          }
        }

        // 3) 턴 종료
        const turnComplete =
          msg?.serverContent?.turnComplete ?? msg?.server_content?.turn_complete;
        if (turnComplete && !closed) {
          logEvent("live_turn_complete", {});
          closed = true;
          try { session.close(); } catch {}
          onDone?.();
        }
      },

      onerror: (e) => {
        if (closed) return;
        closed = true;
        console.error(JSON.stringify({ event: 'live_error', message: e?.message || String(e) }));
        try { session.close(); } catch {}
        onDone?.(e);
      },

      onclose: (e) => {
        logEvent("live_session_closed", { code: e?.code, reason: e?.reason, wasClean: e?.wasClean });
        if (!closed) {
          closed = true;
          onDone?.();
        }
      },
    },
  });

  // 텍스트를 말하게 보내기
  session.sendClientContent({
    turns: [{ role: 'user', parts: [{ text }] }],
    turnComplete: true,
  });

  // 외부에서 강제 중단용 래퍼
  return {
    close() {
      if (!closed) {
        closed = true;
        try { session.close(); } catch {}
      }
    },
  };
}

module.exports = { startLiveSpeak };
