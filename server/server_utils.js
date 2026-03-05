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

module.exports = { logEvent };
