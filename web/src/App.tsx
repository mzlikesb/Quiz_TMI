import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type UiStatus =
  | 'Listening'
  | 'Speaking'
  | 'Interrupted'
  | 'Judging'
  | 'Scored'
  | 'Reconnecting'
  | 'Error'

type TimelineEvent = {
  id: number
  message: string
  timestamp: string
}

type ScoreState = {
  total: number
  best: number
  delta: number
}

function resolveWsUrl(): string {
  const envBase = (import.meta.env.VITE_WS_BASE_URL as string | undefined)?.trim()

  if (envBase) {
    const normalized = envBase.replace(/\/$/, '')
    const wsBase = normalized.startsWith('http')
      ? normalized.replace(/^http/, 'ws')
      : normalized
    return wsBase.endsWith('/ws') ? wsBase : `${wsBase}/ws`
  }

  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'ws://localhost:8080/ws'
  }

  return 'wss://quiz-tmi-801541606537.us-central1.run.app/ws'
}

const WS_URL = resolveWsUrl()
const USER_ID_KEY = 'interruption_quiz_user_id'

function getOrCreateUserId(): string {
  const fallback = `web-${Math.random().toString(36).slice(2, 10)}`

  if (typeof window === 'undefined') {
    return fallback
  }

  const existing = window.localStorage.getItem(USER_ID_KEY)
  if (existing) {
    return existing
  }

  window.localStorage.setItem(USER_ID_KEY, fallback)
  return fallback
}

function toUiStatus(value: unknown): UiStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  switch (value.toLowerCase()) {
    case 'listening':
      return 'Listening'
    case 'speaking':
      return 'Speaking'
    case 'interrupted':
      return 'Interrupted'
    case 'judging':
      return 'Judging'
    case 'scored':
      return 'Scored'
    case 'reconnecting':
      return 'Reconnecting'
    case 'error':
      return 'Error'
    default:
      return null
  }
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

function App() {
  const [status, setStatus] = useState<UiStatus>('Reconnecting')
  const [score, setScore] = useState<ScoreState>({ total: 0, best: 0, delta: 0 })
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null)
  const [speakingFrameWide, setSpeakingFrameWide] = useState(false)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const shouldReconnectRef = useRef(true)
  const timelineIdRef = useRef(0)

  const userId = useMemo(() => getOrCreateUserId(), [])
  const displayName = useMemo(() => `Player-${userId.slice(-4)}`, [userId])

  const pushEvent = useCallback((message: string) => {
    timelineIdRef.current += 1
    const timestamp = new Date().toLocaleTimeString()
    setTimeline((prev) => [{ id: timelineIdRef.current, message, timestamp }, ...prev].slice(0, 10))
  }, [])

  const sendJson = useCallback(
    (payload: Record<string, unknown>) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        pushEvent(`Dropped outbound "${String(payload.type)}" (socket not open)`)
        return false
      }
      ws.send(JSON.stringify(payload))
      pushEvent(`Sent "${String(payload.type)}"`)
      return true
    },
    [pushEvent],
  )

  const connectWebSocket = useCallback(() => {
    if (!shouldReconnectRef.current) {
      return
    }

    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    pushEvent(`Connecting to ${WS_URL}`)

    ws.onopen = () => {
      reconnectAttemptRef.current = 0
      setStatus('Listening')
      pushEvent('WebSocket connected')
      sendJson({
        type: 'hello',
        userId,
        displayName,
        version: 'web-ui-v1',
      })
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as Record<string, unknown>
        const type = payload.type
        pushEvent(`Received "${String(type ?? 'unknown')}"`)

        if (type === 'state') {
          const nextStatus = toUiStatus(payload.state ?? payload.status ?? payload.value)
          if (nextStatus) {
            setStatus(nextStatus)
          }
          return
        }

        if (type === 'score') {
          const delta = toNumber(payload.delta ?? payload.scoreDelta, 0)
          const isCorrect = payload.correct ?? payload.isCorrect
          if (typeof isCorrect === 'boolean') {
            setLastCorrect(isCorrect)
          } else {
            setLastCorrect(delta > 0)
          }

          setScore((prev) => {
            const total = toNumber(payload.total ?? payload.totalScore, prev.total + delta)
            const best = toNumber(payload.best ?? payload.bestScore, Math.max(prev.best, total))
            return { delta, total, best }
          })
          setStatus('Scored')
        }
      } catch {
        pushEvent('Received non-JSON message')
      }
    }

    ws.onerror = () => {
      setStatus('Error')
      pushEvent('WebSocket error')
    }

    ws.onclose = (event) => {
      wsRef.current = null
      pushEvent(`WebSocket closed (code=${event.code})`)

      if (!shouldReconnectRef.current) {
        return
      }

      reconnectAttemptRef.current += 1
      const attempt = reconnectAttemptRef.current
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15000)
      setStatus('Reconnecting')
      pushEvent(`Reconnect attempt ${attempt} in ${delayMs}ms`)
      reconnectTimerRef.current = window.setTimeout(() => {
        connectWebSocket()
      }, delayMs)
    }
  }, [displayName, pushEvent, sendJson, userId])

  useEffect(() => {
    shouldReconnectRef.current = true
    connectWebSocket()

    return () => {
      shouldReconnectRef.current = false
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      wsRef.current?.close(1000, 'component unmount')
    }
  }, [connectWebSocket])

  useEffect(() => {
    if (status !== 'Speaking') {
      setSpeakingFrameWide(false)
      return
    }

    const timerId = window.setInterval(() => {
      setSpeakingFrameWide((prev) => !prev)
    }, 180)

    return () => {
      window.clearInterval(timerId)
    }
  }, [status])

  const handleStartRun = () => {
    sendJson({ type: 'start_run' })
  }

  const handleStopReset = () => {
    sendJson({ type: 'stop_reset' })
    setScore({ total: 0, best: 0, delta: 0 })
    setStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'Listening' : 'Reconnecting')
    pushEvent('Local score reset')
  }

  const handleAnswer = (answer: 'A' | 'B' | 'C') => {
    sendJson({ type: 'barge_in', answer })
  }

  const handleSimulateDrop = () => {
    sendJson({ type: 'simulate_drop' })
    wsRef.current?.close(4999, 'simulate drop')
    pushEvent('Simulate Drop triggered')
  }

  const statusClassName: Record<UiStatus, string> = {
    Listening: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
    Speaking: 'bg-blue-100 text-blue-700 ring-blue-200',
    Interrupted: 'bg-amber-100 text-amber-700 ring-amber-200',
    Judging: 'bg-orange-100 text-orange-700 ring-orange-200',
    Scored: 'bg-purple-100 text-purple-700 ring-purple-200',
    Reconnecting: 'bg-slate-200 text-slate-700 ring-slate-300',
    Error: 'bg-rose-100 text-rose-700 ring-rose-200',
  }

  const faceSprite = (() => {
    switch (status) {
      case 'Listening':
        return '/sprites/face/02_listening.png'
      case 'Speaking':
        return speakingFrameWide ? '/sprites/face/03_speaking_wide.png' : '/sprites/face/04_speaking_half.png'
      case 'Interrupted':
        return '/sprites/face/05_shocked.png'
      case 'Scored':
        return lastCorrect ? '/sprites/face/06_proud.png' : '/sprites/face/07_confused.png'
      case 'Error':
      case 'Reconnecting':
        return '/sprites/face/07_confused.png'
      case 'Judging':
      default:
        return '/sprites/face/01_neutral.png'
    }
  })()

  const scorePopupSprite = status === 'Scored' ? (lastCorrect ? '/sprites/text/correct.png' : '/sprites/text/fail.png') : null

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#164e63_0%,#0f172a_55%,#020617_100%)] px-3 py-5 text-slate-100 sm:px-5 sm:py-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header className="rounded-2xl border border-cyan-500/30 bg-slate-900/80 p-4 shadow-[0_0_0_1px_rgba(6,182,212,0.14),0_20px_40px_rgba(2,6,23,0.45)] backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Interruption Quiz</h1>
            <span className={`rounded-full px-4 py-1 text-sm font-semibold ring-1 ${statusClassName[status]}`}>
              {status}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-400 sm:text-sm">
            userId: <span className="font-mono">{userId}</span> | displayName:{' '}
            <span className="font-mono">{displayName}</span>
          </p>
        </header>

        <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 shadow-lg backdrop-blur">
          <div className="relative mx-auto w-full max-w-[320px] overflow-hidden">
            <img src={faceSprite} alt={`Luca ${status}`} className="mx-auto block h-auto w-full select-none" />
            {scorePopupSprite ? (
              <img
                src={scorePopupSprite}
                alt={lastCorrect ? 'Correct' : 'Fail'}
                className="pointer-events-none absolute -top-3 left-1/2 h-auto w-[58%] max-w-[180px] -translate-x-1/2 select-none object-contain"
              />
            ) : null}
          </div>
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 text-center shadow-lg backdrop-blur">
            <p className="text-sm text-slate-400">Total</p>
            <p className="mt-1 text-3xl font-black">{score.total}</p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 text-center shadow-lg backdrop-blur">
            <p className="text-sm text-slate-400">Best</p>
            <p className="mt-1 text-3xl font-black">{score.best}</p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 text-center shadow-lg backdrop-blur">
            <p className="text-sm text-slate-400">Delta</p>
            <p className="mt-1 text-3xl font-black">{score.delta >= 0 ? `+${score.delta}` : score.delta}</p>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700 bg-slate-900/85 p-4 shadow-lg backdrop-blur">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={handleStartRun}
              className="min-h-14 w-full rounded-xl border-2 border-emerald-200/70 bg-emerald-500 px-5 py-4 text-lg font-black text-white shadow-[0_8px_0_#14532d] transition hover:bg-emerald-400 active:translate-y-[1px]"
            >
              Start Run
            </button>
            <button
              type="button"
              onClick={handleStopReset}
              className="min-h-14 w-full rounded-xl border-2 border-rose-200/70 bg-rose-500 px-5 py-4 text-lg font-black text-white shadow-[0_8px_0_#7f1d1d] transition hover:bg-rose-400 active:translate-y-[1px]"
            >
              Stop / Reset
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-3">
            {(['A', 'B', 'C'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => handleAnswer(choice)}
                className="min-h-[4.5rem] w-full rounded-xl border-2 border-cyan-200/70 bg-cyan-500 px-4 py-4 text-3xl font-black text-slate-950 shadow-[0_8px_0_#155e75] transition hover:bg-cyan-400 active:translate-y-[1px]"
              >
                {choice}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleSimulateDrop}
            className="mt-3 min-h-12 w-full rounded-xl border-2 border-slate-500 bg-slate-700 px-5 py-3 text-base font-bold text-slate-100 transition hover:bg-slate-600"
          >
            Simulate Drop
          </button>
        </section>

        <section className="rounded-2xl border border-slate-700 bg-slate-900/85 p-4 shadow-lg backdrop-blur">
          <h2 className="text-lg font-semibold">Event Timeline (Last 10)</h2>
          <ul className="mt-3 space-y-2">
            {timeline.length === 0 ? (
              <li className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-500">No events yet.</li>
            ) : (
              timeline.map((item) => (
                <li key={item.id} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
                  <span className="mr-2 font-mono text-xs text-slate-500">{item.timestamp}</span>
                  <span className="text-sm text-slate-200">{item.message}</span>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </main>
  )
}

export default App
