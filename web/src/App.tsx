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

// ─── PCM16 오디오 재생 플레이어 (24kHz) ──────────────────────────────────────────
class PcmPlayer {
  private ctx: AudioContext | null = null
  private queueTime = 0
  private sources: AudioBufferSourceNode[] = []

  private getCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 })
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }
    return this.ctx
  }

  init() {
    this.getCtx()
    this.queueTime = this.getCtx().currentTime
  }

  playPcm16Base64(base64: string, sampleRate = 24000) {
    const ctx = this.getCtx()
    
    // base64 → ArrayBuffer → Int16 → Float32
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const pcm = new Int16Array(bytes.buffer)
    
    const float32 = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768

    // AudioBuffer 생성 (24k로 생성, 48k context에서 자동 리샘플링)
    const buf = ctx.createBuffer(1, float32.length, sampleRate)
    buf.copyToChannel(float32, 0)

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)

    const startAt = Math.max(this.queueTime, ctx.currentTime)
    src.start(startAt)
    this.queueTime = startAt + buf.duration
    this.sources.push(src)

    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src)
    }
  }

  stop() {
    for (const s of this.sources) {
      try { s.stop() } catch {}
    }
    this.sources = []
    if (this.ctx) {
      this.queueTime = this.ctx.currentTime
    }
  }

  flush() {
    this.stop()
  }
}

const audioPlayer = new PcmPlayer()
// ──────────────────────────────────────────────────────────────────────────────

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
        version: 'web-ui-v2',
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

        if (type === 'stop_playback') {
          audioPlayer.stop()
          return
        }

        if (type === 'audio_out_chunk') {
          const data = payload.data as string | undefined
          if (data) {
            audioPlayer.playPcm16Base64(data, toNumber(payload.sampleRate, 24000))
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
    audioPlayer.init()
    sendJson({ type: 'start_run' })
  }

  const handleStopReset = () => {
    audioPlayer.flush()
    sendJson({ type: 'stop_reset' })
    setScore({ total: 0, best: 0, delta: 0 })
    setStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'Listening' : 'Reconnecting')
    pushEvent('Local score reset')
  }

  const handleAnswer = (answer: 'A' | 'B' | 'C') => {
    // 즉시 로컬 오디오 중단 (체감 지연 최소화)
    audioPlayer.flush()
    sendJson({ type: 'barge_in', answer })
  }

  const handleSimulateDrop = () => {
    sendJson({ type: 'simulate_drop' })
    wsRef.current?.close(4999, 'simulate drop')
    pushEvent('Simulate Drop triggered')
  }

  const statusClassName: Record<UiStatus, string> = {
    Listening: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
    Speaking: 'bg-blue-500/10 text-blue-400 ring-blue-500/30',
    Interrupted: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
    Judging: 'bg-orange-500/10 text-orange-400 ring-orange-500/30',
    Scored: 'bg-purple-500/10 text-purple-400 ring-purple-500/30',
    Reconnecting: 'bg-slate-500/10 text-slate-400 ring-slate-500/30',
    Error: 'bg-rose-500/10 text-rose-400 ring-rose-500/30',
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
        return lastCorrect ? '/sprites/face/06_proud.png' : '/sprites/face/05_shocked.png'
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
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        {/* Header Card */}
        <header className="rounded-2xl ring-1 ring-white/5 bg-white/5 p-4 shadow-xl backdrop-blur-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Quiz TMI</h1>
            <span className={`rounded-full px-4 py-1 text-sm font-semibold ring-1 ${statusClassName[status]}`}>
              {status}
            </span>
          </div>
          <details className="mt-2 group">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300 transition-colors">
              Session Info
            </summary>
            <p className="mt-2 text-xs text-slate-400 sm:text-sm font-mono bg-black/20 p-2 rounded">
              ID: {userId} | User: {displayName}
            </p>
          </details>
        </header>

        {/* Success/Fail Image Section */}
        <section className={`transition-all duration-300 ${status === 'Scored' ? 'h-24 opacity-100' : 'h-0 opacity-0 invisible'}`}>
           {scorePopupSprite && (
              <img
                src={scorePopupSprite}
                alt={lastCorrect ? 'Correct' : 'Fail'}
                className="mx-auto h-24 w-full max-w-[240px] object-contain select-none"
              />
           )}
        </section>

        {/* Avatar Section */}
        <section className="rounded-2xl ring-1 ring-white/5 bg-white/5 p-4 shadow-xl backdrop-blur-lg">
          <div className="relative mx-auto w-full max-w-[320px] overflow-hidden">
            <img 
              src={faceSprite} 
              alt={`Luca ${status}`} 
              className="mx-auto block w-full max-h-[180px] sm:max-h-none object-contain select-none" 
            />
          </div>
        </section>

        {/* Score Cards */}
        <section className="grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-2xl ring-1 ring-white/5 bg-white/5 p-2 sm:p-4 text-center shadow-xl backdrop-blur-lg">
            <p className="text-[10px] sm:text-sm text-slate-400 uppercase tracking-wider">Total</p>
            <p className="mt-1 text-2xl sm:text-3xl font-black">{score.total}</p>
          </div>
          <div className="rounded-2xl ring-1 ring-white/5 bg-white/5 p-2 sm:p-4 text-center shadow-xl backdrop-blur-lg">
            <p className="text-[10px] sm:text-sm text-slate-400 uppercase tracking-wider">Best</p>
            <p className="mt-1 text-2xl sm:text-3xl font-black">{score.best}</p>
          </div>
          <div className="rounded-2xl ring-1 ring-white/5 bg-white/5 p-2 sm:p-4 text-center shadow-xl backdrop-blur-lg">
            <p className="text-[10px] sm:text-sm text-slate-400 uppercase tracking-wider">Delta</p>
            <p className="mt-1 text-2xl sm:text-3xl font-black">{score.delta >= 0 ? `+${score.delta}` : score.delta}</p>
          </div>
        </section>

        {/* Action Buttons Container */}
        <section className="sticky bottom-0 z-10 -mx-3 -mb-5 mt-auto space-y-3 bg-white/5 p-4 backdrop-blur-lg sm:static sm:mx-0 sm:mb-0 sm:mt-0 sm:rounded-2xl sm:ring-1 sm:ring-white/5 sm:shadow-xl">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleStartRun}
              className="min-h-12 w-full rounded-xl border-b-4 border-blue-700 bg-blue-500 px-5 py-3 text-lg font-black text-white transition hover:brightness-110 active:translate-y-[2px] active:border-b-0"
            >
              Start Run
            </button>
            <button
              type="button"
              onClick={handleStopReset}
              className="min-h-12 w-full rounded-xl border-b-4 border-red-700 bg-red-600 px-5 py-3 text-lg font-black text-white transition hover:brightness-110 active:translate-y-[2px] active:border-b-0"
            >
              Stop
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {(['A', 'B', 'C'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => handleAnswer(choice)}
                className="min-h-[4rem] w-full rounded-xl border-b-4 border-cyan-700 bg-cyan-500 px-4 py-3 text-3xl font-black text-slate-950 transition hover:brightness-110 active:translate-y-[2px] active:border-b-0"
              >
                {choice}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleSimulateDrop}
            className="w-full text-xs font-bold text-slate-500 transition hover:text-slate-300"
          >
            Simulate Connection Drop
          </button>
        </section>

        {/* Timeline Section */}
        <section className="rounded-2xl ring-1 ring-white/5 bg-white/5 p-4 shadow-xl backdrop-blur-lg">
          <h2 className="text-sm font-semibold text-slate-400">Timeline</h2>
          <ul className="mt-3 space-y-2">
            {timeline.length === 0 ? (
              <li className="text-xs text-slate-600">Waiting for events...</li>
            ) : (
              timeline.map((item) => (
                <li key={item.id} className="flex gap-2 text-xs border-b border-white/5 pb-1 last:border-0">
                  <span className="font-mono text-slate-500 whitespace-nowrap">{item.timestamp}</span>
                  <span className="text-slate-300 truncate">{item.message}</span>
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
