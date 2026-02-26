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
              {speakEnabled ? 'Sound ON' : 'Sound OFF'}
            </button>
            <button className="btn-sm" onClick={() => {
              setMessages([])
              currentAudioRef.current?.pause()
              currentAudioRef.current = null
              window.speechSynthesis?.cancel()
            }}>Clear</button>
            <button className="btn-sm" onClick={onClose}>Close</button>
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
            {listening ? 'Stop' : 'Mic'}
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

// ── Engine Tab ──
function EngineTab({ state, onStart, onStop, onToggleDryRun, onResetBets, onToggleCountry, onToggleJofs, onToggleSpread, onSetProcessWindow, onSetPointValue }) {
  return (
    <div className="engine-tab">
      <div className="engine-section">
        <h3>Power</h3>
        <div className="engine-row">
          <button className={`btn ${state.status === 'RUNNING' ? 'btn-danger' : 'btn-primary'}`}
            onClick={state.status === 'RUNNING' ? onStop : onStart}>
            {state.status === 'RUNNING' ? 'Stop Engine' : 'Start Engine'}
          </button>
          <button className={`btn ${state.dry_run ? 'btn-warning' : 'btn-success'}`}
            onClick={onToggleDryRun}>
            {state.dry_run ? 'Dry Run ON → Go Live' : 'LIVE → Switch to Dry Run'}
          </button>
          <button className="btn btn-secondary" onClick={onResetBets}>
            Clear Bets & Re-process
          </button>
        </div>
      </div>

      <div className="engine-section">
        <h3>Processing</h3>
        <div className="engine-row">
          <label>Window:
            <select value={state.process_window || 12} onChange={e => onSetProcessWindow(+e.target.value)}>
              {[5,8,10,12,15,20,30].map(v => <option key={v} value={v}>{v} min</option>)}
            </select>
          </label>
          <label>Points £:
            <select value={state.point_value || 1} onChange={e => onSetPointValue(+e.target.value)}>
              {[1,2,5,10,20,50].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <div className="country-toggles">
            {ALL_COUNTRIES.map(c => (
              <button key={c}
                className={`btn-toggle ${(state.countries || ['GB','IE']).includes(c) ? 'active' : ''}`}
                onClick={() => onToggleCountry(c)}>
                {COUNTRY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="engine-section">
        <h3>Risk Controls</h3>
        <div className="engine-row">
          <label>JOFS (Joint Favourite Split):</label>
          <button className={`btn-toggle ${state.jofs_control ? 'active' : ''}`}
            onClick={onToggleJofs}>
            {state.jofs_control ? 'ON' : 'OFF'}
          </button>
          <label>Spread Control:</label>
          <button className={`btn-toggle ${state.spread_control ? 'active' : ''}`}
            onClick={onToggleSpread}>
            {state.spread_control ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="engine-section">
        <h3>Session</h3>
        <div className="engine-info">
          <span>Session: <code>{state.session_id || '—'}</code></span>
          <span>Started: {state.session_start ? new Date(state.session_start).toLocaleTimeString() : '—'}</span>
          <span>Last scan: {state.last_scan ? new Date(state.last_scan).toLocaleTimeString() : '—'}</span>
        </div>
      </div>

      {state.errors && state.errors.length > 0 && (
        <div className="engine-section">
          <h3>Errors ({state.errors.length})</h3>
          <div className="error-list">
            {state.errors.map((e, i) => (
              <div key={i} className="error-item">
                <span className="error-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Live Tab ──
function LiveTab({ bets, results, errors }) {
  const [showRules, setShowRules] = useState(false)
  const fname = `chimera_live_${new Date().toISOString().slice(0, 10)}`

  return (
    <div>
      {errors && errors.length > 0 && (
        <div className="live-error-bar">
          {errors.length} error{errors.length !== 1 ? 's' : ''} — latest: {errors[errors.length - 1]?.message}
        </div>
      )}

      <div className="tab-toolbar">
        <h2>Live Bets</h2>
        {bets && bets.length > 0 && (
          <SnapshotButton tableId="live-bets-table" filename={fname} />
        )}
      </div>

      {!bets || bets.length === 0 ? (
        <p className="empty">No bets placed in the current session.</p>
      ) : (
        <table id="live-bets-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Venue</th>
              <th>Runner</th>
              <th>Odds</th>
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
                <td>{b.venue || '—'}</td>
                <td>{b.runner_name}</td>
                <td className="cell-lay-odds">{b.price?.toFixed(2)}</td>
                <td>£{b.size?.toFixed(2)}</td>
                <td>£{b.liability?.toFixed(2)}</td>
                <td><code>{b.rule_applied}</code></td>
                <td>
                  <span className={`status-${b.betfair_response?.status?.toLowerCase()}`}>
                    {b.dry_run ? 'DRY' : b.betfair_response?.status || '?'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {results && results.length > 0 && (
        <div className="live-rules-section">
          <button className="rules-toggle" onClick={() => setShowRules(!showRules)}>
            {showRules ? '▾' : '▸'} Rule Evaluations ({results.length})
          </button>
          {showRules && (
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
          )}
        </div>
      )}
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
          <p>Live recorded data (Data Recorder) &middot; Betfair historic data (purchased) &middot; Engine snapshots</p>
        </div>
        <div className="placeholder-section">
          <h3>Parameters</h3>
          <p>JOFS threshold &middot; Processing window &middot; Odds bands &middot; Stake sizing &middot; Venue filters</p>
        </div>
        <div className="placeholder-section">
          <h3>Output</h3>
          <p>Simulated P/L &middot; Strike rate by parameter &middot; Optimal configuration recommendations</p>
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

// ── History Tab (formerly Snapshots) ──
function HistoryTab({ openChat }) {
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
            Back
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
                  <th>Odds</th>
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
                        {b.dry_run ? 'DRY' : b.betfair_response?.status || '?'}
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
        <h2>History</h2>
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
          <p><strong>New API key created — copy it now, it won't be shown again:</strong></p>
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

  const handleGenerateReport = () => { setShowTemplateSelect(true) }

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
  h1 { font-size: 20px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
  h2 { font-size: 16px; color: #1a1a2e; margin-top: 24px; }
  h3 { font-size: 14px; color: #4a4a5a; margin-top: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12px; }
  th { background: #f8f9fa; color: #4a4a5a; padding: 8px 12px; text-align: left; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; }
  td { padding: 7px 12px; border-bottom: 1px solid #f0f0f0; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  ul { padding-left: 18px; }
  li { margin-bottom: 4px; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }
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
        try {
          content = JSON.parse(trimmed)
        } catch (e) {
          // Not valid JSON — fall through to markdown
        }
      }
    }
    if (typeof content === 'object') return renderJsonReport(content)
    return renderMarkdown(content)
  }

  // ── Report Viewer ──
  if (viewingReport) {
    return (
      <div>
        <div className="tab-toolbar">
          <button className="btn btn-secondary btn-back" onClick={() => setViewingReport(null)}>
            Back to Reports
          </button>
          <h2>{viewingReport.title}</h2>
          <button className="btn btn-primary" onClick={handleDownloadPDF}>
            Download / Print PDF
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
  const handleToggleSpreadControl = async () => {
    await api('/api/engine/spread-control', { method: 'POST' })
    fetchState()
  }
  const handleToggleJofsControl = async () => {
    await api('/api/engine/jofs-control', { method: 'POST' })
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

  const TAB_CONFIG = [
    { id: 'engine', label: 'Engine' },
    { id: 'live', label: 'Live' },
    { id: 'history', label: 'History' },
    { id: 'backtest', label: 'Backtest' },
    { id: 'reports', label: 'Reports' },
    { id: 'api', label: 'API Keys' },
  ]

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header>
        <div className="header-left">
          <h1>CHIMERA</h1>
          <Badge status={state.status} />
          {state.dry_run && <span className="badge dry-run">DRY RUN</span>}
        </div>
        <div className="header-right">
          {state.balance != null && (
            <span className="balance">£{state.balance?.toFixed(2)}</span>
          )}
          <span className="date">{state.date}</span>
          <button className="btn-chat-icon" onClick={() => openChat()}>AI Chat</button>
          <button className="btn-logout" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      {/* ── Stats Ribbon ── */}
      <div className="stats-ribbon">
        <div className="stats-ribbon-left">
          <span className="stat">Markets: <strong>{s.total_markets || 0}</strong></span>
          <span className="stat">Bets: <strong>{s.bets_placed || 0}</strong></span>
          {s.spread_rejections > 0 && <span className="stat">Rejected: <strong>{s.spread_rejections}</strong></span>}
          {s.jofs_splits > 0 && <span className="stat">JOFS: <strong>{s.jofs_splits}</strong></span>}
          <span className="stat">Staked: <strong>£{(s.total_stake || 0).toFixed(2)}</strong></span>
          <span className="stat">Liability: <strong>£{(s.total_liability || 0).toFixed(2)}</strong></span>
        </div>
        <div className="stats-ribbon-right">
          {state.next_race && (
            <span className="next-race-compact">
              Next: {state.next_race.venue}{' '}
              {new Date(state.next_race.race_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
              {' — '}{state.next_race.minutes_to_off > 0
                ? `${Math.round(state.next_race.minutes_to_off)}m`
                : 'OFF'}
            </span>
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
            {t.id === 'engine' && state.errors?.length > 0 && <span className="tab-dot red" />}
          </button>
        ))}
      </nav>

      {/* ── Tab Content ── */}
      <div className="tab-content">
        {tab === 'engine' && (
          <EngineTab state={state}
            onStart={handleStart} onStop={handleStop}
            onToggleDryRun={handleToggleDryRun}
            onResetBets={handleResetBets}
            onToggleCountry={handleToggleCountry}
            onToggleJofs={handleToggleJofsControl}
            onToggleSpread={handleToggleSpreadControl}
            onSetProcessWindow={handleSetProcessWindow}
            onSetPointValue={handleSetPointValue}
          />
        )}
        {tab === 'live' && <LiveTab bets={state.recent_bets} results={state.recent_results} errors={state.errors} />}
        {tab === 'history' && <HistoryTab openChat={openChat} />}
        {tab === 'backtest' && <BacktestTab />}
        {tab === 'reports' && <ReportsTab />}
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
