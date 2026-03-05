// server/firestore.js - Firestore 연동 모듈
'use strict';

const { Firestore } = require('@google-cloud/firestore');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
const DATABASE = process.env.FIRESTORE_DATABASE || '(default)';

let _db = null;
function getDb() {
  if (!_db) {
    _db = new Firestore({ projectId: PROJECT, databaseId: DATABASE });
  }
  return _db;
}

/**
 * scores/{userId} 업데이트 (누적 점수, 최고 점수, 플레이 횟수)
 * @param {string} userId
 * @param {number} delta - 이번 라운드 획득 점수
 * @param {boolean} correct
 */
async function updateScore(userId, delta, correct) {
  const db = getDb();
  const ref = db.collection('scores').doc(userId);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : { totalScore: 0, bestScore: 0, plays: 0 };

    const newTotal = (prev.totalScore || 0) + delta;
    const newBest  = Math.max(prev.bestScore || 0, newTotal);
    const newPlays = (prev.plays || 0) + 1;

    tx.set(ref, {
      totalScore: newTotal,
      bestScore:  newBest,
      plays:      newPlays,
      lastCorrect: correct,
      updatedAt:  Firestore.Timestamp.now(),
    }, { merge: true });

    return { totalScore: newTotal, bestScore: newBest, plays: newPlays };
  });
}

/**
 * scores/{userId} 읽기
 */
async function getScore(userId) {
  const db = getDb();
  const snap = await db.collection('scores').doc(userId).get();
  if (!snap.exists) return { totalScore: 0, bestScore: 0, plays: 0 };
  return snap.data();
}

/**
 * runs/{runId} 저장 (T1-02: run 로그)
 */
async function saveRun({ runId, userId, qId, answer, correct, elapsedMs, scoreDelta }) {
  const db = getDb();
  await db.collection('runs').doc(runId).set({
    userId,
    qId,
    answer,
    correct,
    elapsedMs,
    scoreDelta,
    createdAt: Firestore.Timestamp.now(),
  });
}

module.exports = { updateScore, getScore, saveRun };
