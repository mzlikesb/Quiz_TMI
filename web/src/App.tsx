import type { ButtonHTMLAttributes, ReactNode } from 'react'
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

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx(
        'rounded-3xl border border-white/12 bg-slate-900/70 p-4 shadow-[0_10px_35px_rgba(2,6,23,0.5)] backdrop-blur-sm sm:p-5',
        className,
      )}
    >
      {children}
    </section>
  )
}

function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.16em]', className)}>
      {children}
    </span>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-3 text-center sm:p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{label}</p>
      <p className="mt-1 text-3xl font-extrabold leading-none text-slate-100">{value}</p>
    </Card>
  )
}

function PrimaryButton({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(
        'min-h-14 w-full rounded-2xl border px-5 py-4 text-base font-extrabold tracking-wide transition duration-150 active:translate-y-[1px]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
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
    Listening: 'bg-emerald-500/18 text-emerald-200 ring-1 ring-emerald-300/45',
    Speaking: 'bg-sky-500/18 text-sky-200 ring-1 ring-sky-300/45',
    Interrupted: 'bg-amber-500/18 text-amber-200 ring-1 ring-amber-300/45',
    Judging: 'bg-orange-500/18 text-orange-200 ring-1 ring-orange-300/45',
    Scored: 'bg-violet-500/18 text-violet-200 ring-1 ring-violet-300/45',
    Reconnecting: 'bg-slate-500/20 text-slate-200 ring-1 ring-slate-300/40',
    Error: 'bg-rose-500/18 text-rose-200 ring-1 ring-rose-300/45',
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
  const subtitle =
    status === 'Speaking'
      ? 'Listen closely, then cut in with the winning answer.'
      : 'Stay sharp and answer instantly when your moment appears.'

  return (
    <main className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_16%_8%,#1a4b77_0%,#0b1325_48%,#030712_100%)] px-3 py-4 text-slate-100 sm:px-6 sm:py-8">
      <div className="pointer-events-none absolute -left-20 top-16 h-48 w-48 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-14 top-32 h-52 w-52 rounded-full bg-emerald-300/10 blur-3xl" />
      <div className="mx-auto flex w-full max-w-[440px] flex-col gap-4 lg:max-w-5xl lg:gap-6">
        <Card className="relative overflow-hidden border-cyan-300/20 bg-gradient-to-b from-slate-900/90 to-slate-950/90">
          <div className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full bg-cyan-300/10 blur-3xl" />
          <div className="relative flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">Live Challenge</p>
                <h1 className="mt-1 text-3xl font-extrabold leading-none tracking-tight text-white sm:text-4xl">Interruption Quiz</h1>
              </div>
              <Badge className={statusClassName[status]}>{status}</Badge>
            </div>
            <p className="max-w-[44ch] text-sm leading-relaxed text-slate-300">{subtitle}</p>
            <p className="text-[11px] text-slate-500">
              userId: <span className="font-mono text-slate-300">{userId}</span> | displayName:{' '}
              <span className="font-mono text-slate-300">{displayName}</span>
            </p>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-start lg:gap-6">
          <div className="flex flex-col gap-4">
            <Card className="border-cyan-200/20 bg-slate-900/75 shadow-[0_12px_38px_rgba(6,182,212,0.1),0_10px_30px_rgba(2,6,23,0.55)]">
              <div className="relative mx-auto w-full max-w-[320px] overflow-visible">
                <img src={faceSprite} alt={`Luca ${status}`} className="mx-auto block h-auto w-full select-none" />
                {scorePopupSprite ? (
                  <img
                    src={scorePopupSprite}
                    alt={lastCorrect ? 'Correct' : 'Fail'}
                    className="pointer-events-none absolute -top-3 left-1/2 h-auto w-[58%] max-w-[180px] -translate-x-1/2 select-none object-contain drop-shadow-[0_0_14px_rgba(255,255,255,0.35)]"
                  />
                ) : null}
              </div>
            </Card>

            <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
              <StatCard label="Total" value={score.total} />
              <StatCard label="Best" value={score.best} />
              <StatCard label="Delta" value={score.delta >= 0 ? `+${score.delta}` : score.delta} />
            </div>

            <Card className="border-slate-200/15">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <PrimaryButton
                  onClick={handleStartRun}
                  className="border-emerald-200/65 bg-emerald-500 text-white shadow-[0_9px_22px_rgba(16,185,129,0.38),inset_0_-3px_0_rgba(6,78,59,0.6)] hover:bg-emerald-400"
                >
                  Start Run
                </PrimaryButton>
                <PrimaryButton
                  onClick={handleStopReset}
                  className="border-rose-200/65 bg-rose-500 text-white shadow-[0_9px_22px_rgba(244,63,94,0.34),inset_0_-3px_0_rgba(136,19,55,0.6)] hover:bg-rose-400"
                >
                  Stop / Reset
                </PrimaryButton>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3">
                {(['A', 'B', 'C'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => handleAnswer(choice)}
                    className="aspect-square w-full rounded-full border-2 border-cyan-200/70 bg-[radial-gradient(circle_at_30%_20%,#7dd3fc_0%,#06b6d4_62%,#0e7490_100%)] text-4xl font-black text-slate-950 shadow-[0_10px_22px_rgba(14,116,144,0.55)] transition hover:brightness-110 active:translate-y-[1px]"
                  >
                    {choice}
                  </button>
                ))}
              </div>

              <PrimaryButton
                onClick={handleSimulateDrop}
                className="mt-4 min-h-12 border-slate-500/70 bg-slate-800 text-slate-100 shadow-[0_8px_20px_rgba(2,6,23,0.45)] hover:bg-slate-700"
              >
                Simulate Drop
              </PrimaryButton>
            </Card>
          </div>

          <Card className="border-slate-300/15">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight text-white">Event Timeline</h2>
              <Badge className="bg-slate-700/75 text-slate-200 ring-1 ring-slate-500/70">Last 10</Badge>
            </div>

            <ul className="mt-3 space-y-1.5">
              {timeline.length === 0 ? (
                <li className="rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-500">No events yet.</li>
              ) : (
                timeline.map((item, index) => {
                  const isOutbound = item.message.startsWith('Sent')
                  const isInbound = item.message.startsWith('Received')
                  const icon = isOutbound ? '↑' : isInbound ? '↓' : '•'

                  return (
                    <li
                      key={item.id}
                      className={cx(
                        'flex items-start gap-3 rounded-xl border px-3 py-2.5',
                        index % 2 === 0 ? 'border-slate-700 bg-slate-950/75' : 'border-slate-600/70 bg-slate-900/80',
                      )}
                    >
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-bold text-cyan-200 ring-1 ring-slate-600">
                        {icon}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] text-slate-500">{item.timestamp}</p>
                        <p className="mt-0.5 text-sm leading-snug text-slate-200">{item.message}</p>
                      </div>
                    </li>
                  )
                })
              )}
            </ul>
          </Card>
        </div>
      </div>
    </main>
  )
}

export default App
