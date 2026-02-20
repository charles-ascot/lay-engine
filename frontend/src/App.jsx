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
      className="btn btn-snapshot"
      onClick={() => downloadTableAsExcel(tableId, filename || 'chimera_export')}
    >
      Snapshot
    </button>
  )
}

// ── Status Badge ──
function Badge({ status }) {
  const colors = {
    RUNNING: '#22c55e',
    STOPPED: '#ef4444',
    STARTING: '#f59e0b',
    AUTH_FAILED: '#ef4444',
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
        <h1>🐴 CHIMERA</h1>
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

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-send initial analysis message when opened with initialMessage
  useEffect(() => {
    if (isOpen && initialMessage && !initialSentRef.current) {
      initialSentRef.current = true
      sendMessage(initialMessage)
    }
  }, [isOpen, initialMessage])

  // Reset initialSentRef when drawer closes
  useEffect(() => {
    if (!isOpen) initialSentRef.current = false
  }, [isOpen])

  // Focus input when drawer opens
  useEffect(() => {
    if (isOpen && !initialMessage) inputRef.current?.focus()
  }, [isOpen])

  // Stop audio on unmount/close
  useEffect(() => {
    if (!isOpen && currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
  }, [isOpen])

  const speakText = async (text) => {
    if (!speakEnabled) return
    // Stop any currently playing audio
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
        // Fallback to browser TTS if OpenAI TTS fails
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
      // Fallback to browser TTS
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

  // ── Speech Recognition via OpenAI Whisper ──
  const toggleListening = async () => {
    if (listening) {
      // Stop recording
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
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(t => t.stop())

        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (blob.size < 100) return // Too short, ignore

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
          <button type="submit" className="btn btn-primary btn-send" disabled={loading || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Dashboard ──
function Dashboard() {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('snapshots')
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
    intervalRef.current = setInterval(fetchState, 10000) // Poll every 10s
    return () => clearInterval(intervalRef.current)
  }, [fetchState])

  const handleStart = async () => {
    await api('/api/engine/start', { method: 'POST' })
    fetchState()
  }
  const handleStop = async () => {
    await api('/api/engine/stop', { method: 'POST' })
    fetchState()
  }
  const handleToggleDryRun = async () => {
    await api('/api/engine/dry-run', { method: 'POST' })
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

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header>
        <div className="header-left">
          <h1>🐴 CHIMERA</h1>
          <Badge status={state.status} />
          {state.dry_run && <span className="badge dry-run">DRY RUN</span>}
        </div>
        <div className="header-right">
          {state.balance != null && (
            <span className="balance">£{state.balance?.toFixed(2)}</span>
          )}
          <span className="date">{state.date}</span>
          <button className="btn-sm" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      {/* ── Controls ── */}
      <div className="controls">
        <button
          className={`btn ${state.status === 'RUNNING' ? 'btn-danger' : 'btn-primary'}`}
          onClick={state.status === 'RUNNING' ? handleStop : handleStart}
        >
          {state.status === 'RUNNING' ? '⏹ Stop Engine' : '▶ Start Engine'}
        </button>
        <button
          className={`btn ${state.dry_run ? 'btn-warning' : 'btn-success'}`}
          onClick={handleToggleDryRun}
        >
          {state.dry_run ? '🧪 Dry Run ON → Go Live' : '🔴 LIVE → Switch to Dry Run'}
        </button>
        <button className="btn btn-secondary" onClick={handleResetBets}>
          Clear Bets & Re-process
        </button>
        <button className="btn btn-chat" onClick={() => openChat()}>
          🤖 AI Chat
        </button>
        <div className="stats-row">
          <span>Markets: <strong>{s.total_markets || 0}</strong></span>
          <span>Processed: <strong>{s.processed || 0}</strong></span>
          <span>Bets: <strong>{s.bets_placed || 0}</strong></span>
          <span>Staked: <strong>£{(s.total_stake || 0).toFixed(2)}</strong></span>
          <span>Liability: <strong>£{(s.total_liability || 0).toFixed(2)}</strong></span>
        </div>
        <div className="country-toggles">
          <span className="country-label">Markets:</span>
          {ALL_COUNTRIES.map(c => (
            <button
              key={c}
              className={`btn-country ${(state.countries || ['GB', 'IE']).includes(c) ? 'active' : ''}`}
              onClick={() => handleToggleCountry(c)}
            >
              {COUNTRY_LABELS[c]}
            </button>
          ))}
        </div>
        {state.last_scan && (
          <p className="last-scan">
            Last scan: {new Date(state.last_scan).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* ── Tabs ── */}
      <nav className="tabs">
        {['snapshots', 'matched', 'settled', 'reports', 'rules', 'errors', 'api'].map(t => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t === 'api' ? 'API Keys' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {/* ── Tab Content ── */}
      <div className="tab-content">
        {tab === 'snapshots' && <SnapshotsTab openChat={openChat} />}
        {tab === 'matched' && <MatchedTab />}
        {tab === 'settled' && <SettledTab openChat={openChat} />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'rules' && <RulesTab results={state.recent_results} />}
        {tab === 'errors' && <ErrorsTab errors={state.errors} />}
        {tab === 'api' && <ApiKeysTab />}
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

// ── Shared date formatter ──
const formatDateHeader = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

// ── Snapshots Tab (formerly History) ──
function SnapshotsTab({ openChat }) {
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

  if (loading) return <p className="empty">Loading snapshots...</p>

  // ── Detail View ──
  if (detail) {
    const bets = detail.bets || []
    const sm = detail.summary || {}
    return (
      <div>
        <div className="session-detail-header">
          <button className="btn btn-secondary btn-back" onClick={() => setSelectedId(null)}>
            ← Back
          </button>
          <h2>
            <span className={`badge ${detail.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>
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
          <span className={`badge badge-${detail.status.toLowerCase()}`}>{detail.status}</span>
        </div>
        <div className="session-detail-scroll">
          {bets.length === 0 ? (
            <p className="empty">No bets in this snapshot.</p>
          ) : (
            <table id="session-bets-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Country</th>
                  <th>Runner</th>
                  <th className="col-lay">Odds</th>
                  <th>Stake</th>
                  <th>Liability</th>
                  <th>Rule</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bets.map((b, i) => (
                  <tr key={i} className={b.dry_run ? 'row-dry' : ''}>
                    <td>{new Date(b.timestamp).toLocaleTimeString()}</td>
                    <td>{b.country || '—'}</td>
                    <td>{b.runner_name}</td>
                    <td className="cell-lay-odds">{b.price?.toFixed(2)}</td>
                    <td>£{b.size?.toFixed(2)}</td>
                    <td>£{b.liability?.toFixed(2)}</td>
                    <td><code>{b.rule_applied}</code></td>
                    <td>
                      <span className={`status-${b.betfair_response?.status?.toLowerCase()}`}>
                        {b.dry_run ? '🧪 DRY' : b.betfair_response?.status || '?'}
                      </span>
                    </td>
                  </tr>
                ))}
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

  // ── List View ──
  return (
    <div>
      <div className="tab-toolbar">
        <h2>Snapshots</h2>
        {sortedDates.length > 0 && (
          <button
            className="btn btn-analysis"
            onClick={() => openChat(
              sortedDates[0],
              `Provide a comprehensive analysis of today's snapshot data (${sortedDates[0]}). Cover odds drift patterns, rule distribution, risk exposure, venue patterns, timing observations, anomalies, and actionable suggestions for rule tuning. Format as 6-10 concise bullet points with specific numbers.`
            )}
          >
            Analysis {sortedDates[0]}
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className="empty">No snapshots recorded yet. Start the engine to create one.</p>
      ) : (
        <div className="snapshots-grouped">
          {sortedDates.map(date => (
            <div key={date} className="snapshots-date-group">
              <div className="snapshots-date-header">
                <span className="snapshots-date-label">{formatDateHeader(date)}</span>
                <span className="snapshots-date-count">{grouped[date].length} snapshot{grouped[date].length !== 1 ? 's' : ''}</span>
              </div>
              <div className="snapshots-list">
                {grouped[date].map(s => (
                  <div
                    key={s.session_id}
                    className="snapshots-card"
                    onClick={() => setSelectedId(s.session_id)}
                  >
                    <div className="session-card-top">
                      <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>
                        {s.mode === 'LIVE' ? 'LIVE BET' : 'DRY RUN'}
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
                    </div>
                  </div>
                ))}
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
          <span>Total Bets: <strong>{data.count}</strong></span>
          <span>Total Staked: <strong>£{(data.total_stake || 0).toFixed(2)}</strong></span>
          <span>Total Liability: <strong>£{(data.total_liability || 0).toFixed(2)}</strong></span>
          <span>Avg Odds: <strong>{(data.avg_odds || 0).toFixed(2)}</strong></span>
        </div>
      )}

      {loading && <p className="empty">Loading matched bets...</p>}

      {!loading && data && data.count === 0 && (
        <p className="empty">No live matched bets found for this period.</p>
      )}

      {!loading && data && data.bets_by_date && (
        <div className="matched-grouped">
          {/* Hidden table for Excel export */}
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
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 6)
    return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10))
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

      {/* Sticky P/L Summary */}
      {data && data.count > 0 && (
        <div className={`settled-summary ${(data.total_pl || 0) >= 0 ? 'pl-positive' : 'pl-negative'}`}>
          <span>Settled: <strong>{data.count}</strong></span>
          <span>Won: <strong className="text-success">{data.wins}</strong></span>
          <span>Lost: <strong className="text-danger">{data.losses}</strong></span>
          <span>Strike Rate: <strong>{data.strike_rate}%</strong></span>
          <span className="settled-total-pl">
            P/L: <strong className={(data.total_pl || 0) >= 0 ? 'text-success' : 'text-danger'}>
              {(data.total_pl || 0) >= 0 ? '+' : ''}£{(data.total_pl || 0).toFixed(2)}
            </strong>
          </span>
          <span>Commission: <strong>£{(data.total_commission || 0).toFixed(2)}</strong></span>
        </div>
      )}

      {/* Filter toggles */}
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

      {/* Hidden table for Excel export */}
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
                    className="btn btn-analysis btn-sm"
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

// ── Rules Tab ──
function RulesTab({ results }) {
  if (!results || results.length === 0) {
    return <p className="empty">No markets evaluated yet.</p>
  }
  const fname = `chimera_rules_${new Date().toISOString().slice(0, 10)}`
  return (
    <div>
      <div className="tab-toolbar">
        <h2>Rule Evaluations</h2>
        <SnapshotButton tableId="rules-table" filename={fname} />
      </div>
      <table id="rules-table">
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
              <td>{r.favourite?.name || '-'}</td>
              <td>{r.favourite?.odds?.toFixed(2) || '-'}</td>
              <td>{r.second_favourite?.name || '-'}</td>
              <td>{r.second_favourite?.odds?.toFixed(2) || '-'}</td>
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
      <div className="tab-toolbar bottom">
        <SnapshotButton tableId="rules-table" filename={fname} />
      </div>
    </div>
  )
}

// ── Errors Tab ──
function ErrorsTab({ errors }) {
  if (!errors || errors.length === 0) {
    return <p className="empty">No errors. Suspiciously quiet.</p>
  }
  return (
    <div>
      <h2>Errors</h2>
      <div className="error-list">
        {errors.map((e, i) => (
          <div key={i} className="error-item">
            <span className="error-time">
              {new Date(e.timestamp).toLocaleTimeString()}
            </span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
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

      {/* Generate form */}
      <form className="api-key-form" onSubmit={handleGenerate}>
        <input
          type="text"
          placeholder="Key label (e.g. Report Agent)"
          value={label}
          onChange={e => setLabel(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">Generate Key</button>
      </form>

      {/* New key display */}
      {newKey && (
        <div className="new-key-box">
          <p><strong>New API key created — copy it now, it won't be shown again:</strong></p>
          <div className="key-display">
            <code>{newKey}</code>
            <button className="btn btn-secondary" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Endpoints reference */}
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

      {/* Existing keys */}
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
                    <button className="btn-sm btn-danger-sm" onClick={() => handleRevoke(k.key_id)}>
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

  // Load templates + reports on mount
  useEffect(() => {
    api('/api/reports/templates').then(data => setTemplates(data.templates || []))
    fetchReports()
  }, [])

  const fetchReports = () => {
    api('/api/reports').then(data => setReports(data.reports || []))
  }

  // Fetch sessions for selected date
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
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; color: #1a1a1a; line-height: 1.7; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; border-bottom: 2px solid #00D4FF; padding-bottom: 8px; color: #0a0f1e; }
  h2 { font-size: 18px; color: #0a0f1e; margin-top: 28px; }
  h3 { font-size: 15px; color: #333; margin-top: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  th { background: #0a0f1e; color: #fff; padding: 8px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-bottom: 1px solid #e0e0e0; }
  tr:nth-child(even) td { background: #f8f9fa; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  em { color: #666; }
  strong { color: #0a0f1e; }
  @media print { body { padding: 20px; } }
</style>
</head><body>${content}</body></html>`)
    printWindow.document.close()
    setTimeout(() => { printWindow.print() }, 500)
  }

  // Simple markdown to HTML converter
  const renderMarkdown = (md) => {
    if (!md) return ''
    let html = md
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold & italic
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Code
      .replace(/`(.+?)`/g, '<code>$1</code>')
      // Horizontal rule
      .replace(/^---$/gm, '<hr/>')
      // Bullet lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // Tables
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
    // Paragraphs (lines not already wrapped)
    html = html.replace(/^(?!<[hultdor])((?!<).+)$/gm, '<p>$1</p>')
    return html
  }

  // ── Report Viewer ──
  if (viewingReport) {
    return (
      <div>
        <div className="tab-toolbar">
          <button className="btn btn-secondary btn-back" onClick={() => setViewingReport(null)}>
            ← Back to Reports
          </button>
          <h2>{viewingReport.title}</h2>
          <button className="btn btn-primary" onClick={handleDownloadPDF}>
            Download / Print PDF
          </button>
        </div>
        <div className="report-viewer" ref={reportContentRef}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(viewingReport.content) }}
        />
      </div>
    )
  }

  // Get available dates from all sessions (for the date picker)
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div>
      <h2>Reports</h2>

      {/* ── Date & Session Selector ── */}
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
            <h3>Snapshots for {selectedDate}</h3>
            {loadingSessions ? (
              <p className="empty">Loading snapshots...</p>
            ) : daySessions.length === 0 ? (
              <p className="empty">No snapshots found for this date.</p>
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
                      <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>
                        {s.mode === 'LIVE' ? 'LIVE BET' : 'DRY RUN'}
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

                {/* Template selection overlay */}
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
                  className="btn btn-report"
                  onClick={handleGenerateReport}
                  disabled={generating || selectedSessionIds.length === 0}
                >
                  {generating ? 'Generating Report...' : 'Daily Report'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Report List ── */}
      <div className="report-list-section">
        <h3>Generated Reports</h3>
        {reports.length === 0 ? (
          <p className="empty">No reports generated yet. Select a date and snapshots above to create one.</p>
        ) : (
          <div className="report-list">
            {reports.map(r => (
              <div key={r.report_id} className="report-card">
                <div className="report-card-info">
                  <strong>{r.title}</strong>
                  <span className="report-card-meta">
                    {r.template_name} · {new Date(r.created_at).toLocaleString()} · {r.session_ids?.length || 0} snapshot{(r.session_ids?.length || 0) !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="report-card-actions">
                  <button className="btn btn-sm-view" onClick={() => handleViewReport(r.report_id)}>
                    View
                  </button>
                  <button className="btn-sm btn-danger-sm" onClick={() => handleDeleteReport(r.report_id)}>
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

// ── App Root ──
export default function App() {
  const [authed, setAuthed] = useState(false)

  // Check if already authenticated (e.g. after cold start recovery)
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
