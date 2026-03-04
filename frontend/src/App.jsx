import { useState, useEffect, useCallback, useRef } from 'react'

const API = import.meta.env.VITE_API_URL || ''

function api(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json())
}

// ── Excel Download Utility ──
function downloadTableAsExcel(tableId, filename) {
  const table = document.getElementById(tableId)
  if (!table) return

  const html = table.outerHTML
    .replace(/ class="[^"]*"/g, '')
    .replace(/ style="[^"]*"/g, '')
    .replace(/ title="[^"]*"/g, '')

  const blob = new Blob(
    [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
      'xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8">' +
      '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>' +
      '<x:ExcelWorksheet><x:Name>Sheet1</x:Name>' +
      '<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>' +
      '</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->' +
      '</head><body>' + html + '</body></html>'
    ],
    { type: 'application/vnd.ms-excel' }
  )

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.xls`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Snapshot Button ──
function SnapshotButton({ tableId, filename }) {
  return (
    <button
      className="btn btn-secondary"
      onClick={() => downloadTableAsExcel(tableId, filename || 'chimera_export')}
    >
      Export
    </button>
  )
}

// ── Status Badge ──
function Badge({ status }) {
  const colors = {
    RUNNING: '#16a34a',
    STOPPED: '#dc2626',
    STARTING: '#d97706',
    AUTH_FAILED: '#dc2626',
  }
  return (
    <span className="badge" style={{ background: colors[status] || '#6b7280' }}>
      {status || 'UNKNOWN'}
    </span>
  )
}

// ── Country Labels ──
const COUNTRY_LABELS = { GB: '🇬🇧 GB', IE: '🇮🇪 IE', ZA: '🇿🇦 ZA', FR: '🇫🇷 FR' }
const ALL_COUNTRIES = ['GB', 'IE', 'ZA', 'FR']

// ── Login Panel ──
function LoginPanel({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      if (res.status === 'ok') {
        onLogin(res.balance)
      } else {
        setError(res.message || 'Login failed')
      }
    } catch (err) {
      setError('Connection failed — is the backend running?')
    }
    setLoading(false)
  }

  return (
    <div className="login-panel">
      <div className="login-box">
        <h1>CHIMERA</h1>
        <p className="subtitle">Lay Engine v1.1</p>
        <form onSubmit={handleLogin}>
          <input
            type="text"
            placeholder="Betfair Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Betfair Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <button type="submit" disabled={loading || !username || !password}>
            {loading ? 'Authenticating...' : 'Login to Betfair'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </div>
  )
}

// ── Chat Drawer ──
function ChatDrawer({ isOpen, onClose, initialDate, initialMessage }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [listening, setListening] = useState(false)
  const [speakEnabled, setSpeakEnabled] = useState(true)
  const [date] = useState(initialDate || null)
  const messagesEndRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const inputRef = useRef(null)
  const initialSentRef = useRef(false)
  const currentAudioRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (isOpen && initialMessage && !initialSentRef.current) {
      initialSentRef.current = true
      sendMessage(initialMessage)
    }
  }, [isOpen, initialMessage])

  useEffect(() => {
    if (!isOpen) initialSentRef.current = false
  }, [isOpen])

  useEffect(() => {
    if (isOpen && !initialMessage) inputRef.current?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen && currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
  }, [isOpen])

  const speakText = async (text) => {
    if (!speakEnabled) return
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    try {
      const res = await fetch(`${API}/api/audio/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel()
          const utterance = new SpeechSynthesisUtterance(text)
          utterance.rate = 1.1
          window.speechSynthesis.speak(utterance)
        }
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudioRef.current = audio
      audio.onended = () => {
        URL.revokeObjectURL(url)
        currentAudioRef.current = null
      }
      audio.play()
    } catch (e) {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.1
        window.speechSynthesis.speak(utterance)
      }
    }
  }

  const sendMessage = async (text) => {
    if (!text.trim() || loading) return
    const userMsg = { role: 'user', content: text.trim() }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: text.trim(),
          history: messages,
          date: date,
        }),
      })
      if (res.reply) {
        const assistantMsg = { role: 'assistant', content: res.reply }
        setMessages([...updatedMessages, assistantMsg])
        speakText(res.reply)
      } else {
        setMessages([...updatedMessages, {
          role: 'assistant',
          content: `Error: ${res.message || 'Unknown error'}`
        }])
      }
    } catch (e) {
      setMessages([...updatedMessages, {
        role: 'assistant',
        content: 'Failed to connect to the analysis service.'
      }])
    }
    setLoading(false)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    sendMessage(input)
  }

  const toggleListening = async () => {
    if (listening) {
      mediaRecorderRef.current?.stop()
      setListening(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (blob.size < 100) return
        setLoading(true)
        try {
          const formData = new FormData()
          formData.append('file', blob, 'recording.webm')
          const res = await fetch(`${API}/api/audio/transcribe`, {
            method: 'POST',
            body: formData,
          })
          const data = await res.json()
          if (data.text && data.text.trim()) {
            sendMessage(data.text.trim())
          }
        } catch (e) {
          console.error('Transcription failed:', e)
          setLoading(false)
        }
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start()
      setListening(true)
    } catch (e) {
      alert('Microphone access denied or not available.')
    }
  }

  if (!isOpen) return null

  return (
    <div className="chat-overlay" onClick={onClose}>
      <div className="chat-drawer" onClick={e => e.stopPropagation()}>
        <div className="chat-header">
          <h3>CHIMERA AI{date ? ` — ${date}` : ''}</h3>
          <div className="chat-header-actions">
            <button
              className={`btn-sm ${speakEnabled ? 'btn-sm-active' : ''}`}
              onClick={() => {
                setSpeakEnabled(!speakEnabled)
                if (speakEnabled) {
                  currentAudioRef.current?.pause()
                  currentAudioRef.current = null
                  window.speechSynthesis?.cancel()
                }
              }}
              title={speakEnabled ? 'Mute voice' : 'Enable voice'}
            >
              {speakEnabled ? '🔊' : '🔇'}
            </button>
            <button className="btn-sm" onClick={() => {
              setMessages([])
              currentAudioRef.current?.pause()
              currentAudioRef.current = null
              window.speechSynthesis?.cancel()
            }}>Clear</button>
            <button className="btn-sm" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="chat-messages">
          {messages.length === 0 && !loading && (
            <p className="empty">Ask anything about your betting snapshots.</p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg chat-msg-${m.role}`}>
              <div className="chat-msg-content">{m.content}</div>
            </div>
          ))}
          {loading && (
            <div className="chat-msg chat-msg-assistant">
              <div className="chat-msg-content chat-loading">Thinking...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="chat-input-row" onSubmit={handleSubmit}>
          <button
            type="button"
            className={`btn-mic ${listening ? 'listening' : ''}`}
            onClick={toggleListening}
            title={listening ? 'Stop listening' : 'Speak'}
          >
            {listening ? '⏹' : '🎤'}
          </button>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about your snapshots..."
            disabled={loading}
          />
          <button type="submit" className="btn btn-primary" disabled={loading || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Shared Racing Card Tab (used by both Live and Dry Run tabs) ──
function LiveTab({ state, onStart, onStop, onResetBets, mode = 'live' }) {
  const [markets, setMarkets] = useState([])
  const [selectedMarketId, setSelectedMarketId] = useState(null)
  const [book, setBook] = useState(null)
  const [loadingBook, setLoadingBook] = useState(false)
  const [countryFilter, setCountryFilter] = useState('all')
  const [rulesOpen, setRulesOpen] = useState(false)
  const [settingsConfirmed, setSettingsConfirmed] = useState(
    () => localStorage.getItem('betSettingsConfirmed') === 'true'
  )

  const isDryRunMode = mode === 'dryrun'
  const isRunning = state.status === 'RUNNING'
  const isLiveRunning = isRunning && !state.dry_run
  const isDryRunning = isRunning && state.dry_run
  const isThisModeRunning = isDryRunMode ? isDryRunning : isLiveRunning
  const errors = state.errors || []
  const s = state.summary || {}
  const results = state.recent_results || []

  // Poll markets list every 30s
  useEffect(() => {
    const fetchMarkets = () =>
      api('/api/markets').then(d => setMarkets(d.markets || [])).catch(() => {})
    fetchMarkets()
    const id = setInterval(fetchMarkets, 30000)
    return () => clearInterval(id)
  }, [])

  // Fetch book when a market is selected
  useEffect(() => {
    if (!selectedMarketId) { setBook(null); return }
    setLoadingBook(true)
    api(`/api/markets/${selectedMarketId}/book`)
      .then(d => { setBook(d); setLoadingBook(false) })
      .catch(() => setLoadingBook(false))
  }, [selectedMarketId])

  // Auto-refresh selected book every 5s
  useEffect(() => {
    if (!selectedMarketId) return
    const id = setInterval(() => {
      api(`/api/markets/${selectedMarketId}/book`).then(d => setBook(d)).catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [selectedMarketId])

  // Group markets by venue (filtered by country)
  const filtered = countryFilter === 'all'
    ? markets
    : markets.filter(m => m.country === countryFilter)
  const byVenue = {}
  filtered.forEach(m => {
    if (!byVenue[m.venue]) byVenue[m.venue] = []
    byVenue[m.venue].push(m)
  })

  // Bets indexed by market_id — only show bets relevant to this mode
  const betsByMarket = {}
  ;(state.recent_bets || [])
    .filter(b => isDryRunMode ? b.dry_run : !b.dry_run)
    .forEach(b => { if (b.market_id) betsByMarket[b.market_id] = b })

  const availableCountries = [...new Set(markets.map(m => m.country))].filter(Boolean)

  const bookPercent = book?.runners?.reduce((sum, r) => {
    const bp = r.back?.[0]?.price
    return sum + (bp ? (1 / bp) * 100 : 0)
  }, 0) || 0
  const bookPctClass = bookPercent <= 101 ? 'tight' : bookPercent <= 103 ? 'normal' : 'wide'

  const fmtTime = iso => {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    catch { return '' }
  }

  return (
    <div className="live-racing-tab">

      {/* ── Control Bar ── */}
      <div className="live-control-bar">
        <div className="live-control-left">
          {isDryRunMode ? (
            // ── Dry Run controls ──
            isThisModeRunning ? (
              <>
                <button className="btn btn-danger" onClick={onStop}>Stop Dry Run</button>
                {onResetBets && (
                  <button className="btn btn-secondary" onClick={onResetBets}>Clear &amp; Re-process</button>
                )}
                <span className="badge badge-warning" style={{ fontSize: 11 }}>PAPER BETS ONLY</span>
                {state.last_scan && (
                  <span className="live-scan-time">
                    Last scan: {new Date(state.last_scan).toLocaleTimeString()}
                    {s.monitoring > 0 && ` · ${s.monitoring} monitoring`}
                    {s.processed != null && ` · ${s.processed} processed`}
                  </span>
                )}
              </>
            ) : (
              <>
                <button
                  className="btn btn-warning btn-auto-bet"
                  onClick={() => onStart('dryrun')}
                  disabled={!settingsConfirmed}
                  title={!settingsConfirmed ? 'Confirm your parameters in Bet Settings first' : 'Start dry run simulation'}
                >
                  Start Dry Run
                </button>
                <span className="badge badge-warning" style={{ fontSize: 11 }}>PAPER BETS ONLY — No real money at risk</span>
                {!settingsConfirmed ? (
                  <span className="live-settings-note">
                    Go to <strong>Bet Settings</strong> and confirm your parameters first.
                  </span>
                ) : isRunning && !state.dry_run ? (
                  <span className="live-settings-note warn">
                    Engine running in Live mode — stop it in the Live tab first.
                  </span>
                ) : (
                  <span className="live-settings-note ready">Settings confirmed — ready to simulate</span>
                )}
              </>
            )
          ) : (
            // ── Live controls ──
            isThisModeRunning ? (
              <>
                <button className="btn btn-danger" onClick={onStop}>Stop Auto Betting</button>
                <span className="live-active-badge">AUTO BETTING ACTIVE</span>
                {state.last_scan && (
                  <span className="live-scan-time">
                    Last scan: {new Date(state.last_scan).toLocaleTimeString()}
                    {s.monitoring > 0 && ` · ${s.monitoring} monitoring`}
                    {s.processed != null && ` · ${s.processed} processed`}
                  </span>
                )}
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary btn-auto-bet"
                  onClick={() => onStart('live')}
                  disabled={!settingsConfirmed}
                  title={!settingsConfirmed ? 'Confirm your parameters in Bet Settings first' : 'Start auto live betting'}
                >
                  Auto Live Bet
                </button>
                {!settingsConfirmed ? (
                  <span className="live-settings-note">
                    Go to <strong>Bet Settings</strong> and confirm your parameters before enabling auto betting.
                  </span>
                ) : isRunning && state.dry_run ? (
                  <span className="live-settings-note warn">
                    Engine running in Dry Run mode — stop it in the Dry Run tab first.
                  </span>
                ) : (
                  <span className="live-settings-note ready">Settings confirmed — ready to auto bet</span>
                )}
              </>
            )
          )}
        </div>
        <div className="live-control-right">
          {availableCountries.length > 0 && (
            <div className="live-country-filter">
              <button
                className={`btn-filter ${countryFilter === 'all' ? 'active' : ''}`}
                onClick={() => setCountryFilter('all')}
              >All</button>
              {availableCountries.map(c => (
                <button
                  key={c}
                  className={`btn-filter ${countryFilter === c ? 'active' : ''}`}
                  onClick={() => setCountryFilter(c)}
                >
                  {COUNTRY_LABELS[c] || c}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Error bar */}
      {errors.length > 0 && (
        <div className="live-error-bar">
          <strong>{errors.length} error{errors.length !== 1 ? 's' : ''}</strong>{' '}
          {errors[errors.length - 1]?.message}
        </div>
      )}

      {/* Dry Run P&L summary strip */}
      {isDryRunMode && s.dry_run_bets > 0 && (
        <div className="dryrun-pnl-strip">
          <span>Paper Bets: <strong>{s.dry_run_bets}</strong></span>
          <span>Wins: <strong style={{ color: '#16a34a' }}>{s.dry_run_wins || 0}</strong></span>
          <span>Losses: <strong style={{ color: '#dc2626' }}>{s.dry_run_losses || 0}</strong></span>
          <span>Pending: <strong>{s.dry_run_pending || 0}</strong></span>
          <span>
            Paper P&amp;L:{' '}
            <strong style={{ color: (s.dry_run_pnl || 0) >= 0 ? '#16a34a' : '#dc2626' }}>
              {(s.dry_run_pnl || 0) >= 0 ? '+' : ''}£{(s.dry_run_pnl || 0).toFixed(2)}
            </strong>
          </span>
        </div>
      )}

      {/* ── Two-column racing layout ── */}
      <div className="live-racing-layout">

        {/* Left: race list */}
        <div className="live-racing-list">
          {Object.keys(byVenue).length === 0 ? (
            <p style={{ padding: '16px 12px', fontSize: 12, color: '#8a8a9a' }}>
              No markets available. Markets appear once races are scheduled for your selected countries.
            </p>
          ) : (
            Object.entries(byVenue).map(([venue, races]) => (
              <div key={venue} className="live-venue-group">
                <div className="live-venue-header">{venue}</div>
                {races.map(race => {
                  const bet = betsByMarket[race.market_id]
                  const isSelected = selectedMarketId === race.market_id
                  const mins = race.minutes_to_off
                  const isInPlay = mins != null && mins <= 0
                  const isInWindow = mins != null && mins > 0 && mins <= (state.process_window || 12)
                  return (
                    <div
                      key={race.market_id}
                      className={`live-race-row${isSelected ? ' selected' : ''}${isInPlay ? ' in-play' : ''}${isInWindow ? ' in-window' : ''}`}
                      onClick={() => setSelectedMarketId(prev => prev === race.market_id ? null : race.market_id)}
                    >
                      <span className="live-race-time">{fmtTime(race.race_time)}</span>
                      <div className="live-race-info">
                        <span className="live-race-name">{race.market_name}</span>
                        <div className="live-race-meta">
                          {isInPlay
                            ? <span className="badge badge-live" style={{ fontSize: 9, padding: '1px 5px' }}>IN PLAY</span>
                            : isInWindow
                            ? <span className="race-badge-window">in window · {Math.round(mins)}m</span>
                            : mins != null && mins > 0
                            ? <span className="race-badge-mins">{Math.round(mins)}m</span>
                            : null
                          }
                        </div>
                      </div>
                      {bet && (
                        <div className="live-race-bet-col">
                          <span className="race-bet-runner" title={bet.runner_name}>{bet.runner_name}</span>
                          {bet.outcome
                            ? <span className={`race-bet-result ${bet.outcome === 'WIN' ? 'result-won' : 'result-lost'}`}>
                                {bet.outcome === 'WIN' ? '+' : ''}£{(bet.pnl || 0).toFixed(2)}
                              </span>
                            : <span className="race-bet-pending">{isDryRunMode ? 'paper' : 'placed'}</span>
                          }
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Right: market book */}
        <div className="live-book-panel">
          {!selectedMarketId && (
            <div className="live-book-empty">
              <span>Select a race to view market prices</span>
            </div>
          )}
          {selectedMarketId && loadingBook && !book && (
            <p style={{ padding: 20, color: '#8a8a9a', fontSize: 12 }}>Loading market...</p>
          )}
          {book && (
            <div className="live-book-inner">
              <div className="market-header">
                <div className="market-title">
                  {fmtTime(book.race_time)} {book.venue} — {book.market_name}
                </div>
                <div className="market-meta">
                  <span>{book.number_of_runners} runners</span>
                  <span className={`book-percent ${bookPctClass}`}>{bookPercent.toFixed(1)}%</span>
                  <span className="market-matched">
                    Matched: GBP {(book.total_matched || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  {book.in_play && <span className="badge badge-live">IN PLAY</span>}
                  {book.status && book.status !== 'OPEN' && (
                    <span className="badge badge-crashed">{book.status}</span>
                  )}
                </div>
              </div>

              {/* Our bet / paper bet on this race */}
              {betsByMarket[selectedMarketId] && (() => {
                const b = betsByMarket[selectedMarketId]
                const cls = b.outcome === 'WIN' ? 'bet-won' : b.outcome === 'LOSS' ? 'bet-lost' : 'bet-active'
                return (
                  <div className={`live-our-bet ${cls}`}>
                    {isDryRunMode && <span className="badge badge-warning" style={{ fontSize: 9, marginRight: 4 }}>PAPER</span>}
                    <span>{isDryRunMode ? 'Paper Lay' : 'Our Lay'}: <strong>{b.runner_name}</strong></span>
                    <span>@ {b.price?.toFixed(2)}</span>
                    <span>Stake £{b.size?.toFixed(2)}</span>
                    <span>Liability £{b.liability?.toFixed(2)}</span>
                    <code>{b.rule_applied}</code>
                    {b.outcome
                      ? <strong className={b.outcome === 'WIN' ? 'text-success' : 'text-danger'}>
                          {b.outcome} {b.pnl != null ? `${b.pnl >= 0 ? '+' : ''}£${b.pnl.toFixed(2)}` : ''}
                        </strong>
                      : <span className="text-muted">awaiting result</span>
                    }
                  </div>
                )
              })()}

              <table className="market-table">
                <thead>
                  <tr>
                    <th style={{ width: '35%' }}></th>
                    <th className="bf-back-header" colSpan={3}>Back all</th>
                    <th className="bf-lay-header" colSpan={3}>Lay all</th>
                  </tr>
                </thead>
                <tbody>
                  {book.runners.map(runner => {
                    const isOurBet = betsByMarket[selectedMarketId]?.runner_name === runner.runner_name
                    return (
                      <tr
                        key={runner.selection_id}
                        className={`${runner.status !== 'ACTIVE' ? 'runner-removed' : ''}${isOurBet ? ' runner-our-lay' : ''}`}
                      >
                        <td className="runner-cell">
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span className="runner-cloth">{runner.sort_priority}</span>
                            <span className="runner-name">{runner.runner_name}</span>
                            {isOurBet && <span className="runner-lay-badge">{isDryRunMode ? 'PAPER LAY' : 'OUR LAY'}</span>}
                          </div>
                          {runner.status !== 'ACTIVE' && <div className="runner-jockey">Non-runner</div>}
                        </td>
                        <PriceCell price={runner.back?.[2]?.price} size={runner.back?.[2]?.size} type="back" level={3} />
                        <PriceCell price={runner.back?.[1]?.price} size={runner.back?.[1]?.size} type="back" level={2} />
                        <PriceCell price={runner.back?.[0]?.price} size={runner.back?.[0]?.size} type="back" level={1} />
                        <PriceCell price={runner.lay?.[0]?.price} size={runner.lay?.[0]?.size} type="lay" level={1} />
                        <PriceCell price={runner.lay?.[1]?.price} size={runner.lay?.[1]?.size} type="lay" level={2} />
                        <PriceCell price={runner.lay?.[2]?.price} size={runner.lay?.[2]?.size} type="lay" level={3} />
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>

      {/* Rule Evaluations — dry run only, below the racing layout */}
      {isDryRunMode && (
        <div className="collapsible-section" style={{ borderTop: '1px solid #e5e7eb', marginTop: 0 }}>
          <button
            className="collapsible-header"
            onClick={() => setRulesOpen(o => !o)}
          >
            <span>Rule Evaluations</span>
            <span className="collapsible-count">{results.length}</span>
            <span className="collapsible-chevron">{rulesOpen ? '-' : '+'}</span>
          </button>
          {rulesOpen && (
            <div className="collapsible-body">
              {results.length === 0 ? (
                <p className="empty">No markets evaluated yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Venue</th>
                      <th>Race</th>
                      <th>Favourite</th>
                      <th>Odds</th>
                      <th>2nd Fav</th>
                      <th>Odds</th>
                      <th>Rule</th>
                      <th>Bets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={i} className={r.skipped ? 'row-skip' : ''}>
                        <td>{r.venue}</td>
                        <td>{r.market_name}</td>
                        <td>{r.favourite?.name || '—'}</td>
                        <td>{r.favourite?.odds?.toFixed(2) || '—'}</td>
                        <td>{r.second_favourite?.name || '—'}</td>
                        <td>{r.second_favourite?.odds?.toFixed(2) || '—'}</td>
                        <td>
                          {r.skipped
                            ? <span className="skip">{r.skip_reason}</span>
                            : <code>{r.rule_applied}</code>
                          }
                        </td>
                        <td>{r.instructions?.length || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Bet Settings Tab ──
function BetSettingsTab({ state, onToggleCountry, onToggleJofs, onToggleSpread, onToggleMarkCeiling, onToggleMarkFloor, onToggleMarkUplift, onSetProcessWindow, onSetPointValue }) {
  const s = state.summary || {}
  const [confirmed, setConfirmed] = useState(
    () => localStorage.getItem('betSettingsConfirmed') === 'true'
  )

  const handleConfirm = () => {
    localStorage.setItem('betSettingsConfirmed', 'true')
    setConfirmed(true)
  }

  const handleReset = () => {
    localStorage.removeItem('betSettingsConfirmed')
    setConfirmed(false)
  }
  return (
    <div className="engine-tab">

      <div className="engine-section">
        <h3>Timing</h3>
        <p style={{ color: '#8a8a9a', fontSize: 13, marginBottom: 10 }}>
          How many minutes before the scheduled off time should the engine place bets. This applies to both Live and Dry Run modes.
        </p>
        <div className="engine-row">
          <label className="engine-label">
            Bet time before off:
            <select
              value={state.process_window || 12}
              onChange={e => onSetProcessWindow(+e.target.value)}
            >
              {[5, 8, 10, 12, 15, 20, 30].map(v => (
                <option key={v} value={v}>{v} min before off</option>
              ))}
            </select>
          </label>
          <label className="engine-label">
            Stake point value (£):
            <select
              value={state.point_value || 1}
              onChange={e => onSetPointValue(e.target.value)}
            >
              {[1, 2, 5, 10, 20, 50].map(v => (
                <option key={v} value={v}>£{v} per point</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="engine-section">
        <h3>Markets</h3>
        <div className="engine-row">
          <div className="country-toggles">
            <span className="engine-label">Countries:</span>
            {ALL_COUNTRIES.map(c => (
              <button
                key={c}
                className={`btn-toggle ${(state.countries || ['GB', 'IE']).includes(c) ? 'active' : ''}`}
                onClick={() => onToggleCountry(c)}
              >
                {COUNTRY_LABELS[c] || c}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="engine-section">
        <h3>Risk Controls</h3>
        <div className="engine-row">
          <span className="engine-label">JOFS (Joint Favourite Split):</span>
          <button
            className={`btn-toggle ${state.jofs_control ? 'active' : ''}`}
            onClick={onToggleJofs}
            title="When gap between 1st and 2nd favourite is ≤ 0.2, stake is split evenly across both"
          >
            {state.jofs_control ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Spread Control:</span>
          <button
            className={`btn-toggle ${state.spread_control ? 'active' : ''}`}
            onClick={onToggleSpread}
            title="Validates back-lay spreads to reject bets in illiquid markets"
          >
            {state.spread_control ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="engine-info" style={{ marginTop: 8 }}>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            JOFS: splits stake evenly when 1st/2nd favourite gap ≤ 0.2 odds
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Spread Control: rejects bets when back-lay spread indicates illiquid market
          </span>
          {s.spread_rejections > 0 && (
            <span>Spread rejected this session: <strong style={{ color: '#d97706' }}>{s.spread_rejections}</strong></span>
          )}
          {s.jofs_splits > 0 && (
            <span>JOFS splits this session: <strong style={{ color: '#7c3aed' }}>{s.jofs_splits}</strong></span>
          )}
        </div>
      </div>

      {/* Mark Rules */}
      <div className="engine-section">
        <h3>Mark Rules</h3>
        <div className="engine-row">
          <span className="engine-label">Hard Ceiling (&gt;8.0 skip):</span>
          <button
            className={`btn-toggle ${state.mark_ceiling_enabled ? 'active' : ''}`}
            onClick={onToggleMarkCeiling}
            title="No lays above 8.0 odds — skip market entirely"
          >
            {state.mark_ceiling_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Hard Floor (&lt;1.5 skip):</span>
          <button
            className={`btn-toggle ${state.mark_floor_enabled ? 'active' : ''}`}
            onClick={onToggleMarkFloor}
            title="No lays below 1.5 odds — skip market entirely"
          >
            {state.mark_floor_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>2.5–3.5 Uplift (5 pts):</span>
          <button
            className={`btn-toggle ${state.mark_uplift_enabled ? 'active' : ''}`}
            onClick={onToggleMarkUplift}
            title="When favourite odds are 2.5–3.5, increase stake to 5 points"
          >
            {state.mark_uplift_enabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Confirm Settings */}
      <div className="engine-section bet-settings-confirm">
        <h3>Confirm Settings</h3>
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
          Review your parameters above, then confirm to enable the <strong>Auto Live Bet</strong> button on the Live tab.
          If you change settings later, re-confirm to keep Auto Betting enabled.
        </p>
        {confirmed ? (
          <div className="bet-settings-confirmed-row">
            <span className="settings-confirmed-badge">✓ Settings Confirmed</span>
            <button className="btn btn-secondary btn-sm" onClick={handleReset}>Reset</button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={handleConfirm}>
            ✓ Confirm &amp; Save Settings
          </button>
        )}
      </div>
    </div>
  )
}

// ── Backtest Tab ──
function BacktestTab() {
  return (
    <div className="backtest-tab">
      <h2>Backtest</h2>
      <p className="empty-state">
        Backtesting module coming soon. This will allow you to test JOFS thresholds,
        processing window timings, and rule parameters against historical Betfair data.
      </p>
      <div className="backtest-placeholder">
        <div className="placeholder-section">
          <h3>Data Sources</h3>
          <p>Live recorded data (Data Recorder) · Betfair historic data · Engine snapshots</p>
        </div>
        <div className="placeholder-section">
          <h3>Parameters</h3>
          <p>JOFS threshold · Processing window · Odds bands · Stake sizing · Venue filters</p>
        </div>
        <div className="placeholder-section">
          <h3>Output</h3>
          <p>Simulated P&amp;L · Strike rate by parameter · Optimal configuration recommendations</p>
        </div>
      </div>
    </div>
  )
}

// ── Strategy Tab ──
function StrategyTab() {
  return (
    <div className="backtest-tab">
      <h2>Strategy</h2>
      <p className="empty-state">
        Strategy builder coming soon. Define and manage custom rule sets, configure betting
        strategies by odds bands, venue filters, and race types.
      </p>
      <div className="backtest-placeholder">
        <div className="placeholder-section">
          <h3>Rule Builder</h3>
          <p>Create custom rules · Odds band targeting · Favourite gap thresholds · Time-of-day filters</p>
        </div>
        <div className="placeholder-section">
          <h3>Venue &amp; Race Filters</h3>
          <p>Include/exclude venues · Race discipline filters · Going conditions · Field size limits</p>
        </div>
        <div className="placeholder-section">
          <h3>Stake Management</h3>
          <p>Level stakes · Percentage of bank · Stop-loss triggers · Daily limits</p>
        </div>
      </div>
    </div>
  )
}

// ── Shared date formatter ──
const formatDateHeader = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

// ── History Tab (Sessions + Matched + Settled) ──
function HistoryTab({ openChat }) {
  const [subTab, setSubTab] = useState('sessions')
  return (
    <div>
      <div className="sub-tabs">
        {['sessions', 'matched', 'settled'].map(t => (
          <button
            key={t}
            className={subTab === t ? 'active' : ''}
            onClick={() => setSubTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {subTab === 'sessions' && <SessionsTab openChat={openChat} />}
      {subTab === 'matched' && <MatchedTab />}
      {subTab === 'settled' && <SettledTab openChat={openChat} />}
    </div>
  )
}

// ── Sessions Tab (formerly SnapshotsTab) ──
function SessionsTab({ openChat }) {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api('/api/sessions')
      .then(data => {
        setSessions(data.sessions || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    api(`/api/sessions/${selectedId}`)
      .then(data => setDetail(data))
      .catch(() => setDetail(null))
  }, [selectedId])

  if (loading) return <p className="empty">Loading sessions...</p>

  // ── Detail View ──
  if (detail) {
    const bets = detail.bets || []
    const sm = detail.summary || {}
    const isDryRun = detail.mode === 'DRY_RUN'

    // Calculate paper P&L from bets if not in summary
    const settledBets = isDryRun ? bets.filter(b => b.outcome === 'WIN' || b.outcome === 'LOSS') : []
    const paperPnl = sm.paper_pnl ?? settledBets.reduce((acc, b) => acc + (b.pnl || 0), 0)
    const paperWins = sm.paper_wins ?? settledBets.filter(b => b.outcome === 'WIN').length
    const paperLosses = sm.paper_losses ?? settledBets.filter(b => b.outcome === 'LOSS').length

    return (
      <div>
        <div className="session-detail-header">
          <button className="btn btn-secondary btn-back" onClick={() => setSelectedId(null)}>
            ← Back
          </button>
          <h2>
            <span className={`badge ${detail.mode === 'LIVE' ? 'badge-live' : 'badge-dry'}`}>
              {detail.mode}
            </span>
            {' '}{detail.date}{' '}
            {new Date(detail.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {detail.stop_time && (
              <> – {new Date(detail.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
            )}
          </h2>
          <SnapshotButton tableId="session-bets-table" filename={`snapshot_${detail.session_id}`} />
        </div>
        <div className="session-stats">
          <span>Bets: <strong>{sm.total_bets || 0}</strong></span>
          <span>Staked: <strong>£{(sm.total_stake || 0).toFixed(2)}</strong></span>
          <span>Liability: <strong>£{(sm.total_liability || 0).toFixed(2)}</strong></span>
          <span>Markets: <strong>{sm.markets_processed || 0}</strong></span>
          {isDryRun && settledBets.length > 0 && (
            <>
              <span>Wins: <strong style={{ color: '#16a34a' }}>{paperWins}</strong></span>
              <span>Losses: <strong style={{ color: '#dc2626' }}>{paperLosses}</strong></span>
              <span>
                Paper P&amp;L:{' '}
                <strong style={{ color: paperPnl >= 0 ? '#16a34a' : '#dc2626' }}>
                  {paperPnl >= 0 ? '+' : ''}£{paperPnl.toFixed(2)}
                </strong>
              </span>
            </>
          )}
          <span className={`badge badge-${detail.status.toLowerCase()}`}>{detail.status}</span>
        </div>
        <div className="table-scroll">
          {bets.length === 0 ? (
            <p className="empty">No bets in this session.</p>
          ) : (
            <table id="session-bets-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Country</th>
                  <th>Runner</th>
                  <th>Odds</th>
                  <th>Stake</th>
                  <th>Liability</th>
                  <th>Rule</th>
                  <th>Status</th>
                  {isDryRun && <th>Outcome</th>}
                  {isDryRun && <th>Paper P&amp;L</th>}
                </tr>
              </thead>
              <tbody>
                {bets.map((b, i) => {
                  const outcome = b.outcome
                  const rowClass = outcome === 'WIN' ? 'row-win' : outcome === 'LOSS' ? 'row-loss' : (b.dry_run ? 'row-dry' : '')
                  return (
                    <tr key={i} className={rowClass}>
                      <td>{new Date(b.timestamp).toLocaleTimeString()}</td>
                      <td>{b.country || '—'}</td>
                      <td>{b.runner_name}</td>
                      <td className="cell-lay-odds">{b.price?.toFixed(2)}</td>
                      <td>£{b.size?.toFixed(2)}</td>
                      <td>£{b.liability?.toFixed(2)}</td>
                      <td><code>{b.rule_applied}</code></td>
                      <td>
                        {b.dry_run
                          ? <span className="badge-dry">DRY</span>
                          : <span className={`status-${b.betfair_response?.status?.toLowerCase()}`}>
                              {b.betfair_response?.status || '?'}
                            </span>
                        }
                      </td>
                      {isDryRun && (
                        <td>
                          {outcome
                            ? <span className={outcome === 'WIN' ? 'text-success' : outcome === 'LOSS' ? 'text-danger' : 'text-muted'}>
                                {outcome}
                              </span>
                            : <span className="text-muted">pending</span>
                          }
                        </td>
                      )}
                      {isDryRun && (
                        <td>
                          {b.pnl != null
                            ? <span className={b.pnl >= 0 ? 'text-success' : 'text-danger'}>
                                {b.pnl >= 0 ? '+' : ''}£{b.pnl.toFixed(2)}
                              </span>
                            : <span className="text-muted">—</span>
                          }
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  // Group sessions by date
  const grouped = {}
  sessions.forEach(s => {
    if (!grouped[s.date]) grouped[s.date] = []
    grouped[s.date].push(s)
  })
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a))

  const getSessionCountries = (s) => {
    const countries = s.countries || s.summary?.countries || []
    return countries.map(c => COUNTRY_LABELS[c] || c).join(' ')
  }

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Sessions</h2>
        {sortedDates.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={() => openChat(
              sortedDates[0],
              `Provide a comprehensive analysis of today's snapshot data (${sortedDates[0]}). Cover odds drift patterns, rule distribution, risk exposure, venue patterns, timing observations, anomalies, and actionable suggestions for rule tuning. Format as 6-10 concise bullet points with specific numbers.`
            )}
          >
            AI Analysis
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className="empty">No sessions recorded yet. Start the engine to create one.</p>
      ) : (
        <div className="snapshots-grouped">
          {sortedDates.map(date => (
            <div key={date} className="snapshots-date-group">
              <div className="snapshots-date-header">
                <span className="snapshots-date-label">{formatDateHeader(date)}</span>
                <span className="snapshots-date-count">{grouped[date].length} session{grouped[date].length !== 1 ? 's' : ''}</span>
              </div>
              <div className="snapshots-list">
                {grouped[date].map(s => {
                  const isDry = s.mode === 'DRY_RUN'
                  const hasPaper = isDry && s.summary?.paper_pnl != null
                  return (
                    <div
                      key={s.session_id}
                      className="card"
                      onClick={() => setSelectedId(s.session_id)}
                    >
                      <div className="session-card-top">
                        <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'badge-dry'}`}>
                          {s.mode === 'LIVE' ? 'LIVE' : 'DRY RUN'}
                        </span>
                        <span className="session-card-time">
                          {new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          {s.stop_time
                            ? ` – ${new Date(s.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                            : ' – running'}
                        </span>
                        <span className={`badge badge-${s.status.toLowerCase()}`}>{s.status}</span>
                      </div>
                      <div className="session-card-details">
                        <span className="session-card-countries">{getSessionCountries(s) || '—'}</span>
                        <span>Bets: <strong>{s.summary?.total_bets || 0}</strong></span>
                        <span>Staked: <strong>£{(s.summary?.total_stake || 0).toFixed(2)}</strong></span>
                        <span>Liability: <strong>£{(s.summary?.total_liability || 0).toFixed(2)}</strong></span>
                        {hasPaper && (
                          <span>
                            Paper P&amp;L:{' '}
                            <strong style={{ color: s.summary.paper_pnl >= 0 ? '#16a34a' : '#dc2626' }}>
                              {s.summary.paper_pnl >= 0 ? '+' : ''}£{s.summary.paper_pnl.toFixed(2)}
                            </strong>
                            {' '}({s.summary.paper_wins || 0}W/{s.summary.paper_losses || 0}L)
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Date Range Filter (shared) ──
function DateRangeFilter({ dateFrom, dateTo, onDateFromChange, onDateToChange }) {
  const today = new Date().toISOString().slice(0, 10)

  const setPreset = (preset) => {
    const now = new Date()
    let from = today, to = today
    if (preset === 'yesterday') {
      const y = new Date(now); y.setDate(y.getDate() - 1)
      from = to = y.toISOString().slice(0, 10)
    } else if (preset === '7days') {
      const d = new Date(now); d.setDate(d.getDate() - 6)
      from = d.toISOString().slice(0, 10)
    } else if (preset === 'month') {
      from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    }
    onDateFromChange(from)
    onDateToChange(to)
  }

  return (
    <div className="date-range-filter">
      <div className="date-presets">
        <button className="btn-preset" onClick={() => setPreset('today')}>Today</button>
        <button className="btn-preset" onClick={() => setPreset('yesterday')}>Yesterday</button>
        <button className="btn-preset" onClick={() => setPreset('7days')}>Last 7 Days</button>
        <button className="btn-preset" onClick={() => setPreset('month')}>This Month</button>
      </div>
      <div className="date-inputs">
        <label>From:</label>
        <input type="date" value={dateFrom} onChange={e => onDateFromChange(e.target.value)} max={today} />
        <label>To:</label>
        <input type="date" value={dateTo} onChange={e => onDateToChange(e.target.value)} max={today} />
      </div>
    </div>
  )
}

// ── Price Cell (Betfair-style) ──
function PriceCell({ price, size, type, level }) {
  if (!price) return <td className={`bf-${type}-${level} bf-empty`}>—</td>
  const formatted = price >= 100 ? Math.round(price) : price >= 10 ? price.toFixed(1) : price.toFixed(2)
  return (
    <td className={`bf-${type}-${level}`}>
      <div className="bf-price">{formatted}</div>
      <div className="bf-size">£{Math.round(size)}</div>
    </td>
  )
}

// ── Market Tab (live Betfair market view) ──
function MarketTab() {
  const [markets, setMarkets] = useState([])
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [book, setBook] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const fetchMarkets = () => {
      api('/api/markets')
        .then(data => {
          setMarkets(data.markets || [])
          setSelectedMarketId(prev => {
            if (!prev && data.markets?.length) {
              const next = data.markets.find(m => m.minutes_to_off > 0)
              return next ? next.market_id : (data.markets[0]?.market_id || '')
            }
            return prev
          })
        })
        .catch(() => {})
    }
    fetchMarkets()
    const interval = setInterval(fetchMarkets, 60000)
    return () => clearInterval(interval)
  }, [])

  const fetchBook = useCallback(() => {
    if (!selectedMarketId) return
    setLoading(true)
    api(`/api/markets/${selectedMarketId}/book`)
      .then(data => { setBook(data); setLoading(false) })
      .catch(() => { setBook(null); setLoading(false) })
  }, [selectedMarketId])

  useEffect(() => { fetchBook() }, [fetchBook])

  useEffect(() => {
    if (!autoRefresh || !selectedMarketId) return
    const interval = setInterval(fetchBook, 5000)
    return () => clearInterval(interval)
  }, [autoRefresh, selectedMarketId, fetchBook])

  const bookPercent = book?.runners?.reduce((sum, r) => {
    const bestBack = r.back?.[0]?.price
    return sum + (bestBack ? (1 / bestBack) * 100 : 0)
  }, 0) || 0

  const bookPercentClass = bookPercent <= 101 ? 'tight' : bookPercent <= 103 ? 'normal' : 'wide'

  const formatRaceTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    catch { return '' }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="market-selector">
        <select
          value={selectedMarketId}
          onChange={e => { setSelectedMarketId(e.target.value); setBook(null) }}
        >
          <option value="">Select a market...</option>
          {markets.map(m => (
            <option key={m.market_id} value={m.market_id}>
              {formatRaceTime(m.race_time)} {m.venue} — {m.market_name} ({m.country})
              {m.minutes_to_off > 0 ? ` [${Math.round(m.minutes_to_off)}m]` : ' [IN PLAY]'}
            </option>
          ))}
        </select>
        <label className="auto-refresh-label">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
      </div>

      {loading && !book && <p className="empty">Loading market book...</p>}

      {book && (
        <>
          <div className="market-header">
            <div>
              <div className="market-title">
                {formatRaceTime(book.race_time)} {book.venue} — {book.market_name}
              </div>
              <div className="market-meta">
                <span>{book.number_of_runners} selections</span>
                <span className={`book-percent ${bookPercentClass}`}>{bookPercent.toFixed(1)}%</span>
                <span className="market-matched">
                  Matched: GBP {(book.total_matched || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                {book.in_play && <span className="badge badge-live">IN PLAY</span>}
                {book.status && book.status !== 'OPEN' && (
                  <span className="badge badge-crashed">{book.status}</span>
                )}
              </div>
            </div>
          </div>

          <table className="market-table">
            <thead>
              <tr>
                <th style={{ width: '35%' }}></th>
                <th className="bf-back-header" colSpan={3}>Back all</th>
                <th className="bf-lay-header" colSpan={3}>Lay all</th>
              </tr>
            </thead>
            <tbody>
              {book.runners.map(runner => (
                <tr key={runner.selection_id} className={runner.status !== 'ACTIVE' ? 'runner-removed' : ''}>
                  <td className="runner-cell">
                    <div>
                      <span className="runner-cloth">{runner.sort_priority}</span>
                      <span className="runner-name">{runner.runner_name}</span>
                    </div>
                    {runner.status !== 'ACTIVE' && <div className="runner-jockey">Non-runner</div>}
                  </td>
                  <PriceCell price={runner.back?.[2]?.price} size={runner.back?.[2]?.size} type="back" level={3} />
                  <PriceCell price={runner.back?.[1]?.price} size={runner.back?.[1]?.size} type="back" level={2} />
                  <PriceCell price={runner.back?.[0]?.price} size={runner.back?.[0]?.size} type="back" level={1} />
                  <PriceCell price={runner.lay?.[0]?.price} size={runner.lay?.[0]?.size} type="lay" level={1} />
                  <PriceCell price={runner.lay?.[1]?.price} size={runner.lay?.[1]?.size} type="lay" level={2} />
                  <PriceCell price={runner.lay?.[2]?.price} size={runner.lay?.[2]?.size} type="lay" level={3} />
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ── Matched Tab (live bets placed on Betfair) ──
function MatchedTab() {
  const today = new Date().toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedBets, setExpandedBets] = useState(new Set())
  const [collapsedDays, setCollapsedDays] = useState(new Set())

  const fetchMatched = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api(`/api/matched?date_from=${dateFrom}&date_to=${dateTo}`)
      setData(res)
    } catch (e) {
      console.error('Failed to fetch matched bets:', e)
    }
    setLoading(false)
  }, [dateFrom, dateTo])

  useEffect(() => { fetchMatched() }, [fetchMatched])

  const toggleBet = (key) => {
    setExpandedBets(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const toggleDay = (date) => {
    setCollapsedDays(prev => {
      const next = new Set(prev)
      next.has(date) ? next.delete(date) : next.add(date)
      return next
    })
  }

  const fname = `chimera_matched_${dateFrom}_${dateTo}`

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Matched Bets</h2>
        {data && data.count > 0 && (
          <SnapshotButton tableId="matched-export-table" filename={fname} />
        )}
      </div>

      <DateRangeFilter
        dateFrom={dateFrom} dateTo={dateTo}
        onDateFromChange={setDateFrom} onDateToChange={setDateTo}
      />

      {data && (
        <div className="matched-summary">
          <span>Total: <strong>{data.count}</strong></span>
          <span>Staked: <strong>£{(data.total_stake || 0).toFixed(2)}</strong></span>
          <span>Liability: <strong>£{(data.total_liability || 0).toFixed(2)}</strong></span>
          <span>Avg Odds: <strong>{(data.avg_odds || 0).toFixed(2)}</strong></span>
        </div>
      )}

      {loading && <p className="empty">Loading matched bets...</p>}

      {!loading && data && data.count === 0 && (
        <p className="empty">No live matched bets found for this period.</p>
      )}

      {!loading && data && data.bets_by_date && (
        <div className="matched-grouped">
          <table id="matched-export-table" style={{ display: 'none' }}>
            <thead>
              <tr>
                <th>Date</th><th>Time</th><th>Venue</th><th>Country</th>
                <th>Runner</th><th>Odds</th><th>Stake</th><th>Liability</th>
                <th>Rule</th><th>Status</th><th>Bet ID</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.bets_by_date).flatMap(([date, bets]) =>
                bets.map((b, i) => (
                  <tr key={`${date}-${i}`}>
                    <td>{date}</td>
                    <td>{new Date(b.timestamp).toLocaleTimeString()}</td>
                    <td>{b.venue || ''}</td>
                    <td>{b.country || ''}</td>
                    <td>{b.runner_name}</td>
                    <td>{b.price?.toFixed(2)}</td>
                    <td>{b.size?.toFixed(2)}</td>
                    <td>{b.liability?.toFixed(2)}</td>
                    <td>{b.rule_applied}</td>
                    <td>{b.betfair_response?.status || '?'}</td>
                    <td>{b.betfair_response?.bet_id || ''}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {Object.entries(data.bets_by_date).map(([date, bets]) => {
            const dayStake = bets.reduce((s, b) => s + (b.size || 0), 0)
            const dayLiability = bets.reduce((s, b) => s + (b.liability || 0), 0)
            return (
              <div key={date} className="matched-date-group">
                <div className="matched-date-header" onClick={() => toggleDay(date)}>
                  <span className="matched-date-label">
                    {collapsedDays.has(date) ? '▸' : '▾'} {formatDateHeader(date)}
                  </span>
                  <span className="matched-date-stats">
                    <span>{bets.length} bet{bets.length !== 1 ? 's' : ''}</span>
                    <span>£<strong>{dayStake.toFixed(2)}</strong> staked</span>
                    <span>£<strong>{dayLiability.toFixed(2)}</strong> liability</span>
                  </span>
                </div>
                {!collapsedDays.has(date) && (
                  <div className="matched-bet-list">
                    {bets.map((b, i) => {
                      const key = `${date}-${i}`
                      return (
                        <div key={key} className="matched-bet-row" onClick={() => toggleBet(key)}>
                          <div className="matched-bet-summary">
                            <span className="matched-bet-time">
                              {new Date(b.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <span className="matched-bet-runner">{b.runner_name}</span>
                            <span className="cell-lay-odds">{b.price?.toFixed(2)}</span>
                            <span>£{b.size?.toFixed(2)}</span>
                            <span className="matched-bet-liability">£{b.liability?.toFixed(2)}</span>
                            <code>{b.rule_applied}</code>
                            <span className={`status-${b.betfair_response?.status?.toLowerCase()}`}>
                              {b.betfair_response?.status || '?'}
                            </span>
                          </div>
                          {expandedBets.has(key) && (
                            <div className="matched-bet-detail">
                              <span>Bet ID: <code>{b.betfair_response?.bet_id || '—'}</code></span>
                              <span>Matched: £{b.betfair_response?.size_matched?.toFixed(2) || '—'}</span>
                              <span>Avg Price: {b.betfair_response?.avg_price_matched?.toFixed(2) || '—'}</span>
                              <span>Market: <code>{b.market_id}</code></span>
                              <span>Venue: {b.venue || '—'}</span>
                              <span>Country: {b.country || '—'}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Settled Tab (race results + P/L) ──
function SettledTab({ openChat }) {
  const today = new Date().toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('all')
  const [collapsedDays, setCollapsedDays] = useState(new Set())

  const fetchSettled = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api(`/api/settled?date_from=${dateFrom}&date_to=${dateTo}`)
      setData(res)
    } catch (e) {
      console.error('Failed to fetch settled bets:', e)
    }
    setLoading(false)
  }, [dateFrom, dateTo])

  useEffect(() => { fetchSettled() }, [fetchSettled])

  const toggleDay = (date) => {
    setCollapsedDays(prev => {
      const next = new Set(prev)
      next.has(date) ? next.delete(date) : next.add(date)
      return next
    })
  }

  const getFilteredBets = (bets) => {
    if (filter === 'won') return bets.filter(b => b.bet_outcome === 'WON')
    if (filter === 'lost') return bets.filter(b => b.bet_outcome === 'LOST')
    return bets
  }

  const fname = `chimera_settled_${dateFrom}_${dateTo}`

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Settled Bets</h2>
        {data && data.count > 0 && (
          <SnapshotButton tableId="settled-export-table" filename={fname} />
        )}
      </div>

      <DateRangeFilter
        dateFrom={dateFrom} dateTo={dateTo}
        onDateFromChange={setDateFrom} onDateToChange={setDateTo}
      />

      {data && data.count > 0 && (
        <div className={`settled-summary ${(data.total_pl || 0) >= 0 ? 'pl-positive' : 'pl-negative'}`}>
          <span>Settled: <strong>{data.count}</strong></span>
          <span>Won: <strong className="text-success">{data.wins}</strong></span>
          <span>Lost: <strong className="text-danger">{data.losses}</strong></span>
          <span>Strike: <strong>{data.strike_rate}%</strong></span>
          <span className="settled-total-pl">
            P/L: <strong className={(data.total_pl || 0) >= 0 ? 'text-success' : 'text-danger'}>
              {(data.total_pl || 0) >= 0 ? '+' : ''}£{(data.total_pl || 0).toFixed(2)}
            </strong>
          </span>
          <span>Commission: <strong>£{(data.total_commission || 0).toFixed(2)}</strong></span>
        </div>
      )}

      <div className="settled-filters">
        {['all', 'won', 'lost'].map(f => (
          <button
            key={f}
            className={`btn-filter ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'won' ? 'Won Only' : 'Lost Only'}
          </button>
        ))}
      </div>

      {loading && <p className="empty">Loading settled bets from Betfair...</p>}

      {!loading && data && data.message && (
        <p className="empty">{data.message}</p>
      )}

      {!loading && data && Object.keys(data.days || {}).length === 0 && !data.message && (
        <p className="empty">No settled bets found for this period. Only LIVE bets appear here.</p>
      )}

      {data && data.days && (
        <table id="settled-export-table" style={{ display: 'none' }}>
          <thead>
            <tr>
              <th>Date</th><th>Settled</th><th>Runner</th><th>Venue</th>
              <th>Odds</th><th>Stake</th><th>Outcome</th><th>P/L</th>
              <th>Commission</th><th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.days).flatMap(([date, dayData]) =>
              dayData.bets.map((b, i) => (
                <tr key={`${date}-${i}`}>
                  <td>{date}</td>
                  <td>{b.settled_date ? new Date(b.settled_date).toLocaleTimeString() : ''}</td>
                  <td>{b.runner_name}</td>
                  <td>{b.venue}</td>
                  <td>{b.price_matched?.toFixed(2)}</td>
                  <td>{b.size_settled?.toFixed(2)}</td>
                  <td>{b.bet_outcome}</td>
                  <td>{b.profit?.toFixed(2)}</td>
                  <td>{b.commission?.toFixed(2)}</td>
                  <td>{b.rule_applied}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {!loading && data && data.days && (
        <div className="settled-grouped">
          {Object.entries(data.days).map(([date, dayData]) => {
            const filteredBets = getFilteredBets(dayData.bets)
            if (filteredBets.length === 0) return null

            return (
              <div key={date} className="settled-date-group">
                <div className="settled-date-header" onClick={() => toggleDay(date)}>
                  <span className="settled-date-label">
                    {collapsedDays.has(date) ? '▸' : '▾'} {formatDateHeader(date)}
                  </span>
                  <span className="settled-date-stats">
                    <span>{dayData.races} race{dayData.races !== 1 ? 's' : ''}</span>
                    <span>{dayData.wins}W-{dayData.losses}L</span>
                    <span>{dayData.strike_rate}%</span>
                    <span className={dayData.day_pl >= 0 ? 'text-success' : 'text-danger'}>
                      {dayData.day_pl >= 0 ? '+' : ''}£{dayData.day_pl.toFixed(2)}
                    </span>
                  </span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      openChat(date, `Analyse my settled betting results for ${date}. I had ${dayData.wins} wins and ${dayData.losses} losses with a P/L of £${dayData.day_pl.toFixed(2)} and a strike rate of ${dayData.strike_rate}%. Provide insights on performance by rule, odds band analysis, liability management, and actionable suggestions for improving results.`)
                    }}
                  >
                    AI Report
                  </button>
                </div>

                {!collapsedDays.has(date) && (
                  <div className="settled-bet-list">
                    {filteredBets.map((b, i) => (
                      <div key={i} className={`settled-card ${b.bet_outcome === 'WON' ? 'settled-won' : 'settled-lost'}`}>
                        <div className="settled-card-header">
                          <span className={`settled-outcome ${b.bet_outcome === 'WON' ? 'outcome-won' : 'outcome-lost'}`}>
                            {b.bet_outcome === 'WON' ? 'WON' : 'LOST'}
                          </span>
                          <span className="settled-runner">{b.runner_name}</span>
                          <span className="settled-venue">{b.venue}</span>
                          <span className={`settled-pl ${(b.profit || 0) >= 0 ? 'text-success' : 'text-danger'}`}>
                            {(b.profit || 0) >= 0 ? '+' : ''}£{(b.profit || 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="settled-card-details">
                          <span>Odds: <strong className="cell-lay-odds">{b.price_matched?.toFixed(2)}</strong></span>
                          <span>Stake: £{b.size_settled?.toFixed(2)}</span>
                          <span>Rule: <code>{b.rule_applied || '—'}</code></span>
                          <span>Settled: {b.settled_date ? new Date(b.settled_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                          {b.commission > 0 && <span>Comm: £{b.commission?.toFixed(2)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── API Keys Tab ──
function ApiKeysTab() {
  const [keys, setKeys] = useState([])
  const [label, setLabel] = useState('')
  const [newKey, setNewKey] = useState(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const fetchKeys = () => {
    api('/api/keys')
      .then(data => { setKeys(data.keys || []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { fetchKeys() }, [])

  const handleGenerate = async (e) => {
    e.preventDefault()
    const res = await api('/api/keys/generate', {
      method: 'POST',
      body: JSON.stringify({ label: label || 'Agent key' }),
    })
    if (res.key) {
      setNewKey(res.key)
      setLabel('')
      setCopied(false)
      fetchKeys()
    }
  }

  const handleRevoke = async (keyId) => {
    if (!confirm('Revoke this API key? Any agent using it will lose access.')) return
    await api(`/api/keys/${keyId}`, { method: 'DELETE' })
    fetchKeys()
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(newKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) return <p className="empty">Loading API keys...</p>

  return (
    <div>
      <h2>API Keys</h2>
      <p className="api-description">
        Generate API keys for external agents to access your session data.
        Use the <code>X-API-Key</code> header or <code>?api_key=</code> query param.
      </p>

      <form className="api-key-form" onSubmit={handleGenerate}>
        <input
          type="text"
          placeholder="Key label (e.g. Report Agent)"
          value={label}
          onChange={e => setLabel(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">Generate Key</button>
      </form>

      {newKey && (
        <div className="new-key-box">
          <p><strong>New API key — copy it now, it won't be shown again:</strong></p>
          <div className="key-display">
            <code>{newKey}</code>
            <button className="btn btn-secondary" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="api-endpoints">
        <h3>Data Endpoints</h3>
        <table>
          <thead>
            <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>GET</td><td><code>/api/data/sessions</code></td><td>All sessions (filter: ?date=, ?mode=)</td></tr>
            <tr><td>GET</td><td><code>/api/data/sessions/:id</code></td><td>Single session detail</td></tr>
            <tr><td>GET</td><td><code>/api/data/bets</code></td><td>All bets (filter: ?date=, ?mode=)</td></tr>
            <tr><td>GET</td><td><code>/api/data/results</code></td><td>All rule evaluations (filter: ?date=)</td></tr>
            <tr><td>GET</td><td><code>/api/data/state</code></td><td>Current engine state</td></tr>
            <tr><td>GET</td><td><code>/api/data/rules</code></td><td>Active rule definitions</td></tr>
            <tr><td>GET</td><td><code>/api/data/summary</code></td><td>Aggregated statistics (filter: ?date=)</td></tr>
          </tbody>
        </table>
      </div>

      {keys.length > 0 && (
        <div className="api-keys-list">
          <h3>Active Keys</h3>
          <table>
            <thead>
              <tr><th>Label</th><th>Key</th><th>Created</th><th>Last Used</th><th></th></tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.key_id}>
                  <td>{k.label}</td>
                  <td><code>{k.key_preview}</code></td>
                  <td>{new Date(k.created_at).toLocaleDateString()}</td>
                  <td>{k.last_used ? new Date(k.last_used).toLocaleString() : 'Never'}</td>
                  <td>
                    <button className="btn btn-danger btn-sm" onClick={() => handleRevoke(k.key_id)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Settings Tab ──
function SettingsTab() {
  return (
    <div>
      <div className="engine-section">
        <h2>Betfair Connection</h2>
        <p className="api-description">
          Betfair API credentials are configured via environment variables on the server.
          Use the login screen to authenticate your Betfair account session.
        </p>
        <div className="engine-info">
          <span>Authentication: <strong>Betfair SSO (session-based)</strong></span>
          <span>API: <strong>Betfair Exchange API v1.0</strong></span>
          <span>Data feed: <strong>REST polling (5s market refresh)</strong></span>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <ApiKeysTab />
      </div>
    </div>
  )
}

// ── Reports Tab ──
function ReportsTab() {
  const [selectedDate, setSelectedDate] = useState('')
  const [daySessions, setDaySessions] = useState([])
  const [selectedSessionIds, setSelectedSessionIds] = useState([])
  const [templates, setTemplates] = useState([])
  const [selectedTemplate, setSelectedTemplate] = useState('daily_performance')
  const [reports, setReports] = useState([])
  const [viewingReport, setViewingReport] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [showTemplateSelect, setShowTemplateSelect] = useState(false)
  const reportContentRef = useRef(null)

  useEffect(() => {
    api('/api/reports/templates').then(data => setTemplates(data.templates || []))
    fetchReports()
  }, [])

  const fetchReports = () => {
    api('/api/reports').then(data => setReports(data.reports || []))
  }

  useEffect(() => {
    if (!selectedDate) { setDaySessions([]); return }
    setLoadingSessions(true)
    api('/api/sessions')
      .then(data => {
        const filtered = (data.sessions || []).filter(s => s.date === selectedDate)
        setDaySessions(filtered)
        setSelectedSessionIds(filtered.map(s => s.session_id))
        setLoadingSessions(false)
      })
      .catch(() => setLoadingSessions(false))
  }, [selectedDate])

  const toggleSession = (sid) => {
    setSelectedSessionIds(prev =>
      prev.includes(sid) ? prev.filter(id => id !== sid) : [...prev, sid]
    )
  }

  const handleGenerateReport = () => {
    setShowTemplateSelect(true)
  }

  const handleConfirmGenerate = async () => {
    if (selectedSessionIds.length === 0) return
    setGenerating(true)
    setShowTemplateSelect(false)
    try {
      const res = await api('/api/reports/generate', {
        method: 'POST',
        body: JSON.stringify({
          date: selectedDate,
          session_ids: selectedSessionIds,
          template: selectedTemplate,
        }),
      })
      if (res.report_id) {
        fetchReports()
        setViewingReport(res)
      }
    } catch (e) {
      console.error('Report generation failed:', e)
    }
    setGenerating(false)
  }

  const handleViewReport = async (reportId) => {
    const res = await api(`/api/reports/${reportId}`)
    if (res.content) setViewingReport(res)
  }

  const handleDeleteReport = async (reportId) => {
    if (!confirm('Delete this report?')) return
    await api(`/api/reports/${reportId}`, { method: 'DELETE' })
    fetchReports()
    if (viewingReport?.report_id === reportId) setViewingReport(null)
  }

  const handleDownloadPDF = () => {
    if (!reportContentRef.current) return
    const content = reportContentRef.current.innerHTML
    const printWindow = window.open('', '_blank')
    printWindow.document.write(`<!DOCTYPE html>
<html><head>
<title>${viewingReport?.title || 'CHIMERA Report'}</title>
<style>
  body { font-family: 'Inter', 'Segoe UI', sans-serif; padding: 40px; color: #1a1a2e; line-height: 1.7; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; color: #1a1a2e; }
  h2 { font-size: 18px; color: #1a1a2e; margin-top: 28px; }
  h3 { font-size: 15px; color: #333; margin-top: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  th { background: #f8f9fa; color: #4a4a5a; padding: 8px 12px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  em { color: #8a8a9a; }
  strong { color: #1a1a2e; }
  @media print { body { padding: 20px; } }
</style>
</head><body>${content}</body></html>`)
    printWindow.document.close()
    setTimeout(() => { printWindow.print() }, 500)
  }

  const renderMarkdown = (md) => {
    if (!md) return ''
    let html = md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^---$/gm, '<hr/>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    html = html.replace(/\n?\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/g, (match, headerRow, bodyRows) => {
      const headers = headerRow.split('|').map(h => h.trim()).filter(Boolean)
      const rows = bodyRows.trim().split('\n').map(row =>
        row.split('|').map(c => c.trim()).filter(Boolean)
      )
      let table = '<table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>'
      rows.forEach(r => {
        table += '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>'
      })
      table += '</tbody></table>'
      return table
    })
    html = html.replace(/^(?!<[hultdor])((?!<).+)$/gm, '<p>$1</p>')
    return html
  }

  const renderJsonReport = (data) => {
    if (!data) return ''
    const fmtPL = (v) => v >= 0 ? `+£${v.toFixed(2)}` : `−£${Math.abs(v).toFixed(2)}`
    const fmtPct = (v) => `${(v * 100).toFixed(1)}%`
    const fmtOdds = (v) => v?.toFixed(2) ?? '—'
    let h = ''

    const m = data.meta || {}
    h += `<h1>CHIMERA Lay Engine Performance Report</h1>`
    h += `<h2>Day ${m.day_number || '?'} — ${m.trading_date || ''}</h2>`
    h += `<p><em>Prepared by ${m.prepared_by || 'CHIMERA AI Agent'} | ${m.engine_version || ''} | ${m.dry_run_disabled ? 'LIVE' : 'DRY RUN'}</em></p>`

    const es = data.executive_summary
    if (es) {
      h += `<h2>Executive Summary</h2>`
      if (es.headline) h += `<p><strong>${es.headline}</strong></p>`
      if (es.narrative) h += `<p>${es.narrative}</p>`
      if (es.key_findings?.length) {
        h += '<ul>' + es.key_findings.map(f => `<li>${f}</li>`).join('') + '</ul>'
      }
    }

    const dp = data.day_performance
    if (dp?.slices?.length) {
      h += `<h2>Performance Summary</h2>`
      h += '<table><thead><tr><th>Slice</th><th>Bets</th><th>Record</th><th>Strike</th><th>Staked</th><th>P/L</th><th>ROI</th></tr></thead><tbody>'
      dp.slices.forEach(s => {
        h += `<tr><td>${s.label}</td><td>${s.total_bets}</td><td>${s.wins}W-${s.losses}L</td><td>${fmtPct(s.strike_rate)}</td><td>£${s.total_staked?.toFixed(2)}</td><td>${fmtPL(s.net_pl)}</td><td>${fmtPct(s.roi)}</td></tr>`
      })
      h += '</tbody></table>'
      if (dp.narrative) h += `<p><em>${dp.narrative}</em></p>`
    }

    const ob = data.odds_band_analysis
    if (ob?.bands?.length) {
      h += `<h2>Odds Band Analysis</h2>`
      h += '<table><thead><tr><th>Band</th><th>Bets</th><th>Wins</th><th>Strike</th><th>P/L</th><th>ROI</th><th>Verdict</th></tr></thead><tbody>'
      ob.bands.forEach(b => {
        h += `<tr><td>${b.label}</td><td>${b.bets}</td><td>${b.wins}</td><td>${fmtPct(b.win_pct)}</td><td>${fmtPL(b.pl)}</td><td>${fmtPct(b.roi)}</td><td><strong>${b.verdict}</strong></td></tr>`
      })
      h += '</tbody></table>'
      if (ob.narrative) h += `<p><em>${ob.narrative}</em></p>`
    }

    const da = data.discipline_analysis
    if (da?.rows?.length) {
      h += `<h2>Discipline Analysis</h2>`
      h += '<table><thead><tr><th>Discipline</th><th>Bets</th><th>Record</th><th>Strike</th><th>P/L</th><th>ROI</th></tr></thead><tbody>'
      da.rows.forEach(r => {
        h += `<tr><td>${r.discipline}</td><td>${r.bets}</td><td>${r.wins}W-${r.losses}L</td><td>${fmtPct(r.strike_rate)}</td><td>${fmtPL(r.pl)}</td><td>${fmtPct(r.roi)}</td></tr>`
      })
      h += '</tbody></table>'
      if (da.narrative) h += `<p><em>${da.narrative}</em></p>`
    }

    const va = data.venue_analysis
    if (va?.rows?.length) {
      h += `<h2>Venue Analysis</h2>`
      h += '<table><thead><tr><th>Venue</th><th>Country</th><th>Disc.</th><th>Bets</th><th>Record</th><th>Strike</th><th>P/L</th><th>ROI</th><th>Rating</th></tr></thead><tbody>'
      va.rows.forEach(r => {
        h += `<tr><td>${r.venue}</td><td>${r.country}</td><td>${r.discipline}</td><td>${r.bets}</td><td>${r.wins}W-${r.losses}L</td><td>${fmtPct(r.strike_rate)}</td><td>${fmtPL(r.pl)}</td><td>${fmtPct(r.roi)}</td><td><strong>${r.rating}</strong></td></tr>`
      })
      h += '</tbody></table>'
      if (va.narrative) h += `<p><em>${va.narrative}</em></p>`
    }

    const confirmedBets = (data.bets || []).filter(b => b.result === 'WIN' || b.result === 'LOSS')
    if (confirmedBets.length) {
      h += `<h2>Individual Bet Breakdown</h2>`
      h += '<table><thead><tr><th>Time</th><th>Runner</th><th>Venue</th><th>Market</th><th>Odds</th><th>Stake</th><th>Liability</th><th>P/L</th><th>Result</th><th>Band</th><th>Rule</th></tr></thead><tbody>'
      confirmedBets.forEach(b => {
        const resultClass = b.result === 'WIN' ? 'color:#16a34a' : b.result === 'LOSS' ? 'color:#dc2626' : ''
        h += `<tr><td>${b.race_time || ''}</td><td>${b.selection}</td><td>${b.venue}</td><td>${b.market || ''}</td><td>${fmtOdds(b.odds)}</td><td>£${b.stake?.toFixed(2)}</td><td>£${b.liability?.toFixed(2)}</td><td>${fmtPL(b.pl)}</td><td style="${resultClass}"><strong>${b.result}</strong></td><td>${b.band_label || ''}</td><td>${b.rule || ''}</td></tr>`
      })
      h += '</tbody></table>'
    }

    const cp = data.cumulative_performance
    if (cp?.by_day?.length) {
      h += `<h2>Cumulative Performance — By Day</h2>`
      h += '<table><thead><tr><th>Day</th><th>Date</th><th>Bets</th><th>Record</th><th>Strike</th><th>Day P/L</th><th>Cumulative</th></tr></thead><tbody>'
      cp.by_day.forEach(d => {
        h += `<tr><td>${d.day_number}</td><td>${d.date}</td><td>${d.bets}</td><td>${d.wins}W-${d.losses}L</td><td>${fmtPct(d.strike_rate)}</td><td>${fmtPL(d.pl)}</td><td><strong>${fmtPL(d.cumulative_pl)}</strong></td></tr>`
      })
      h += '</tbody></table>'
      if (cp.narrative) h += `<p><em>${cp.narrative}</em></p>`
    }
    if (cp?.by_band?.length) {
      h += `<h3>Cumulative — By Odds Band</h3>`
      h += '<table><thead><tr><th>Band</th><th>Bets</th><th>Record</th><th>Strike</th><th>P/L</th><th>Status</th><th>Recommendation</th></tr></thead><tbody>'
      cp.by_band.forEach(b => {
        h += `<tr><td>${b.label}</td><td>${b.bets}</td><td>${b.wins}W-${b.losses}L</td><td>${fmtPct(b.strike_rate)}</td><td>${fmtPL(b.pl)}</td><td><strong>${b.status}</strong></td><td>${b.recommendation || ''}</td></tr>`
      })
      h += '</tbody></table>'
    }

    const cc = data.conclusions
    if (cc) {
      if (cc.findings?.length) {
        h += `<h2>Key Findings</h2><ol>`
        cc.findings.forEach(f => {
          h += f.priority ? `<li><strong>${f.text}</strong></li>` : `<li>${f.text}</li>`
        })
        h += '</ol>'
      }
      if (cc.recommendations?.length) {
        h += `<h2>Recommendations</h2><ol>`
        cc.recommendations.forEach(r => {
          h += r.priority ? `<li><strong>${r.text}</strong></li>` : `<li>${r.text}</li>`
        })
        h += '</ol>'
      }
    }

    const ap = data.appendix
    if (ap?.data_sources?.length) {
      h += `<hr/><h3>Data Sources</h3><ul>`
      ap.data_sources.forEach(ds => {
        h += `<li><strong>${ds.label}:</strong> ${ds.value}</li>`
      })
      h += '</ul>'
    }

    h += `<hr/><p><em>Report generated by CHIMERA AI Agent</em></p>`
    return h
  }

  const renderReportContent = (report) => {
    if (!report?.content) return ''
    let content = report.content
    if (typeof content === 'string') {
      let trimmed = content.trim()
      if (trimmed.startsWith('```')) {
        trimmed = trimmed.replace(/^```\w*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
      }
      if (trimmed.startsWith('{')) {
        try { content = JSON.parse(trimmed) } catch (e) {}
      }
    }
    if (typeof content === 'object') return renderJsonReport(content)
    return renderMarkdown(content)
  }

  if (viewingReport) {
    return (
      <div>
        <div className="tab-toolbar">
          <button className="btn btn-secondary btn-back" onClick={() => setViewingReport(null)}>
            ← Back to Reports
          </button>
          <h2>{viewingReport.title}</h2>
          <button className="btn btn-primary" onClick={handleDownloadPDF}>
            Print / PDF
          </button>
        </div>
        <div className="report-viewer" ref={reportContentRef}
          dangerouslySetInnerHTML={{ __html: renderReportContent(viewingReport) }}
        />
      </div>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <div>
      <h2>Reports</h2>

      <div className="report-controls">
        <div className="report-date-row">
          <label>Select Date:</label>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            max={today}
          />
        </div>

        {selectedDate && (
          <div className="report-sessions-panel">
            <h3>Sessions for {selectedDate}</h3>
            {loadingSessions ? (
              <p className="empty">Loading sessions...</p>
            ) : daySessions.length === 0 ? (
              <p className="empty">No sessions found for this date.</p>
            ) : (
              <>
                <div className="report-session-list">
                  {daySessions.map(s => (
                    <label key={s.session_id} className="report-session-item">
                      <input
                        type="checkbox"
                        checked={selectedSessionIds.includes(s.session_id)}
                        onChange={() => toggleSession(s.session_id)}
                      />
                      <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'badge-dry'}`}>
                        {s.mode === 'LIVE' ? 'LIVE' : 'DRY RUN'}
                      </span>
                      <span className="report-session-time">
                        {new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {s.stop_time
                          ? ` – ${new Date(s.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          : ' – running'}
                      </span>
                      <span className="report-session-stats">
                        {s.summary?.total_bets || 0} bets · £{(s.summary?.total_stake || 0).toFixed(2)}
                      </span>
                      <span className="report-session-countries">
                        {(s.countries || s.summary?.countries || []).map(c => COUNTRY_LABELS[c] || c).join(' ')}
                      </span>
                    </label>
                  ))}
                </div>

                {showTemplateSelect && (
                  <div className="report-template-select">
                    <h3>Choose Template</h3>
                    <div className="report-template-list">
                      {templates.map(t => (
                        <label key={t.id} className="report-template-item">
                          <input
                            type="radio"
                            name="template"
                            value={t.id}
                            checked={selectedTemplate === t.id}
                            onChange={() => setSelectedTemplate(t.id)}
                          />
                          <div>
                            <strong>{t.name}</strong>
                            <span className="template-desc">{t.description}</span>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="report-template-actions">
                      <button className="btn btn-secondary" onClick={() => setShowTemplateSelect(false)}>Cancel</button>
                      <button className="btn btn-primary" onClick={handleConfirmGenerate}
                        disabled={selectedSessionIds.length === 0}>
                        Generate Report
                      </button>
                    </div>
                  </div>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleGenerateReport}
                  disabled={generating || selectedSessionIds.length === 0}
                >
                  {generating ? 'Generating...' : 'Generate Daily Report'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="report-list-section">
        <h3>Generated Reports</h3>
        {reports.length === 0 ? (
          <p className="empty">No reports generated yet. Select a date and sessions above to create one.</p>
        ) : (
          <div className="report-list">
            {reports.map(r => (
              <div key={r.report_id} className="card report-card">
                <div className="report-card-info">
                  <strong>{r.title}</strong>
                  <span className="report-card-meta">
                    {r.template_name} · {new Date(r.created_at).toLocaleString()} · {r.session_ids?.length || 0} session{(r.session_ids?.length || 0) !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="report-card-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewReport(r.report_id)}>
                    View
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteReport(r.report_id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab config ──
const TAB_CONFIG = [
  { id: 'live', label: 'Live' },
  { id: 'dryrun', label: 'Dry Run' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'history', label: 'History' },
  { id: 'bet-settings', label: 'Bet Settings' },
  { id: 'settings', label: 'Settings' },
  { id: 'reports', label: 'Reports' },
]

// ── Dashboard ──
function Dashboard() {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('live')
  const intervalRef = useRef(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInitialDate, setChatInitialDate] = useState(null)
  const [chatInitialMessage, setChatInitialMessage] = useState(null)

  const fetchState = useCallback(async () => {
    try {
      const s = await api('/api/state')
      setState(s)
    } catch (e) {
      console.error('Failed to fetch state:', e)
    }
  }, [])

  useEffect(() => {
    fetchState()
    intervalRef.current = setInterval(fetchState, 10000)
    return () => clearInterval(intervalRef.current)
  }, [fetchState])

  const handleStart = async (mode = 'live') => {
    if (state.status === 'RUNNING') {
      const currentMode = state.dry_run ? 'Dry Run' : 'Live'
      const newMode = mode === 'live' ? 'Live' : 'Dry Run'
      if (currentMode !== newMode) {
        if (!confirm(`Engine is currently running in ${currentMode} mode. Stop and switch to ${newMode}?`)) return
        await api('/api/engine/stop', { method: 'POST' })
      } else {
        return
      }
    }
    if (mode === 'live' && state.dry_run) {
      await api('/api/engine/dry-run', { method: 'POST' })
    } else if (mode === 'dryrun' && !state.dry_run) {
      await api('/api/engine/dry-run', { method: 'POST' })
    }
    await api('/api/engine/start', { method: 'POST' })
    fetchState()
  }
  const handleStop = async () => {
    await api('/api/engine/stop', { method: 'POST' })
    fetchState()
  }
  const handleToggleSpreadControl = async () => {
    await api('/api/engine/spread-control', { method: 'POST' })
    fetchState()
  }
  const handleToggleJofsControl = async () => {
    await api('/api/engine/jofs-control', { method: 'POST' })
    fetchState()
  }
  const handleToggleMarkCeiling = async () => {
    await api('/api/engine/mark-ceiling', { method: 'POST' })
    fetchState()
  }
  const handleToggleMarkFloor = async () => {
    await api('/api/engine/mark-floor', { method: 'POST' })
    fetchState()
  }
  const handleToggleMarkUplift = async () => {
    await api('/api/engine/mark-uplift', { method: 'POST' })
    fetchState()
  }
  const handleSetPointValue = async (value) => {
    await api('/api/engine/point-value', {
      method: 'POST',
      body: JSON.stringify({ value: parseFloat(value) }),
    })
    fetchState()
  }
  const handleSetProcessWindow = async (minutes) => {
    await api('/api/engine/process-window', {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    })
    fetchState()
  }
  const handleResetBets = async () => {
    if (!confirm('Clear all bets and re-process all markets?')) return
    await api('/api/engine/reset-bets', { method: 'POST' })
    fetchState()
  }
  const handleToggleCountry = async (country) => {
    const current = state.countries || ['GB', 'IE']
    const updated = current.includes(country)
      ? current.filter(c => c !== country)
      : [...current, country]
    if (updated.length === 0) return
    await api('/api/engine/countries', {
      method: 'POST',
      body: JSON.stringify({ countries: updated }),
    })
    fetchState()
  }
  const handleLogout = async () => {
    await api('/api/logout', { method: 'POST' })
    window.location.reload()
  }

  const openChat = (date = null, initialMessage = null) => {
    setChatInitialDate(date)
    setChatInitialMessage(initialMessage)
    setChatOpen(true)
  }
  const closeChat = () => {
    setChatOpen(false)
    setChatInitialMessage(null)
  }

  if (!state) return <div className="loading">Loading engine state...</div>

  const s = state.summary || {}
  const hasErrors = (state.errors || []).length > 0

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-left">
          <h1>CHIMERA</h1>
        </div>
        <div className="header-right">
          <span className="date">{state.date}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => openChat()}>AI Chat</button>
          <button className="btn-logout" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      {/* ── Stats Ribbon ── */}
      <div className="stats-ribbon">
        <div className="stats-ribbon-left">
          <span className="stat">Markets: <strong>{s.total_markets || 0}</strong></span>
          <span className="stat">Bets: <strong>{s.bets_placed || 0}</strong></span>
          <span className="stat">W/L: <strong>{s.wins || 0}/{s.losses || 0}</strong></span>
          <span className="stat">Strike: <strong>{s.strike_rate != null ? `${s.strike_rate}%` : '—'}</strong></span>
          <span className="stat">Balance: <strong>{state.balance != null ? `£${state.balance.toFixed(2)}` : '—'}</strong></span>
          <span className="stat">Liability: <strong>£{(s.total_liability || 0).toFixed(2)}</strong></span>
          <span className="stat">
            P&amp;L:{' '}
            <strong style={{ color: (s.pnl || 0) >= 0 ? '#16a34a' : '#dc2626' }}>
              {(s.pnl || 0) >= 0 ? '+' : ''}£{(s.pnl || 0).toFixed(2)}
            </strong>
          </span>
        </div>
        <div className="stats-ribbon-right">
          {state.next_race && (
            <span className="next-race">
              Next: <strong>{state.next_race.venue}</strong>{' '}
              {state.next_race.time
                ? new Date(state.next_race.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : ''
              }
              {state.next_race.minutes_to_off != null && (
                <span className={`next-race-mins ${state.next_race.minutes_to_off <= (state.process_window || 12) ? 'in-window' : ''}`}>
                  {' '}{Math.round(state.next_race.minutes_to_off)}m
                </span>
              )}
            </span>
          )}
          {state.last_scan && (
            <span className="stat muted">Scan: {new Date(state.last_scan).toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <nav className="tabs">
        {TAB_CONFIG.map(t => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {(t.id === 'live' || t.id === 'dryrun') && hasErrors && <span className="tab-dot red" />}
          </button>
        ))}
      </nav>

      {/* ── Tab Content ── */}
      <div className="tab-content">
        {tab === 'live' && (
          <LiveTab
            state={state}
            onStart={handleStart}
            onStop={handleStop}
          />
        )}
        {tab === 'dryrun' && (
          <LiveTab
            state={state}
            onStart={handleStart}
            onStop={handleStop}
            onResetBets={handleResetBets}
            mode="dryrun"
          />
        )}
        {tab === 'backtest' && <BacktestTab />}
        {tab === 'strategy' && <StrategyTab />}
        {tab === 'history' && <HistoryTab openChat={openChat} />}
        {tab === 'bet-settings' && (
          <BetSettingsTab
            state={state}
            onToggleCountry={handleToggleCountry}
            onToggleJofs={handleToggleJofsControl}
            onToggleSpread={handleToggleSpreadControl}
            onToggleMarkCeiling={handleToggleMarkCeiling}
            onToggleMarkFloor={handleToggleMarkFloor}
            onToggleMarkUplift={handleToggleMarkUplift}
            onSetProcessWindow={handleSetProcessWindow}
            onSetPointValue={handleSetPointValue}
          />
        )}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'reports' && <ReportsTab />}
      </div>

      {/* ── Chat Drawer ── */}
      <ChatDrawer
        isOpen={chatOpen}
        onClose={closeChat}
        initialDate={chatInitialDate}
        initialMessage={chatInitialMessage}
      />
    </div>
  )
}

// ── App Root ──
export default function App() {
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    api('/api/state')
      .then(s => {
        if (s.authenticated) setAuthed(true)
      })
      .catch(() => {})
  }, [])

  if (!authed) {
    return <LoginPanel onLogin={() => setAuthed(true)} />
  }
  return <Dashboard />
}
