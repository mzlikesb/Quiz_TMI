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

function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx(
        'rounded-[16px] border border-white/10 bg-[rgba(255,255,255,0.06)] p-5 shadow-[0_4px_24px_rgba(0,0,0,0.3)] backdrop-blur-[12px] sm:p-6',
        className,
      )}
    >
      {children}
    </section>
  )
}

function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em]', className)}>
      {children}
    </span>
  )
}

function ScoreCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[16px] border border-white/10 bg-[rgba(255,255,255,0.08)] px-4 py-4 shadow-[0_4px_24px_rgba(0,0,0,0.3)] backdrop-blur-[12px]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/70">{label}</p>
      <p className="mt-2 text-[2.15em] font-black leading-none text-[#FF6B9D]">{value}</p>
    </div>
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
        'min-h-12 w-full rounded-[14px] border px-5 py-3 text-sm font-extrabold tracking-wide transition duration-150 active:translate-y-[1px]',
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
        displayName: `Player-${userId.slice(-4)}`,
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
  }, [pushEvent, sendJson, userId])

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
    Listening: 'bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-200/45',
    Speaking: 'bg-sky-500/20 text-sky-100 ring-1 ring-sky-200/45',
    Interrupted: 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-200/45',
    Judging: 'bg-orange-500/20 text-orange-100 ring-1 ring-orange-200/45',
    Scored: 'bg-[#FF6B9D]/20 text-[#FFD6E4] ring-1 ring-[#FF6B9D]/45',
    Reconnecting: 'bg-slate-500/20 text-slate-100 ring-1 ring-slate-200/30',
    Error: 'bg-rose-500/20 text-rose-100 ring-1 ring-rose-200/45',
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
    <main className="relative min-h-screen overflow-hidden bg-[#121212] px-4 py-8 text-white sm:px-8 sm:py-10">
      <div className="pointer-events-none absolute -left-24 -top-16 h-72 w-72 rounded-full bg-[#FF6B9D]/15 blur-3xl" />
      <div className="pointer-events-none absolute -right-16 top-24 h-80 w-80 rounded-full bg-[#FF6B9D]/10 blur-3xl" />

      <p className="absolute right-4 top-4 text-[11px] text-white/65 sm:right-8 sm:top-5">
        userId: <span className="font-mono">{userId}</span>
      </p>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <Panel className="relative overflow-visible pt-10 sm:pt-12">
          <div className="max-w-[44rem] pr-28 sm:pr-36">
            <h1 className="text-4xl font-black leading-none tracking-tight text-[#FF6B9D] sm:text-6xl">Interruption Quiz</h1>
            <p className="mt-4 text-sm leading-relaxed text-white/75 sm:text-base">
              실시간 인터럽트 타이밍을 겨루는 게임 대시보드. 상태를 보고 즉시 선택해서 최고 점수를 갱신하세요.
            </p>
            <div className="mt-4">
              <Badge className={statusClassName[status]}>{status}</Badge>
            </div>
          </div>

          <div className="pointer-events-none absolute -bottom-12 right-3 z-20 w-[140px] sm:-bottom-16 sm:right-8 sm:w-[220px]">
            <img
              src={faceSprite}
              alt={`Luca ${status}`}
              className="h-auto w-full select-none [filter:drop-shadow(0_0_20px_rgba(255,107,157,0.6))]"
            />
            {scorePopupSprite ? (
              <img
                src={scorePopupSprite}
                alt={lastCorrect ? 'Correct' : 'Fail'}
                className="absolute -left-10 top-1 h-auto w-[70%] select-none object-contain [filter:drop-shadow(0_0_16px_rgba(255,255,255,0.5))]"
              />
            ) : null}
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-6">
            <section>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Scoreboard</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <ScoreCard label="Total" value={score.total} />
                <ScoreCard label="Best" value={score.best} />
                <ScoreCard label="Delta" value={score.delta >= 0 ? `+${score.delta}` : score.delta} />
              </div>
            </section>

            <Panel>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <PrimaryButton
                  onClick={handleStartRun}
                  className="border-[#FF6B9D]/70 bg-[#FF6B9D] text-[#1D0D14] shadow-[0_8px_18px_rgba(255,107,157,0.35)] hover:brightness-110"
                >
                  Start Run
                </PrimaryButton>
                <PrimaryButton
                  onClick={handleStopReset}
                  className="border-white/20 bg-white/8 text-white shadow-[0_8px_18px_rgba(0,0,0,0.28)] hover:bg-white/15"
                >
                  Stop / Reset
                </PrimaryButton>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3">
                {(['A', 'B', 'C'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => handleAnswer(choice)}
                    className="aspect-square w-full rounded-full border border-[#FF6B9D]/70 bg-[#2B1A22] text-4xl font-black text-[#FF6B9D] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.3)] transition hover:brightness-125 active:translate-y-[1px]"
                  >
                    {choice}
                  </button>
                ))}
              </div>

              <PrimaryButton
                onClick={handleSimulateDrop}
                className="mt-5 border-white/15 bg-[#1B1B1B] text-white/85 shadow-[0_8px_18px_rgba(0,0,0,0.3)] hover:bg-[#262626]"
              >
                Simulate Drop
              </PrimaryButton>
            </Panel>
          </div>

          <Panel>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight text-white">Event Timeline</h2>
              <Badge className="bg-white/10 text-white/80 ring-1 ring-white/15">Last 10</Badge>
            </div>

            <ul className="mt-4 space-y-2">
              {timeline.length === 0 ? (
                <li className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white/55">No events yet.</li>
              ) : (
                timeline.map((item) => {
                  const isOutbound = item.message.startsWith('Sent')
                  const isInbound = item.message.startsWith('Received')
                  const icon = isOutbound ? '↑' : isInbound ? '↓' : '•'

                  return (
                    <li key={item.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#FF6B9D]/20 text-[11px] font-bold text-[#FF6B9D] ring-1 ring-[#FF6B9D]/35">
                        {icon}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] text-white/45">{item.timestamp}</p>
                        <p className="mt-0.5 text-sm leading-snug text-white/85">{item.message}</p>
                      </div>
                    </li>
                  )
                })
              )}
            </ul>
          </Panel>
        </div>
      </div>
    </main>
  )
}

export default App
