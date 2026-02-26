import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Bar, Line } from 'react-chartjs-2'

ChartJS.register(
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler
)

const API = import.meta.env.VITE_API_URL || ''

function api(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json())
}

// ── Chart default options (dark theme) ──
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#1a2840',
      titleColor: '#e2e8f0',
      bodyColor: '#94a3b8',
      borderColor: '#243a52',
      borderWidth: 1,
      padding: 10,
      titleFont: { family: 'Inter', size: 11 },
      bodyFont: { family: 'Inter', size: 11 },
    },
  },
  scales: {
    x: {
      grid: { color: 'rgba(30, 48, 68, 0.5)', drawBorder: false },
      ticks: { color: '#64748b', font: { family: 'Inter', size: 10 } },
    },
    y: {
      grid: { color: 'rgba(30, 48, 68, 0.5)', drawBorder: false },
      ticks: { color: '#64748b', font: { family: 'Inter', size: 10 } },
    },
  },
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

// ── Small Components ──
function SnapshotButton({ tableId, filename }) {
  return (
    <button className="btn btn-snapshot" onClick={() => downloadTableAsExcel(tableId, filename || 'chimera_export')}>
      Export
    </button>
  )
}

function Badge({ status }) {
  const colors = {
    RUNNING: '#10b981',
    STOPPED: '#ef4444',
    STARTING: '#f59e0b',
    AUTH_FAILED: '#ef4444',
  }
  return (
    <span className="badge" style={{ background: colors[status] || '#64748b' }}>
      {status || 'UNKNOWN'}
    </span>
  )
}

function PriceCell({ price, size, type }) {
  if (!price) return <span className="price-cell" style={{ opacity: 0.3 }}>—</span>
  return (
    <span className={`price-cell ${type}`}>
      <span className="price-cell-price">{price.toFixed(2)}</span>
      <span className="price-cell-size">£{size?.toFixed(0) || 0}</span>
    </span>
  )
}

const COUNTRY_LABELS = { GB: '🇬🇧 GB', IE: '🇮🇪 IE', ZA: '🇿🇦 ZA', FR: '🇫🇷 FR' }
const ALL_COUNTRIES = ['GB', 'IE', 'ZA', 'FR']

// ── Pegasus SVG Icon ──
function PegasusIcon() {
  return (
    <svg viewBox="0 0 32 32" width="24" height="24" fill="currentColor">
      <path d="M28 4c-1 0-2.5.8-3.5 1.5L22 2h-1.5l-1 3-5-2.5C14.5 2.5 11 5 11 9v1.5L7.5 14 5 19h2.5l2.5-3.5L11 17v6h2.5v-5l2.5 1.5V24H18.5v-5.5c2.5-1 5-3.5 5-7V10l3.5-1.5c0 0 2.5-1.2 2.5-2.5S29 4 28 4zM15 10.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
    </svg>
  )
}

// ── Shared date formatter ──
const formatDateHeader = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

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
        <PegasusIcon />
        <h1>CHIMERA</h1>
        <p className="subtitle">Lay Engine</p>
        <form onSubmit={handleLogin}>
          <input type="text" placeholder="Betfair Username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
          <input type="password" placeholder="Betfair Password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
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

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { if (isOpen && initialMessage && !initialSentRef.current) { initialSentRef.current = true; sendMessage(initialMessage) } }, [isOpen, initialMessage])
  useEffect(() => { if (!isOpen) initialSentRef.current = false }, [isOpen])
  useEffect(() => { if (isOpen && !initialMessage) inputRef.current?.focus() }, [isOpen])
  useEffect(() => { if (!isOpen && currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null } }, [isOpen])

  const speakText = async (text) => {
    if (!speakEnabled) return
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null }
    try {
      const res = await fetch(`${API}/api/audio/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      if (!res.ok) { if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.1; window.speechSynthesis.speak(u) }; return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudioRef.current = audio
      audio.onended = () => { URL.revokeObjectURL(url); currentAudioRef.current = null }
      audio.play()
    } catch (e) {
      if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.1; window.speechSynthesis.speak(u) }
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
      const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text.trim(), history: messages, date }) })
      if (res.reply) { setMessages([...updatedMessages, { role: 'assistant', content: res.reply }]); speakText(res.reply) }
      else { setMessages([...updatedMessages, { role: 'assistant', content: `Error: ${res.message || 'Unknown error'}` }]) }
    } catch (e) { setMessages([...updatedMessages, { role: 'assistant', content: 'Failed to connect to the analysis service.' }]) }
    setLoading(false)
  }

  const toggleListening = async () => {
    if (listening) { mediaRecorderRef.current?.stop(); setListening(false); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      audioChunksRef.current = []
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (blob.size < 100) return
        setLoading(true)
        try {
          const formData = new FormData()
          formData.append('file', blob, 'recording.webm')
          const res = await fetch(`${API}/api/audio/transcribe`, { method: 'POST', body: formData })
          const data = await res.json()
          if (data.text && data.text.trim()) sendMessage(data.text.trim())
        } catch (e) { console.error('Transcription failed:', e); setLoading(false) }
      }
      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start()
      setListening(true)
    } catch (e) { alert('Microphone access denied or not available.') }
  }

  if (!isOpen) return null

  return (
    <div className="chat-overlay" onClick={onClose}>
      <div className="chat-drawer" onClick={e => e.stopPropagation()}>
        <div className="chat-header">
          <h3>CHIMERA AI{date ? ` — ${date}` : ''}</h3>
          <div className="chat-header-actions">
            <button className={`btn-sm ${speakEnabled ? 'btn-sm-active' : ''}`}
              onClick={() => { setSpeakEnabled(!speakEnabled); if (speakEnabled) { currentAudioRef.current?.pause(); currentAudioRef.current = null; window.speechSynthesis?.cancel() } }}
              title={speakEnabled ? 'Mute voice' : 'Enable voice'}>{speakEnabled ? 'Sound ON' : 'Sound OFF'}</button>
            <button className="btn-sm" onClick={() => { setMessages([]); currentAudioRef.current?.pause(); currentAudioRef.current = null; window.speechSynthesis?.cancel() }}>Clear</button>
            <button className="btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="chat-messages">
          {messages.length === 0 && !loading && <p className="empty">Ask anything about your betting data.</p>}
          {messages.map((m, i) => <div key={i} className={`chat-msg chat-msg-${m.role}`}><div className="chat-msg-content">{m.content}</div></div>)}
          {loading && <div className="chat-msg chat-msg-assistant"><div className="chat-msg-content chat-loading">Thinking...</div></div>}
          <div ref={messagesEndRef} />
        </div>
        <form className="chat-input-row" onSubmit={e => { e.preventDefault(); sendMessage(input) }}>
          <button type="button" className={`btn-mic ${listening ? 'listening' : ''}`} onClick={toggleListening}>{listening ? 'Stop' : 'Mic'}</button>
          <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about your data..." disabled={loading} />
          <button type="submit" className="btn btn-primary btn-send" disabled={loading || !input.trim()}>Send</button>
        </form>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
//  CHART COMPONENTS
// ══════════════════════════════════════════════

function DailyPLChart({ daysSummary }) {
  if (!daysSummary || Object.keys(daysSummary).length === 0) return null
  const sorted = Object.entries(daysSummary).sort(([a], [b]) => a.localeCompare(b))
  const labels = sorted.map(([d]) => d.slice(5)) // MM-DD
  const values = sorted.map(([, v]) => v.day_pl)

  return (
    <div className="chart-container">
      <h3>Daily P/L</h3>
      <div className="chart-wrapper">
        <Bar data={{
          labels,
          datasets: [{
            data: values,
            backgroundColor: values.map(v => v >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
            borderColor: values.map(v => v >= 0 ? '#10b981' : '#ef4444'),
            borderWidth: 1,
            borderRadius: 3,
          }],
        }} options={{
          ...CHART_DEFAULTS,
          scales: {
            ...CHART_DEFAULTS.scales,
            y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `£${v}` } },
          },
        }} />
      </div>
    </div>
  )
}

function CumulativePLChart({ daysSummary }) {
  if (!daysSummary || Object.keys(daysSummary).length === 0) return null
  const sorted = Object.entries(daysSummary).sort(([a], [b]) => a.localeCompare(b))
  const labels = sorted.map(([d]) => d.slice(5))
  let cumulative = 0
  const values = sorted.map(([, v]) => { cumulative += v.day_pl; return Math.round(cumulative * 100) / 100 })

  return (
    <div className="chart-container">
      <h3>Cumulative P/L</h3>
      <div className="chart-wrapper">
        <Line data={{
          labels,
          datasets: [{
            data: values,
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointBackgroundColor: '#06b6d4',
            pointBorderColor: '#0c1421',
            pointBorderWidth: 2,
          }],
        }} options={{
          ...CHART_DEFAULTS,
          scales: {
            ...CHART_DEFAULTS.scales,
            y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `£${v}` } },
          },
        }} />
      </div>
    </div>
  )
}

function OddsDriftChart({ snapshots, title }) {
  if (!snapshots || snapshots.length < 3) return null // Need 3+ points for a meaningful chart
  const labels = snapshots.map(s => {
    if (s.minutes_to_off != null) return `${Math.round(s.minutes_to_off)}m`
    const d = new Date(s.timestamp)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  })
  // Snapshots contain runners[] array with lay_odds — extract fav (index 0) and 2nd fav (index 1)
  const favOdds = snapshots.map(s => {
    if (s.runners && s.runners.length > 0) return s.runners[0].lay_odds
    return s.fav_odds || s.favourite_odds || null
  })
  const secOdds = snapshots.map(s => {
    if (s.runners && s.runners.length > 1) return s.runners[1].lay_odds
    return s.sec_odds || s.second_fav_odds || null
  })

  // Try to get runner names from first snapshot
  const favName = snapshots[0]?.runners?.[0]?.runner_name || 'Favourite'
  const secName = snapshots[0]?.runners?.[1]?.runner_name || '2nd Favourite'

  const datasets = [{
    label: favName,
    data: favOdds,
    borderColor: '#06b6d4',
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    tension: 0.3,
    pointRadius: 3,
    pointBackgroundColor: '#06b6d4',
  }]
  if (secOdds.some(v => v != null)) {
    datasets.push({
      label: secName,
      data: secOdds,
      borderColor: '#f472b6',
      backgroundColor: 'rgba(244, 114, 182, 0.1)',
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: '#f472b6',
    })
  }

  return (
    <div className="chart-container">
      <h3>{title || 'Odds Drift'}</h3>
      <div className="chart-wrapper">
        <Line data={{ labels, datasets }} options={{
          ...CHART_DEFAULTS,
          plugins: {
            ...CHART_DEFAULTS.plugins,
            legend: { display: true, labels: { color: '#94a3b8', font: { family: 'Inter', size: 10 } } },
          },
        }} />
      </div>
    </div>
  )
}

function OddsBandChart({ bets }) {
  if (!bets || bets.length === 0) return null
  const bands = { '1.0-2.0': { w: 0, l: 0 }, '2.0-3.0': { w: 0, l: 0 }, '3.0-5.0': { w: 0, l: 0 }, '5.0-8.0': { w: 0, l: 0 }, '8.0+': { w: 0, l: 0 } }
  bets.forEach(b => {
    const odds = b.price_matched || b.price || 0
    const won = b.bet_outcome === 'WON' || b.result === 'WIN'
    let band = '8.0+'
    if (odds < 2) band = '1.0-2.0'
    else if (odds < 3) band = '2.0-3.0'
    else if (odds < 5) band = '3.0-5.0'
    else if (odds < 8) band = '5.0-8.0'
    if (won) bands[band].w++; else bands[band].l++
  })
  const labels = Object.keys(bands)
  const wins = labels.map(l => bands[l].w)
  const losses = labels.map(l => bands[l].l)

  return (
    <div className="chart-container">
      <h3>Outcome by Odds Band</h3>
      <div className="chart-wrapper">
        <Bar data={{
          labels,
          datasets: [
            { label: 'Won', data: wins, backgroundColor: 'rgba(16, 185, 129, 0.7)', borderColor: '#10b981', borderWidth: 1, borderRadius: 3 },
            { label: 'Lost', data: losses, backgroundColor: 'rgba(239, 68, 68, 0.7)', borderColor: '#ef4444', borderWidth: 1, borderRadius: 3 },
          ],
        }} options={{
          ...CHART_DEFAULTS,
          plugins: {
            ...CHART_DEFAULTS.plugins,
            legend: { display: true, labels: { color: '#94a3b8', font: { family: 'Inter', size: 10 } } },
          },
          scales: {
            ...CHART_DEFAULTS.scales,
            x: { ...CHART_DEFAULTS.scales.x, stacked: true },
            y: { ...CHART_DEFAULTS.scales.y, stacked: true, ticks: { ...CHART_DEFAULTS.scales.y.ticks, stepSize: 1 } },
          },
        }} />
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
//  TAB COMPONENTS
// ══════════════════════════════════════════════

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
        {bets && bets.length > 0 && <SnapshotButton tableId="live-bets-table" filename={fname} />}
      </div>

      {!bets || bets.length === 0 ? (
        <p className="empty">No bets placed in the current session.</p>
      ) : (
        <table id="live-bets-table">
          <thead>
            <tr><th>Time</th><th>Venue</th><th>Runner</th><th>Odds</th><th>Stake</th><th>Liability</th><th>Rule</th><th>Status</th></tr>
          </thead>
          <tbody>
            {bets.map((b, i) => (
              <tr key={i} className={b.dry_run ? 'row-dry' : ''}>
                <td>{new Date(b.timestamp).toLocaleTimeString()}</td>
                <td>{b.venue || '—'}</td>
                <td>{b.runner_name}</td>
                <td><span className="cell-lay-odds">{b.price?.toFixed(2)}</span></td>
                <td>£{b.size?.toFixed(2)}</td>
                <td>£{b.liability?.toFixed(2)}</td>
                <td><code>{b.rule_applied}</code></td>
                <td><span className={`status-${b.betfair_response?.status?.toLowerCase()}`}>{b.dry_run ? 'DRY' : b.betfair_response?.status || '?'}</span></td>
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
                <tr><th>Venue</th><th>Race</th><th>Favourite</th><th>Odds</th><th>2nd Fav</th><th>Odds</th><th>Rule</th><th>Bets</th></tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className={r.skipped ? 'row-skip' : ''}>
                    <td>{r.venue}</td><td>{r.market_name}</td>
                    <td>{r.favourite?.name || '-'}</td><td>{r.favourite?.odds?.toFixed(2) || '-'}</td>
                    <td>{r.second_favourite?.name || '-'}</td><td>{r.second_favourite?.odds?.toFixed(2) || '-'}</td>
                    <td>{r.skipped ? <span className="skip">{r.skip_reason}</span> : <code>{r.rule_applied}</code>}</td>
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

// ── Market Tab ──
function MarketTab() {
  const [markets, setMarkets] = useState([])
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [book, setBook] = useState(null)
  const [loadingBook, setLoadingBook] = useState(false)
  const [monitoringData, setMonitoringData] = useState(null)
  const refreshRef = useRef(null)

  useEffect(() => {
    const fetchMarkets = () => {
      api('/api/markets').then(data => {
        const ms = data.markets || []
        setMarkets(ms)
        if (!selectedMarketId && ms.length > 0) setSelectedMarketId(ms[0].market_id)
      }).catch(() => {})
    }
    fetchMarkets()
    const iv = setInterval(fetchMarkets, 30000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!selectedMarketId) { setBook(null); setMonitoringData(null); return }
    const fetchBook = () => {
      setLoadingBook(true)
      api(`/api/markets/${selectedMarketId}/book`)
        .then(data => { setBook(data); setLoadingBook(false) })
        .catch(() => setLoadingBook(false))
    }
    fetchBook()
    refreshRef.current = setInterval(fetchBook, 5000)

    // Also fetch monitoring data
    api(`/api/monitoring/${selectedMarketId}`)
      .then(data => setMonitoringData(data?.snapshots || []))
      .catch(() => setMonitoringData([]))

    return () => clearInterval(refreshRef.current)
  }, [selectedMarketId])

  const currentMarket = markets.find(m => m.market_id === selectedMarketId) || {}

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Markets</h2>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{markets.length} markets today</span>
      </div>

      <div className="market-controls">
        <select className="market-select" value={selectedMarketId} onChange={e => setSelectedMarketId(e.target.value)}>
          {markets.length === 0 && <option value="">No markets discovered</option>}
          {markets.map(m => (
            <option key={m.market_id} value={m.market_id}>
              {new Date(m.race_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {m.venue} — {m.market_name}
              {m.in_window ? ' [IN WINDOW]' : m.monitoring_snapshots > 0 ? ' [MONITORING]' : ''}
            </option>
          ))}
        </select>
        {currentMarket.in_window && <span className="market-badge badge-in-window">IN WINDOW</span>}
        {!currentMarket.in_window && currentMarket.monitoring_snapshots > 0 && <span className="market-badge badge-monitoring">MONITORING</span>}
      </div>

      {currentMarket.venue && (
        <div className="market-info">
          <span>Venue: <strong>{currentMarket.venue}</strong></span>
          <span>Country: <strong>{currentMarket.country}</strong></span>
          <span>Race: <strong>{new Date(currentMarket.race_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></span>
          <span>Status: <strong>{currentMarket.status}</strong></span>
          {currentMarket.minutes_to_off > 0 && <span>Off in: <strong>{Math.round(currentMarket.minutes_to_off)}m</strong></span>}
        </div>
      )}

      {loadingBook && !book ? (
        <p className="empty">Loading market book...</p>
      ) : book && book.runners ? (
        <>
          <table>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Runner</th>
                <th>Back 3</th><th>Back 2</th><th>Back 1</th>
                <th>Lay 1</th><th>Lay 2</th><th>Lay 3</th>
                <th style={{ textAlign: 'right' }}>Last</th>
              </tr>
            </thead>
            <tbody>
              {book.runners.map((r, i) => {
                const backs = r.back || r.back_prices || []
                const lays = r.lay || r.lay_prices || []
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.runner_name}{r.sort_priority === 1 ? ' ★' : ''}</td>
                    <td><PriceCell price={backs[2]?.price} size={backs[2]?.size} type="back" /></td>
                    <td><PriceCell price={backs[1]?.price} size={backs[1]?.size} type="back" /></td>
                    <td><PriceCell price={backs[0]?.price} size={backs[0]?.size} type="back" /></td>
                    <td><PriceCell price={lays[0]?.price} size={lays[0]?.size} type="lay" /></td>
                    <td><PriceCell price={lays[1]?.price} size={lays[1]?.size} type="lay" /></td>
                    <td><PriceCell price={lays[2]?.price} size={lays[2]?.size} type="lay" /></td>
                    <td style={{ textAlign: 'right' }}>
                      {r.last_price_traded ? <span className="cell-lay-odds">{r.last_price_traded.toFixed(2)}</span> : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {(() => {
            // Calculate book percentage from best back prices
            const bookPct = book.runners.reduce((sum, r) => {
              const bestBack = (r.back || [])[0]?.price
              return bestBack ? sum + (100 / bestBack) : sum
            }, 0)
            return bookPct > 0 ? (
              <div style={{ marginTop: 10, fontSize: 11 }}>
                Book: <span className={`book-pct ${bookPct > 105 ? 'over' : 'fair'}`}>
                  {bookPct.toFixed(1)}%
                </span>
                {' · '}<span style={{ color: 'var(--text-muted)' }}>Matched: £{(book.total_matched || 0).toLocaleString()}</span>
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                No active book yet — market {currentMarket.minutes_to_off > 60 ? `${Math.round(currentMarket.minutes_to_off / 60)}h` : `${Math.round(currentMarket.minutes_to_off)}m`} from off
              </div>
            )
          })()}
        </>
      ) : (
        <p className="empty">Select a market above to view the book.</p>
      )}

      {monitoringData && monitoringData.length > 0 && (
        <div style={{ marginTop: 20 }}>
          {monitoringData.length < 3 ? (
            <div className="empty-state">
              Collecting odds data — {monitoringData.length} snapshot{monitoringData.length !== 1 ? 's' : ''} so far (need 3+ for drift chart). Snapshots are taken every 5 minutes for markets outside the processing window.
            </div>
          ) : (
            <OddsDriftChart snapshots={monitoringData} title={`Odds Movement — ${currentMarket.venue || ''}`} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Settled Tab ──
function SettledTab({ openChat }) {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [preset, setPreset] = useState('today')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [outcomeFilter, setOutcomeFilter] = useState('all')

  const applyPreset = (p) => {
    setPreset(p)
    const today = new Date().toISOString().slice(0, 10)
    const d = new Date()
    if (p === 'today') { setDateFrom(today); setDateTo(today) }
    else if (p === 'yesterday') { d.setDate(d.getDate() - 1); const y = d.toISOString().slice(0, 10); setDateFrom(y); setDateTo(y) }
    else if (p === '7days') { d.setDate(d.getDate() - 7); setDateFrom(d.toISOString().slice(0, 10)); setDateTo(today) }
    else if (p === 'month') { d.setDate(d.getDate() - 30); setDateFrom(d.toISOString().slice(0, 10)); setDateTo(today) }
  }

  useEffect(() => { applyPreset('today') }, [])

  useEffect(() => {
    if (!dateFrom) return
    setLoading(true)
    const params = new URLSearchParams()
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    api(`/api/settled?${params}`)
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [dateFrom, dateTo])

  if (loading) return <p className="empty">Loading settled bets...</p>

  const daysSummary = data?.days_summary || {}
  const totalPL = data?.total_pl || 0
  const wins = data?.wins || 0
  const losses = data?.losses || 0
  const strikeRate = data?.strike_rate || 0

  // Flatten all bets for chart
  const allBets = Object.values(daysSummary).flatMap(d => d.bets || [])

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Settled Bets</h2>
        {allBets.length > 0 && <SnapshotButton tableId="settled-table" filename={`chimera_settled_${dateFrom}`} />}
      </div>

      <div className="settled-filters">
        {['today', 'yesterday', '7days', 'month'].map(p => (
          <button key={p} className={`btn-filter ${preset === p ? 'active' : ''}`} onClick={() => applyPreset(p)}>
            {p === 'today' ? 'Today' : p === 'yesterday' ? 'Yesterday' : p === '7days' ? '7 Days' : 'Month'}
          </button>
        ))}
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPreset('') }}
          style={{ marginLeft: 8, padding: '5px 8px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 11, fontFamily: 'Inter' }} />
        <span style={{ color: 'var(--text-muted)' }}>to</span>
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPreset('') }}
          style={{ padding: '5px 8px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 11, fontFamily: 'Inter' }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {['all', 'won', 'lost'].map(f => (
            <button key={f} className={`btn-filter ${outcomeFilter === f ? 'active' : ''}`} onClick={() => setOutcomeFilter(f)}>
              {f === 'all' ? 'All' : f === 'won' ? 'Won' : 'Lost'}
            </button>
          ))}
        </div>
      </div>

      <div className={`settled-summary ${totalPL >= 0 ? 'pl-positive' : 'pl-negative'}`}>
        <span className="settled-total-pl">P/L: <strong className={totalPL >= 0 ? 'text-success' : 'text-danger'}>
          {totalPL >= 0 ? `+£${totalPL.toFixed(2)}` : `-£${Math.abs(totalPL).toFixed(2)}`}
        </strong></span>
        <span>Record: <strong>{wins}W – {losses}L</strong></span>
        <span>Strike Rate: <strong>{strikeRate}%</strong></span>
        <span>Bets: <strong>{data?.count || 0}</strong></span>
        <span>Commission: <strong>£{(data?.total_commission || 0).toFixed(2)}</strong></span>
      </div>

      {/* Charts */}
      {Object.keys(daysSummary).length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <DailyPLChart daysSummary={daysSummary} />
          <CumulativePLChart daysSummary={daysSummary} />
        </div>
      )}
      {Object.keys(daysSummary).length === 1 && allBets.length > 0 && (
        <OddsBandChart bets={allBets} />
      )}

      {/* Day-by-day breakdown */}
      {Object.entries(daysSummary).sort(([a], [b]) => b.localeCompare(a)).map(([date, dayData]) => {
        const dayBets = (dayData.bets || []).filter(b => {
          if (outcomeFilter === 'won') return b.bet_outcome === 'WON'
          if (outcomeFilter === 'lost') return b.bet_outcome === 'LOST'
          return true
        })
        return (
          <div key={date}>
            <div className="day-group-header">
              <span>{formatDateHeader(date)}</span>
              <div className="day-group-stats">
                <span>{dayData.wins}W – {dayData.losses}L</span>
                <span>Strike: {dayData.strike_rate}%</span>
                <span className={dayData.day_pl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 700 }}>
                  {dayData.day_pl >= 0 ? `+£${dayData.day_pl.toFixed(2)}` : `-£${Math.abs(dayData.day_pl).toFixed(2)}`}
                </span>
                <button className="btn-sm" style={{ marginLeft: 8 }}
                  onClick={() => openChat(date, `Analyse my settled bets for ${date}. Cover P/L breakdown, odds patterns, venue performance, and suggestions.`)}>
                  AI Report
                </button>
              </div>
            </div>
            <table id={`settled-table-${date}`} style={{ borderRadius: '0 0 6px 6px', border: '1px solid var(--border)', borderTop: 'none' }}>
              <thead>
                <tr><th>Time</th><th>Runner</th><th>Venue</th><th>Odds</th><th>Stake</th><th>Liability</th><th>P/L</th><th>Result</th><th>Rule</th></tr>
              </thead>
              <tbody>
                {dayBets.map((b, i) => (
                  <tr key={i}>
                    <td>{b.placed_date ? new Date(b.placed_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    <td style={{ fontWeight: 500 }}>{b.runner_name}</td>
                    <td>{b.venue}</td>
                    <td><span className="cell-lay-odds">{(b.price_matched || 0).toFixed(2)}</span></td>
                    <td>£{(b.size_settled || 0).toFixed(2)}</td>
                    <td>£{(b.our_liability || 0).toFixed(2)}</td>
                    <td className={b.profit >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 700 }}>
                      {b.profit >= 0 ? `+£${b.profit.toFixed(2)}` : `-£${Math.abs(b.profit).toFixed(2)}`}
                    </td>
                    <td>
                      <span style={{
                        color: b.bet_outcome === 'WON' ? 'var(--success)' : b.bet_outcome === 'LOST' ? 'var(--danger)' : 'var(--text-muted)',
                        fontWeight: 700
                      }}>{b.bet_outcome}</span>
                    </td>
                    <td>{b.rule_applied ? <code>{b.rule_applied}</code> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
      {allBets.length === 0 && <p className="empty">No settled bets for this period.</p>}
    </div>
  )
}

// ── Backtest Tab ──
function BacktestTab() {
  const [markets, setMarkets] = useState([])
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [settledData, setSettledData] = useState(null)

  useEffect(() => {
    Promise.all([
      api('/api/markets').then(d => d.markets || []).catch(() => []),
      api('/api/settled?date_from=2026-01-01').then(d => d).catch(() => null),
    ]).then(([ms, sd]) => {
      // Filter to markets with monitoring data
      const monitored = ms.filter(m => m.monitoring_snapshots > 0)
      setMarkets(monitored)
      setSettledData(sd)
      if (monitored.length > 0) setSelectedMarketId(monitored[0].market_id)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!selectedMarketId) { setSnapshots([]); return }
    api(`/api/monitoring/${selectedMarketId}`)
      .then(d => setSnapshots(d?.snapshots || []))
      .catch(() => setSnapshots([]))
  }, [selectedMarketId])

  const currentMarket = markets.find(m => m.market_id === selectedMarketId) || {}
  const allBets = settledData ? Object.values(settledData.days_summary || {}).flatMap(d => d.bets || []) : []
  const daysSummary = settledData?.days_summary || {}

  return (
    <div className="backtest-tab">
      <h2>Backtest & Analysis</h2>

      {/* Stats cards */}
      {settledData && (
        <div className="card-grid">
          <div className="stat-card">
            <div className="stat-card-label">Total P/L</div>
            <div className={`stat-card-value ${(settledData.total_pl || 0) >= 0 ? 'positive' : 'negative'}`}>
              {(settledData.total_pl || 0) >= 0 ? '+' : ''}£{(settledData.total_pl || 0).toFixed(2)}
            </div>
            <div className="stat-card-sub">All time</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Strike Rate</div>
            <div className="stat-card-value">{settledData.strike_rate || 0}%</div>
            <div className="stat-card-sub">{settledData.wins || 0}W – {settledData.losses || 0}L</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Total Bets</div>
            <div className="stat-card-value">{settledData.count || 0}</div>
            <div className="stat-card-sub">Settled</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Trading Days</div>
            <div className="stat-card-value">{Object.keys(daysSummary).length}</div>
            <div className="stat-card-sub">With results</div>
          </div>
        </div>
      )}

      {/* Cumulative & Daily P/L Charts */}
      {Object.keys(daysSummary).length > 1 && (
        <div className="backtest-grid">
          <CumulativePLChart daysSummary={daysSummary} />
          <DailyPLChart daysSummary={daysSummary} />
        </div>
      )}

      {/* Odds Band Analysis */}
      {allBets.length > 0 && (
        <OddsBandChart bets={allBets} />
      )}

      {/* Odds Drift Analysis */}
      <div className="backtest-section" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 12 }}>Odds Drift Analysis</h3>
        {loading ? (
          <p className="empty">Loading monitoring data...</p>
        ) : markets.length === 0 ? (
          <div className="empty-state">
            No monitoring data available yet. The engine records odds snapshots for markets outside the processing window.
            Start the engine to begin collecting drift data.
          </div>
        ) : (
          <>
            <div className="backtest-controls">
              <select className="market-select" value={selectedMarketId} onChange={e => setSelectedMarketId(e.target.value)}>
                {markets.map(m => (
                  <option key={m.market_id} value={m.market_id}>
                    {new Date(m.race_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {m.venue} — {m.market_name}
                    ({m.monitoring_snapshots} snapshots)
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {markets.length} market{markets.length !== 1 ? 's' : ''} with drift data
              </span>
            </div>

            {snapshots.length > 0 ? (
              <OddsDriftChart snapshots={snapshots} title={`Odds Drift — ${currentMarket.venue || ''} ${currentMarket.market_name || ''}`} />
            ) : (
              <p className="empty">No snapshots for this market.</p>
            )}
          </>
        )}
      </div>

      {/* Future backtest module placeholder */}
      <div className="empty-state" style={{ marginTop: 20 }}>
        Full backtesting engine coming soon — test JOFS thresholds, processing window timings, and rule parameters against historical Betfair data.
      </div>
    </div>
  )
}

// ── Win/Loss by Day Chart ──
function WinLossChart({ daysSummary }) {
  if (!daysSummary || Object.keys(daysSummary).length === 0) return null
  const sorted = Object.entries(daysSummary).sort(([a], [b]) => a.localeCompare(b))
  const labels = sorted.map(([d]) => d.slice(5))
  const wins = sorted.map(([, v]) => v.wins)
  const losses = sorted.map(([, v]) => -v.losses) // negative for visual separation

  return (
    <div className="chart-container">
      <h3>Win / Loss by Day</h3>
      <div className="chart-wrapper">
        <Bar data={{
          labels,
          datasets: [
            { label: 'Wins', data: wins, backgroundColor: 'rgba(16, 185, 129, 0.7)', borderColor: '#10b981', borderWidth: 1, borderRadius: 3 },
            { label: 'Losses', data: losses, backgroundColor: 'rgba(239, 68, 68, 0.7)', borderColor: '#ef4444', borderWidth: 1, borderRadius: 3 },
          ],
        }} options={{
          ...CHART_DEFAULTS,
          plugins: {
            ...CHART_DEFAULTS.plugins,
            legend: { display: true, labels: { color: '#94a3b8', font: { family: 'Inter', size: 10 } } },
            tooltip: { ...CHART_DEFAULTS.plugins.tooltip, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Math.abs(ctx.raw)}` } },
          },
          scales: {
            ...CHART_DEFAULTS.scales,
            x: { ...CHART_DEFAULTS.scales.x, stacked: true },
            y: { ...CHART_DEFAULTS.scales.y, stacked: true, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => Math.abs(v) } },
          },
        }} />
      </div>
    </div>
  )
}

// ── History Tab ──
function HistoryTab({ openChat }) {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [settledData, setSettledData] = useState(null)

  useEffect(() => {
    Promise.all([
      api('/api/sessions').then(data => data.sessions || []).catch(() => []),
      api('/api/settled?date_from=2026-01-01').then(d => d).catch(() => null),
    ]).then(([ss, sd]) => {
      setSessions(ss)
      setSettledData(sd)
      setLoading(false)
    })
  }, [])
  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    api(`/api/sessions/${selectedId}`).then(data => setDetail(data)).catch(() => setDetail(null))
  }, [selectedId])

  if (loading) return <p className="empty">Loading snapshots...</p>

  if (detail) {
    const bets = detail.bets || []
    const sm = detail.summary || {}
    return (
      <div>
        <div className="session-detail-header">
          <button className="btn btn-secondary btn-back" onClick={() => setSelectedId(null)}>Back</button>
          <h2>
            <span className={`badge ${detail.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>{detail.mode}</span>
            {' '}{detail.date}{' '}
            {new Date(detail.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {detail.stop_time && <> – {new Date(detail.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
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
          {bets.length === 0 ? <p className="empty">No bets in this snapshot.</p> : (
            <table id="session-bets-table">
              <thead>
                <tr><th>Time</th><th>Country</th><th>Runner</th><th>Odds</th><th>Stake</th><th>Liability</th><th>Rule</th><th>Status</th></tr>
              </thead>
              <tbody>
                {bets.map((b, i) => (
                  <tr key={i} className={b.dry_run ? 'row-dry' : ''}>
                    <td>{new Date(b.timestamp).toLocaleTimeString()}</td>
                    <td>{b.country || '—'}</td>
                    <td>{b.runner_name}</td>
                    <td><span className="cell-lay-odds">{b.price?.toFixed(2)}</span></td>
                    <td>£{b.size?.toFixed(2)}</td>
                    <td>£{b.liability?.toFixed(2)}</td>
                    <td><code>{b.rule_applied}</code></td>
                    <td><span className={`status-${b.betfair_response?.status?.toLowerCase()}`}>{b.dry_run ? 'DRY' : b.betfair_response?.status || '?'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  const grouped = {}
  sessions.forEach(s => { if (!grouped[s.date]) grouped[s.date] = []; grouped[s.date].push(s) })
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a))
  const getSessionCountries = (s) => (s.countries || s.summary?.countries || []).map(c => COUNTRY_LABELS[c] || c).join(' ')

  return (
    <div>
      <div className="tab-toolbar">
        <h2>History</h2>
        {sortedDates.length > 0 && (
          <button className="btn btn-analysis"
            onClick={() => openChat(sortedDates[0], `Provide a comprehensive analysis of today's snapshot data (${sortedDates[0]}). Cover odds drift patterns, rule distribution, risk exposure, venue patterns, timing observations, anomalies, and actionable suggestions for rule tuning. Format as 6-10 concise bullet points with specific numbers.`)}>
            Analysis {sortedDates[0]}
          </button>
        )}
      </div>
      {settledData?.days_summary && Object.keys(settledData.days_summary).length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <CumulativePLChart daysSummary={settledData.days_summary} />
          <WinLossChart daysSummary={settledData.days_summary} />
        </div>
      )}
      {sessions.length === 0 ? <p className="empty">No snapshots recorded yet. Start the engine to create one.</p> : (
        <div className="snapshots-grouped">
          {sortedDates.map(date => (
            <div key={date} className="snapshots-date-group">
              <div className="snapshots-date-header">
                <span className="snapshots-date-label">{formatDateHeader(date)}</span>
                <span className="snapshots-date-count">{grouped[date].length} snapshot{grouped[date].length !== 1 ? 's' : ''}</span>
              </div>
              <div className="snapshots-list">
                {grouped[date].map(s => (
                  <div key={s.session_id} className="snapshots-card" onClick={() => setSelectedId(s.session_id)}>
                    <div className="session-card-top">
                      <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>{s.mode === 'LIVE' ? 'LIVE' : 'DRY RUN'}</span>
                      <span className="session-card-time">
                        {new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {s.stop_time ? ` – ${new Date(s.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' – running'}
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

// ── Engine Tab ──
function EngineTab({ state, onStart, onStop, onToggleDryRun, onResetBets, onToggleCountry, onToggleJofs, onToggleSpread, onSetProcessWindow, onSetPointValue }) {
  const [keys, setKeys] = useState([])
  const [label, setLabel] = useState('')
  const [newKey, setNewKey] = useState(null)
  const [loadingKeys, setLoadingKeys] = useState(true)
  const [copied, setCopied] = useState(false)

  const fetchKeys = () => {
    api('/api/keys').then(data => { setKeys(data.keys || []); setLoadingKeys(false) }).catch(() => setLoadingKeys(false))
  }
  useEffect(() => { fetchKeys() }, [])

  const handleGenerate = async (e) => {
    e.preventDefault()
    const res = await api('/api/keys/generate', { method: 'POST', body: JSON.stringify({ label: label || 'Agent key' }) })
    if (res.key) { setNewKey(res.key); setLabel(''); setCopied(false); fetchKeys() }
  }
  const handleRevoke = async (keyId) => {
    if (!confirm('Revoke this API key?')) return
    await api(`/api/keys/${keyId}`, { method: 'DELETE' })
    fetchKeys()
  }
  const handleCopy = () => { navigator.clipboard.writeText(newKey); setCopied(true); setTimeout(() => setCopied(false), 2000) }

  return (
    <div className="engine-tab">
      <div className="engine-section">
        <h3>Power</h3>
        <div className="engine-row">
          <button className={`btn ${state.status === 'RUNNING' ? 'btn-danger' : 'btn-primary'}`} onClick={state.status === 'RUNNING' ? onStop : onStart}>
            {state.status === 'RUNNING' ? 'Stop Engine' : 'Start Engine'}
          </button>
          <button className={`btn ${state.dry_run ? 'btn-warning' : 'btn-success'}`} onClick={onToggleDryRun}>
            {state.dry_run ? 'DRY RUN → Go Live' : 'LIVE → Switch to Dry Run'}
          </button>
          <button className="btn btn-secondary" onClick={onResetBets}>Clear Bets & Re-process</button>
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
              <button key={c} className={`btn-toggle ${(state.countries || ['GB','IE']).includes(c) ? 'active' : ''}`} onClick={() => onToggleCountry(c)}>
                {COUNTRY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="engine-section">
        <h3>Risk Controls</h3>
        <div className="engine-row">
          <label>JOFS:</label>
          <button className={`btn-toggle ${state.jofs_control ? 'active' : ''}`} onClick={onToggleJofs}>{state.jofs_control ? 'ON' : 'OFF'}</button>
          <label>Spread Control:</label>
          <button className={`btn-toggle ${state.spread_control ? 'active' : ''}`} onClick={onToggleSpread}>{state.spread_control ? 'ON' : 'OFF'}</button>
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

      {/* ── API Keys Section ── */}
      <div className="api-section">
        <h3>API Keys</h3>
        <p className="api-description">
          Generate API keys for external agents. Use <code>X-API-Key</code> header or <code>?api_key=</code> query param.
        </p>
        <form className="api-key-form" onSubmit={handleGenerate}>
          <input type="text" placeholder="Key label (e.g. Report Agent)" value={label} onChange={e => setLabel(e.target.value)} />
          <button type="submit" className="btn btn-primary">Generate</button>
        </form>
        {newKey && (
          <div className="new-key-box">
            <p><strong>New API key — copy now:</strong></p>
            <div className="key-display">
              <code>{newKey}</code>
              <button className="btn btn-secondary" onClick={handleCopy}>{copied ? 'Copied!' : 'Copy'}</button>
            </div>
          </div>
        )}
        {keys.length > 0 && (
          <table>
            <thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last Used</th><th></th></tr></thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.key_id}>
                  <td>{k.label}</td>
                  <td><code>{k.key_preview}</code></td>
                  <td>{new Date(k.created_at).toLocaleDateString()}</td>
                  <td>{k.last_used ? new Date(k.last_used).toLocaleString() : 'Never'}</td>
                  <td><button className="btn-danger-sm" onClick={() => handleRevoke(k.key_id)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="api-endpoints" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Data Endpoints</h3>
          <table>
            <thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>GET</td><td><code>/api/data/sessions</code></td><td>All sessions</td></tr>
              <tr><td>GET</td><td><code>/api/data/bets</code></td><td>All bets</td></tr>
              <tr><td>GET</td><td><code>/api/data/results</code></td><td>Rule evaluations</td></tr>
              <tr><td>GET</td><td><code>/api/data/state</code></td><td>Engine state</td></tr>
              <tr><td>GET</td><td><code>/api/data/summary</code></td><td>Aggregated stats</td></tr>
            </tbody>
          </table>
        </div>
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

  useEffect(() => { api('/api/reports/templates').then(data => setTemplates(data.templates || [])); fetchReports() }, [])
  const fetchReports = () => { api('/api/reports').then(data => setReports(data.reports || [])) }

  useEffect(() => {
    if (!selectedDate) { setDaySessions([]); return }
    setLoadingSessions(true)
    api('/api/sessions').then(data => {
      const filtered = (data.sessions || []).filter(s => s.date === selectedDate)
      setDaySessions(filtered)
      setSelectedSessionIds(filtered.map(s => s.session_id))
      setLoadingSessions(false)
    }).catch(() => setLoadingSessions(false))
  }, [selectedDate])

  const toggleSession = (sid) => setSelectedSessionIds(prev => prev.includes(sid) ? prev.filter(id => id !== sid) : [...prev, sid])

  const handleConfirmGenerate = async () => {
    if (selectedSessionIds.length === 0) return
    setGenerating(true); setShowTemplateSelect(false)
    try {
      const res = await api('/api/reports/generate', { method: 'POST', body: JSON.stringify({ date: selectedDate, session_ids: selectedSessionIds, template: selectedTemplate }) })
      if (res.report_id) { fetchReports(); setViewingReport(res) }
    } catch (e) { console.error('Report generation failed:', e) }
    setGenerating(false)
  }

  const handleViewReport = async (reportId) => { const res = await api(`/api/reports/${reportId}`); if (res.content) setViewingReport(res) }
  const handleDeleteReport = async (reportId) => { if (!confirm('Delete this report?')) return; await api(`/api/reports/${reportId}`, { method: 'DELETE' }); fetchReports(); if (viewingReport?.report_id === reportId) setViewingReport(null) }

  const handleDownloadPDF = () => {
    if (!reportContentRef.current) return
    const content = reportContentRef.current.innerHTML
    const printWindow = window.open('', '_blank')
    printWindow.document.write(`<!DOCTYPE html><html><head><title>${viewingReport?.title || 'CHIMERA Report'}</title>
<style>body{font-family:'Inter','Segoe UI',sans-serif;padding:40px;color:#1a1a2e;line-height:1.7;max-width:900px;margin:0 auto}h1{font-size:20px;border-bottom:2px solid #06b6d4;padding-bottom:8px}h2{font-size:16px;margin-top:24px}h3{font-size:14px;color:#4a4a5a;margin-top:20px}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th{background:#f8f9fa;color:#4a4a5a;padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;border-bottom:1px solid #e5e7eb}td{padding:7px 12px;border-bottom:1px solid #f0f0f0}code{background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:11px}ul{padding-left:18px}li{margin-bottom:4px}hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}@media print{body{padding:20px}}</style>
</head><body>${content}</body></html>`)
    printWindow.document.close()
    setTimeout(() => { printWindow.print() }, 500)
  }

  const renderMarkdown = (md) => {
    if (!md) return ''
    let html = md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^---$/gm, '<hr/>').replace(/^- (.+)$/gm, '<li>$1</li>')
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    html = html.replace(/\n?\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/g, (match, headerRow, bodyRows) => {
      const headers = headerRow.split('|').map(h => h.trim()).filter(Boolean)
      const rows = bodyRows.trim().split('\n').map(row => row.split('|').map(c => c.trim()).filter(Boolean))
      let table = '<table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>'
      rows.forEach(r => { table += '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>' })
      return table + '</tbody></table>'
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
      if (es.key_findings?.length) h += '<ul>' + es.key_findings.map(f => `<li>${f}</li>`).join('') + '</ul>'
    }
    const dp = data.day_performance
    if (dp?.slices?.length) {
      h += `<h2>Performance Summary</h2><table><thead><tr><th>Slice</th><th>Bets</th><th>Record</th><th>Strike</th><th>Staked</th><th>P/L</th><th>ROI</th></tr></thead><tbody>`
      dp.slices.forEach(s => { h += `<tr><td>${s.label}</td><td>${s.total_bets}</td><td>${s.wins}W-${s.losses}L</td><td>${fmtPct(s.strike_rate)}</td><td>£${s.total_staked?.toFixed(2)}</td><td>${fmtPL(s.net_pl)}</td><td>${fmtPct(s.roi)}</td></tr>` })
      h += '</tbody></table>'
      if (dp.narrative) h += `<p><em>${dp.narrative}</em></p>`
    }
    const ob = data.odds_band_analysis
    if (ob?.bands?.length) {
      h += `<h2>Odds Band Analysis</h2><table><thead><tr><th>Band</th><th>Bets</th><th>Wins</th><th>Strike</th><th>P/L</th><th>ROI</th><th>Verdict</th></tr></thead><tbody>`
      ob.bands.forEach(b => { h += `<tr><td>${b.label}</td><td>${b.bets}</td><td>${b.wins}</td><td>${fmtPct(b.win_pct)}</td><td>${fmtPL(b.pl)}</td><td>${fmtPct(b.roi)}</td><td><strong>${b.verdict}</strong></td></tr>` })
      h += '</tbody></table>'
      if (ob.narrative) h += `<p><em>${ob.narrative}</em></p>`
    }
    const da = data.discipline_analysis
    if (da?.rows?.length) {
      h += `<h2>Discipline Analysis</h2><table><thead><tr><th>Discipline</th><th>Bets</th><th>Record</th><th>Strike</th><th>P/L</th><th>ROI</th></tr></thead><tbody>`
      da.rows.forEach(r => { h += `<tr><td>${r.discipline}</td><td>${r.bets}</td><td>${r.wins}W-${r.losses}L</td><td>${fmtPct(r.strike_rate)}</td><td>${fmtPL(r.pl)}</td><td>${fmtPct(r.roi)}</td></tr>` })
      h += '</tbody></table>'
      if (da.narrative) h += `<p><em>${da.narrative}</em></p>`
    }
    const va = data.venue_analysis
    if (va?.rows?.length) {
      h += `<h2>Venue Analysis</h2><table><thead><tr><th>Venue</th><th>Country</th><th>Disc.</th><th>Bets</th><th>Record</th><th>Strike</th><th>P/L</th><th>ROI</th><th>Rating</th></tr></thead><tbody>`
      va.rows.forEach(r => { h += `<tr><td>${r.venue}</td><td>${r.country}</td><td>${r.discipline}</td><td>${r.bets}</td><td>${r.wins}W-${r.losses}L</td><td>${fmtPct(r.strike_rate)}</td><td>${fmtPL(r.pl)}</td><td>${fmtPct(r.roi)}</td><td><strong>${r.rating}</strong></td></tr>` })
      h += '</tbody></table>'
      if (va.narrative) h += `<p><em>${va.narrative}</em></p>`
    }
    const confirmedBets = (data.bets || []).filter(b => b.result === 'WIN' || b.result === 'LOSS')
    if (confirmedBets.length) {
      h += `<h2>Individual Bet Breakdown</h2><table><thead><tr><th>Time</th><th>Runner</th><th>Venue</th><th>Odds</th><th>Stake</th><th>Liability</th><th>P/L</th><th>Result</th><th>Rule</th></tr></thead><tbody>`
      confirmedBets.forEach(b => {
        const rc = b.result === 'WIN' ? 'color:#10b981' : b.result === 'LOSS' ? 'color:#ef4444' : ''
        h += `<tr><td>${b.race_time || ''}</td><td>${b.selection}</td><td>${b.venue}</td><td>${fmtOdds(b.odds)}</td><td>£${b.stake?.toFixed(2)}</td><td>£${b.liability?.toFixed(2)}</td><td>${fmtPL(b.pl)}</td><td style="${rc}"><strong>${b.result}</strong></td><td>${b.rule || ''}</td></tr>`
      })
      h += '</tbody></table>'
    }
    const cp = data.cumulative_performance
    if (cp?.by_day?.length) {
      h += `<h2>Cumulative Performance</h2><table><thead><tr><th>Day</th><th>Date</th><th>Bets</th><th>Record</th><th>Strike</th><th>Day P/L</th><th>Cumulative</th></tr></thead><tbody>`
      cp.by_day.forEach(d => { h += `<tr><td>${d.day_number}</td><td>${d.date}</td><td>${d.bets}</td><td>${d.wins}W-${d.losses}L</td><td>${fmtPct(d.strike_rate)}</td><td>${fmtPL(d.pl)}</td><td><strong>${fmtPL(d.cumulative_pl)}</strong></td></tr>` })
      h += '</tbody></table>'
      if (cp.narrative) h += `<p><em>${cp.narrative}</em></p>`
    }
    const cc = data.conclusions
    if (cc) {
      if (cc.findings?.length) { h += `<h2>Key Findings</h2><ol>`; cc.findings.forEach(f => { h += f.priority ? `<li><strong>${f.text}</strong></li>` : `<li>${f.text}</li>` }); h += '</ol>' }
      if (cc.recommendations?.length) { h += `<h2>Recommendations</h2><ol>`; cc.recommendations.forEach(r => { h += r.priority ? `<li><strong>${r.text}</strong></li>` : `<li>${r.text}</li>` }); h += '</ol>' }
    }
    const ap = data.appendix
    if (ap?.data_sources?.length) { h += `<hr/><h3>Data Sources</h3><ul>`; ap.data_sources.forEach(ds => { h += `<li><strong>${ds.label}:</strong> ${ds.value}</li>` }); h += '</ul>' }
    h += `<hr/><p><em>Report generated by CHIMERA AI Agent</em></p>`
    return h
  }

  const renderReportContent = (report) => {
    if (!report?.content) return ''
    let content = report.content
    if (typeof content === 'string') {
      let trimmed = content.trim()
      if (trimmed.startsWith('```')) trimmed = trimmed.replace(/^```\w*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
      if (trimmed.startsWith('{')) { try { content = JSON.parse(trimmed) } catch (e) { /* not json */ } }
    }
    if (typeof content === 'object') return renderJsonReport(content)
    return renderMarkdown(content)
  }

  if (viewingReport) {
    return (
      <div>
        <div className="tab-toolbar">
          <button className="btn btn-secondary btn-back" onClick={() => setViewingReport(null)}>Back to Reports</button>
          <h2>{viewingReport.title}</h2>
          <button className="btn btn-primary" onClick={handleDownloadPDF}>Print / PDF</button>
        </div>
        <div className="report-viewer" ref={reportContentRef} dangerouslySetInnerHTML={{ __html: renderReportContent(viewingReport) }} />
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
          <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} max={today} />
        </div>
        {selectedDate && (
          <div className="report-sessions-panel">
            <h3>Snapshots for {selectedDate}</h3>
            {loadingSessions ? <p className="empty">Loading...</p> : daySessions.length === 0 ? <p className="empty">No snapshots for this date.</p> : (
              <>
                <div className="report-session-list">
                  {daySessions.map(s => (
                    <label key={s.session_id} className="report-session-item">
                      <input type="checkbox" checked={selectedSessionIds.includes(s.session_id)} onChange={() => toggleSession(s.session_id)} />
                      <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>{s.mode === 'LIVE' ? 'LIVE' : 'DRY RUN'}</span>
                      <span className="report-session-time">
                        {new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {s.stop_time ? ` – ${new Date(s.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' – running'}
                      </span>
                      <span className="report-session-stats">{s.summary?.total_bets || 0} bets · £{(s.summary?.total_stake || 0).toFixed(2)}</span>
                      <span className="report-session-countries">{(s.countries || s.summary?.countries || []).map(c => COUNTRY_LABELS[c] || c).join(' ')}</span>
                    </label>
                  ))}
                </div>
                {showTemplateSelect && (
                  <div className="report-template-select">
                    <h3>Choose Template</h3>
                    <div className="report-template-list">
                      {templates.map(t => (
                        <label key={t.id} className="report-template-item">
                          <input type="radio" name="template" value={t.id} checked={selectedTemplate === t.id} onChange={() => setSelectedTemplate(t.id)} />
                          <div><strong>{t.name}</strong><span className="template-desc">{t.description}</span></div>
                        </label>
                      ))}
                    </div>
                    <div className="report-template-actions">
                      <button className="btn btn-secondary" onClick={() => setShowTemplateSelect(false)}>Cancel</button>
                      <button className="btn btn-primary" onClick={handleConfirmGenerate} disabled={selectedSessionIds.length === 0}>Generate</button>
                    </div>
                  </div>
                )}
                <button className="btn btn-report" onClick={() => setShowTemplateSelect(true)} disabled={generating || selectedSessionIds.length === 0}>
                  {generating ? 'Generating...' : 'Daily Report'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="report-list-section">
        <h3>Generated Reports</h3>
        {reports.length === 0 ? <p className="empty">No reports generated yet.</p> : (
          <div className="report-list">
            {reports.map(r => (
              <div key={r.report_id} className="report-card">
                <div className="report-card-info">
                  <strong>{r.title}</strong>
                  <span className="report-card-meta">{r.template_name} · {new Date(r.created_at).toLocaleString()} · {r.session_ids?.length || 0} snapshot{(r.session_ids?.length || 0) !== 1 ? 's' : ''}</span>
                </div>
                <div className="report-card-actions">
                  <button className="btn-sm-view" onClick={() => handleViewReport(r.report_id)}>View</button>
                  <button className="btn-danger-sm" onClick={() => handleDeleteReport(r.report_id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════

function Dashboard() {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('live')
  const intervalRef = useRef(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInitialDate, setChatInitialDate] = useState(null)
  const [chatInitialMessage, setChatInitialMessage] = useState(null)

  const fetchState = useCallback(async () => {
    try { setState(await api('/api/state')) } catch (e) { console.error('Failed to fetch state:', e) }
  }, [])

  useEffect(() => { fetchState(); intervalRef.current = setInterval(fetchState, 10000); return () => clearInterval(intervalRef.current) }, [fetchState])

  const handleStart = async () => { await api('/api/engine/start', { method: 'POST' }); fetchState() }
  const handleStop = async () => { await api('/api/engine/stop', { method: 'POST' }); fetchState() }
  const handleToggleDryRun = async () => { await api('/api/engine/dry-run', { method: 'POST' }); fetchState() }
  const handleToggleSpreadControl = async () => { await api('/api/engine/spread-control', { method: 'POST' }); fetchState() }
  const handleToggleJofsControl = async () => { await api('/api/engine/jofs-control', { method: 'POST' }); fetchState() }
  const handleSetPointValue = async (value) => { await api('/api/engine/point-value', { method: 'POST', body: JSON.stringify({ value: parseFloat(value) }) }); fetchState() }
  const handleSetProcessWindow = async (minutes) => { await api('/api/engine/process-window', { method: 'POST', body: JSON.stringify({ minutes }) }); fetchState() }
  const handleResetBets = async () => { if (!confirm('Clear all bets and re-process all markets?')) return; await api('/api/engine/reset-bets', { method: 'POST' }); fetchState() }
  const handleToggleCountry = async (country) => {
    const current = state.countries || ['GB', 'IE']
    const updated = current.includes(country) ? current.filter(c => c !== country) : [...current, country]
    if (updated.length === 0) return
    await api('/api/engine/countries', { method: 'POST', body: JSON.stringify({ countries: updated }) }); fetchState()
  }
  const handleLogout = async () => { await api('/api/logout', { method: 'POST' }); window.location.reload() }
  const openChat = (date = null, initialMessage = null) => { setChatInitialDate(date); setChatInitialMessage(initialMessage); setChatOpen(true) }
  const closeChat = () => { setChatOpen(false); setChatInitialMessage(null) }

  if (!state) return <div className="loading">Loading engine state...</div>

  const s = state.summary || {}

  const TAB_CONFIG = [
    { id: 'live', label: 'Live' },
    { id: 'markets', label: 'Markets' },
    { id: 'settled', label: 'Settled' },
    { id: 'history', label: 'History' },
    { id: 'backtest', label: 'Backtest' },
    { id: 'reports', label: 'Reports' },
    { id: 'engine', label: 'Engine' },
  ]

  return (
    <div className="dashboard">
      <header>
        <div className="header-left">
          <div className="header-brand">
            <PegasusIcon />
            <h1>CHIMERA</h1>
          </div>
          <Badge status={state.status} />
          {state.dry_run && <span className="badge dry-run">DRY RUN</span>}
        </div>
        <div className="header-right">
          {state.balance != null && <span className="balance">£{state.balance?.toFixed(2)}</span>}
          <span className="date">{state.date}</span>
          <button className="btn-chat-icon" onClick={() => openChat()}>AI Chat</button>
          <button className="btn-logout" onClick={handleLogout}>Logout</button>
        </div>
      </header>

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
              {new Date(state.next_race.race_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' — '}{state.next_race.minutes_to_off > 0 ? `${Math.round(state.next_race.minutes_to_off)}m` : 'OFF'}
            </span>
          )}
        </div>
      </div>

      <nav className="tabs">
        {TAB_CONFIG.map(t => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'engine' && state.errors?.length > 0 && <span className="tab-dot red" />}
          </button>
        ))}
      </nav>

      <div className="tab-content">
        {tab === 'live' && <LiveTab bets={state.recent_bets} results={state.recent_results} errors={state.errors} />}
        {tab === 'markets' && <MarketTab />}
        {tab === 'settled' && <SettledTab openChat={openChat} />}
        {tab === 'history' && <HistoryTab openChat={openChat} />}
        {tab === 'backtest' && <BacktestTab />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'engine' && (
          <EngineTab state={state}
            onStart={handleStart} onStop={handleStop} onToggleDryRun={handleToggleDryRun}
            onResetBets={handleResetBets} onToggleCountry={handleToggleCountry}
            onToggleJofs={handleToggleJofsControl} onToggleSpread={handleToggleSpreadControl}
            onSetProcessWindow={handleSetProcessWindow} onSetPointValue={handleSetPointValue}
          />
        )}
      </div>

      <ChatDrawer isOpen={chatOpen} onClose={closeChat} initialDate={chatInitialDate} initialMessage={chatInitialMessage} />
    </div>
  )
}

// ── App Root ──
export default function App() {
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    api('/api/state').then(s => { if (s.authenticated) setAuthed(true) }).catch(() => {})
  }, [])

  if (!authed) return <LoginPanel onLogin={() => setAuthed(true)} />
  return <Dashboard />
}
