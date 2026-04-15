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

function downloadTableAsExcelRaw(html, filename) {
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

// Build XLS HTML for a single backtest: summary header + data rows
function buildBacktestExportHtml(summary, results, config) {
  const sm = summary || {}
  const cfg = config || {}
  let html = ''
  html += '<table border="1" cellpadding="4" cellspacing="0">'
  html += '<tr><td colspan="8" style="font-weight:bold;font-size:14px">CHIMERA Backtest Export</td></tr>'
  html += `<tr><td colspan="8">${cfg.date || ''} · ${(cfg.countries || []).join('/')} · Window: ${cfg.process_window_mins || '?'}min</td></tr>`
  html += `<tr><td>Markets</td><td><b>${sm.markets_evaluated || 0}</b></td>`
  html += `<td>Placed</td><td><b>${sm.markets_placed ?? sm.bets_placed ?? 0}</b></td>`
  html += `<td>Bets (instr)</td><td><b>${sm.bets_placed || 0}</b></td>`
  html += `<td>Skipped</td><td><b>${sm.markets_skipped || 0}</b></td></tr>`
  html += `<tr><td>Stake</td><td><b>&pound;${(sm.total_stake || 0).toFixed(2)}</b></td>`
  html += `<td>Liability</td><td><b>&pound;${(sm.total_liability || 0).toFixed(2)}</b></td>`
  html += `<td>P&amp;L</td><td><b>&pound;${(sm.total_pnl || 0).toFixed(2)}</b></td>`
  html += `<td>ROI</td><td><b>${sm.roi || 0}%</b></td></tr>`
  html += '<tr><td colspan="8"></td></tr>'
  html += '<tr><th>Time</th><th>Venue</th><th>Favourite</th><th>Odds</th><th>Rule</th><th>Stake</th><th>Liability</th><th>Result</th><th>P&amp;L</th></tr>'
  for (const r of (results || [])) {
    const instrs = r.instructions || []
    const totalStake = instrs.reduce((s, i) => s + (i.size || 0), 0)
    const totalLiab = instrs.reduce((s, i) => s + (i.liability || 0), 0)
    const outcomes = [...new Set(instrs.map(i => i.outcome).filter(Boolean))]
    const fav = r.favourite || {}
    html += '<tr>'
    html += `<td>${(r.race_time || '').slice(11, 16)}</td>`
    html += `<td>${r.venue || ''}</td>`
    html += `<td>${fav.name || ''}</td>`
    html += `<td>${fav.odds || ''}</td>`
    html += `<td>${r.skipped ? (r.skip_reason || 'SKIPPED') : (r.rule_applied || '')}</td>`
    html += `<td>${r.skipped ? '' : '&pound;' + totalStake.toFixed(2)}</td>`
    html += `<td>${r.skipped ? '' : '&pound;' + totalLiab.toFixed(2)}</td>`
    html += `<td>${r.skipped ? 'SKIPPED' : (outcomes.join('/') || '\u2014')}</td>`
    html += `<td>${r.skipped ? '' : '&pound;' + (r.pnl || 0).toFixed(2)}</td>`
    html += '</tr>'
  }
  html += '</table>'
  return html
}

// ── Snapshot Button ──
function SnapshotButton({ tableId, filename, summary, results, config }) {
  const handleExport = () => {
    if (summary && results) {
      downloadTableAsExcelRaw(buildBacktestExportHtml(summary, results, config), filename || 'chimera_export')
    } else {
      downloadTableAsExcel(tableId, filename || 'chimera_export')
    }
  }
  return (
    <button className="btn btn-secondary" onClick={handleExport}>
      Export
    </button>
  )
}

// ── Window formatter ──
function fmtWindow(mins) {
  if (mins == null) return '12m'
  if (mins >= 60) return `${mins / 60}h`
  if (mins < 1) return `${Math.round(mins * 60)}s`
  if (mins % 1 !== 0) return `${Math.floor(mins)}m ${Math.round((mins % 1) * 60)}s`
  return `${mins}m`
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
        <p className="subtitle">Lay Engine v5.0</p>
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

// ── Chat Markdown helpers ──
const renderChatMarkdown = (md) => {
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
const chatHasTable = (text) => /\|.+\|\n\|[-| :]+\|/m.test(text)

// ── Chat Drawer ──
const CHAT_HISTORY_KEY = 'chimera-chat-history'
const CHAT_HISTORY_MAX = 50

function ChatDrawer({ isOpen, onClose, initialDate, initialMessage }) {
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || '[]') } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [listening, setListening] = useState(false)
  const [speakEnabled, setSpeakEnabled] = useState(true)
  const [docContent, setDocContent] = useState(null)
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
    try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages.slice(-CHAT_HISTORY_MAX))) } catch {}
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

  const downloadDoc = (content) => {
    const html = renderChatMarkdown(content)
    const fullHtml = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>CHIMERA AI Analysis — ${new Date().toLocaleDateString('en-GB')}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 24px; color: #1a1a2e; }
  h1, h2, h3 { color: #1a1a2e; margin-top: 20px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 13px; }
  th { background: #1a1a2e; color: #fff; padding: 8px 12px; text-align: left; }
  td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
  tr:nth-child(even) td { background: #f8f9fa; }
  p { line-height: 1.6; margin: 8px 0; }
  ul { padding-left: 20px; }
  li { margin-bottom: 4px; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  strong { font-weight: 600; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }
</style>
</head><body>${html}</body></html>`
    const blob = new Blob([fullHtml], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chimera-analysis-${new Date().toISOString().slice(0, 10)}.html`
    a.click()
    URL.revokeObjectURL(url)
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
              {m.role === 'assistant' ? (
                <>
                  <div
                    className="chat-msg-content chat-msg-markdown"
                    dangerouslySetInnerHTML={{ __html: renderChatMarkdown(m.content) }}
                  />
                  {chatHasTable(m.content) && (
                    <div className="chat-msg-actions">
                      <button className="chat-doc-btn" onClick={() => setDocContent(m.content)}>
                        📄 View as Document
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="chat-msg-content">{m.content}</div>
              )}
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

      {docContent && (
        <div className="chat-doc-overlay" onClick={() => setDocContent(null)}>
          <div className="chat-doc-modal" onClick={e => e.stopPropagation()}>
            <div className="chat-doc-header">
              <span>CHIMERA AI — Document View</span>
              <div className="chat-doc-header-actions">
                <button className="btn-sm" onClick={() => downloadDoc(docContent)}>⬇ Download</button>
                <button className="btn-sm" onClick={() => setDocContent(null)}>✕ Close</button>
              </div>
            </div>
            <div
              className="chat-doc-body report-viewer"
              dangerouslySetInnerHTML={{ __html: renderChatMarkdown(docContent) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Shared Racing Card Tab (used by both Live and Dry Run tabs) ──
const EMPTY_SET = new Set()
const NOOP = () => {}
function LiveTab({ state, onStart, onStop, mode = 'live',
  checkedMarkets = EMPTY_SET, setCheckedMarkets = NOOP, snapshotLoading = false, setSnapshotLoading = NOOP,
  snapshotResult = null, setSnapshotResult = NOOP, snapshotHistory = [], setSnapshotHistory = NOOP,
  expandedSnapshotId = null, setExpandedSnapshotId = NOOP, snapshotDetail = null, setSnapshotDetail = NOOP,
  settingsConfirmed = false,
}) {
  const [markets, setMarkets] = useState([])
  const [selectedMarketId, setSelectedMarketId] = useState(null)
  const [book, setBook] = useState(null)
  const [loadingBook, setLoadingBook] = useState(false)
  const [countryFilter, setCountryFilter] = useState('all')
  const [expandedMonths, setExpandedMonths] = useState(new Set())

  const isDryRunMode = mode === 'dryrun'
  const isRunning = state.status === 'RUNNING'
  const isLiveRunning = isRunning && !state.dry_run
  const isDryRunning = isRunning && state.dry_run
  const isThisModeRunning = isDryRunMode ? isDryRunning : isLiveRunning
  const errors = state.errors || []
  const s = state.summary || {}

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

  // Load snapshot history on mount (dry run only)
  useEffect(() => {
    if (!isDryRunMode) return
    api('/api/snapshots').then(d => setSnapshotHistory(d.snapshots || [])).catch(() => {})
  }, [isDryRunMode])

  // Group markets by venue (filtered by country)
  const filtered = countryFilter === 'all'
    ? markets
    : markets.filter(m => m.country === countryFilter)
  const byVenue = {}
  filtered.forEach(m => {
    if (!byVenue[m.venue]) byVenue[m.venue] = []
    byVenue[m.venue].push(m)
  })

  // Toggle a single market checkbox
  const toggleMarketCheck = (marketId) => {
    setCheckedMarkets(prev => {
      const next = new Set(prev)
      if (next.has(marketId)) next.delete(marketId)
      else next.add(marketId)
      return next
    })
  }

  // Select/deselect all visible markets
  const toggleAllMarkets = () => {
    const allIds = filtered.map(m => m.market_id)
    const allChecked = allIds.length > 0 && allIds.every(id => checkedMarkets.has(id))
    if (allChecked) {
      setCheckedMarkets(new Set())
    } else {
      setCheckedMarkets(new Set(allIds))
    }
  }

  // Run dry-run snapshot
  const runSnapshot = async () => {
    if (checkedMarkets.size === 0) return
    setSnapshotLoading(true)
    setSnapshotResult(null)
    try {
      const result = await api('/api/engine/snapshot', {
        method: 'POST',
        body: JSON.stringify({ market_ids: [...checkedMarkets] }),
      })
      setSnapshotResult(result)
      // Refresh history
      const hist = await api('/api/snapshots')
      setSnapshotHistory(hist.snapshots || [])
    } catch (e) {
      console.error('Snapshot failed:', e)
    }
    setSnapshotLoading(false)
  }

  // Expand a snapshot in the history catalogue
  const toggleSnapshotExpand = async (snapshotId) => {
    if (expandedSnapshotId === snapshotId) {
      setExpandedSnapshotId(null)
      setSnapshotDetail(null)
      return
    }
    setExpandedSnapshotId(snapshotId)
    try {
      const detail = await api(`/api/snapshots/${snapshotId}`)
      setSnapshotDetail(detail)
    } catch {
      setSnapshotDetail(null)
    }
  }

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
            <>
              <button
                className="btn btn-warning btn-auto-bet"
                onClick={runSnapshot}
                disabled={checkedMarkets.size === 0 || snapshotLoading}
                title={checkedMarkets.size === 0 ? 'Select markets from the list first' : 'Run instant dry-run snapshot'}
              >
                {snapshotLoading ? 'Running...' : `Run Dry Run (${checkedMarkets.size})`}
              </button>
              <span className="badge badge-warning" style={{ fontSize: 11 }}>PAPER ONLY — No real money at risk</span>
              {snapshotResult && (
                <button className="btn btn-secondary" onClick={() => setSnapshotResult(null)} style={{ fontSize: 11 }}>
                  Clear Results
                </button>
              )}
            </>
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
          {isDryRunMode && filtered.length > 0 && (
            <div className="dryrun-select-all">
              <label onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && filtered.every(m => checkedMarkets.has(m.market_id))}
                  onChange={toggleAllMarkets}
                />
                <span>{filtered.every(m => checkedMarkets.has(m.market_id)) ? 'Deselect All' : 'Select All'}</span>
              </label>
              {checkedMarkets.size > 0 && (
                <span className="dryrun-checked-count">{checkedMarkets.size} selected</span>
              )}
            </div>
          )}
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
                      {isDryRunMode && (
                        <input
                          type="checkbox"
                          className="dryrun-checkbox"
                          checked={checkedMarkets.has(race.market_id)}
                          onChange={() => toggleMarketCheck(race.market_id)}
                          onClick={e => e.stopPropagation()}
                        />
                      )}
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

        {/* Right: market book / snapshot results */}
        <div className="live-book-panel">
          {isDryRunMode && snapshotLoading && (
            <div className="live-book-empty">
              <span>Running snapshot...</span>
            </div>
          )}
          {isDryRunMode && snapshotResult && !snapshotLoading && (
            <div className="live-book-inner snapshot-results">
              <div className="snapshot-strategy-bar">
                <span className="snapshot-strategy-title">Strategy</span>
                <span>{(snapshotResult.countries || []).map(c => COUNTRY_LABELS[c] || c).join(' ')}</span>
                <span>£{snapshotResult.point_value || 1}/pt</span>
                <span>Window: {fmtWindow(snapshotResult.process_window)}</span>
                <span className={snapshotResult.jofs_control ? 'tag-on' : 'tag-off'}>JOFS {snapshotResult.jofs_control ? 'ON' : 'OFF'}</span>
                <span className={snapshotResult.spread_control ? 'tag-on' : 'tag-off'}>Spread {snapshotResult.spread_control ? 'ON' : 'OFF'}</span>
                <span className={snapshotResult.mark_ceiling_enabled ? 'tag-on' : 'tag-off'}>Ceiling {snapshotResult.mark_ceiling_enabled ? 'ON' : 'OFF'}</span>
                <span className={snapshotResult.mark_floor_enabled ? 'tag-on' : 'tag-off'}>Floor {snapshotResult.mark_floor_enabled ? 'ON' : 'OFF'}</span>
                <span className={snapshotResult.mark_uplift_enabled ? 'tag-on' : 'tag-off'}>Uplift {snapshotResult.mark_uplift_enabled ? `${snapshotResult.mark_uplift_stake || 3} pts` : 'OFF'}</span>
                {snapshotResult.signal_overround_enabled && <span className="tag-on">Overround</span>}
                {snapshotResult.signal_field_size_enabled && <span className="tag-on">Field Size</span>}
                {snapshotResult.signal_steam_gate_enabled && <span className="tag-on">Steam Gate</span>}
                {snapshotResult.signal_band_perf_enabled && <span className="tag-on">Band Perf</span>}
              </div>
              <div className="snapshot-results-header">
                <h3>Snapshot Results</h3>
                <div className="snapshot-results-summary">
                  <span>Markets: <strong>{snapshotResult.markets_evaluated}</strong></span>
                  <span>Bets: <strong>{snapshotResult.bets_would_place}</strong></span>
                  <span>Stake: <strong>£{snapshotResult.total_stake?.toFixed(2)}</strong></span>
                  <span>Liability: <strong>£{snapshotResult.total_liability?.toFixed(2)}</strong></span>
                </div>
              </div>
              <table className="snapshot-results-table">
                <thead>
                  <tr>
                    <th>Venue</th>
                    <th>Time</th>
                    <th>Favourite</th>
                    <th>Odds</th>
                    <th>Rule</th>
                    <th>Bets</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshotResult.results || []).map((r, i) => (
                    <tr key={i} className={r.skipped ? 'row-skip' : ''}>
                      <td>{r.venue}</td>
                      <td>{fmtTime(r.race_time)}</td>
                      <td>{r.favourite_name || '—'}</td>
                      <td>{r.favourite_odds?.toFixed(2) || '—'}</td>
                      <td>
                        {r.skipped
                          ? <span className="skip">SKIPPED — {r.skip_reason}</span>
                          : <code>{r.rule_applied?.split(':')[0]}</code>
                        }
                      </td>
                      <td>
                        {r.bets && r.bets.length > 0 ? (
                          <div className="snapshot-bets-cell">
                            {r.bets.map((b, j) => (
                              <div key={j} className="snapshot-bet-line">
                                <span>{b.runner_name}</span>
                                <span>@ {b.price?.toFixed(2)}</span>
                                <span>£{b.size?.toFixed(2)}</span>
                                <span className="text-muted">(£{b.liability?.toFixed(2)})</span>
                              </div>
                            ))}
                          </div>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(!isDryRunMode || (!snapshotResult && !snapshotLoading)) && (
            <>
              {!selectedMarketId && (
                <div className="live-book-empty">
                  <span>{isDryRunMode ? 'Select markets and click "Run Dry Run", or click a race to view prices' : 'Select a race to view market prices'}</span>
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
            </>
          )}
        </div>

      </div>

      {/* Snapshot History — dry run only, below the racing layout */}
      {isDryRunMode && (
        <div className="snapshot-history" style={{ borderTop: '1px solid #e5e7eb', flexShrink: 0 }}>
          <div className="snapshot-history-header">
            <h3>Snapshot History</h3>
            <span className="text-muted" style={{ fontSize: 11 }}>{snapshotHistory.length} snapshot{snapshotHistory.length !== 1 ? 's' : ''}</span>
          </div>
          {snapshotHistory.length === 0 ? (
            <p className="empty" style={{ padding: '12px 16px' }}>No snapshots yet. Select markets and run a dry run.</p>
          ) : (
            <div className="snapshot-history-list">
              {(() => {
                const groups = {}
                snapshotHistory.forEach(snap => {
                  const key = new Date(snap.created_at).toLocaleString([], { year: 'numeric', month: 'long' })
                  if (!groups[key]) groups[key] = []
                  groups[key].push(snap)
                })
                return Object.entries(groups).map(([month, snaps]) => {
                  const isMonthOpen = expandedMonths.has(month)
                  return (
                    <div key={month}>
                      <div
                        className="snapshot-month-header"
                        onClick={() => setExpandedMonths(prev => {
                          const next = new Set(prev)
                          isMonthOpen ? next.delete(month) : next.add(month)
                          return next
                        })}
                      >
                        <span>{month}</span>
                        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'inherit', opacity: 0.7 }}>{snaps.length} snapshot{snaps.length !== 1 ? 's' : ''}</span>
                        <span className="snapshot-month-chevron">{isMonthOpen ? '▲' : '▼'}</span>
                      </div>
                      {isMonthOpen && snaps.map(snap => {
                const isExpanded = expandedSnapshotId === snap.snapshot_id
                return (
                  <div key={snap.snapshot_id} className={`snapshot-card${isExpanded ? ' expanded' : ''}`}>
                    <div
                      className="snapshot-card-header"
                      onClick={() => toggleSnapshotExpand(snap.snapshot_id)}
                    >
                      <span className="snapshot-card-time">
                        {new Date(snap.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span>Markets: <strong>{snap.markets_evaluated}</strong></span>
                      <span>Bets: <strong>{snap.bets_would_place}</strong></span>
                      <span>Stake: <strong>£{snap.total_stake?.toFixed(2)}</strong></span>
                      <span>Liability: <strong>£{snap.total_liability?.toFixed(2)}</strong></span>
                      {snap.rule_breakdown && Object.keys(snap.rule_breakdown).length > 0 && (
                        <span className="snapshot-rules-summary">
                          {Object.entries(snap.rule_breakdown).map(([rule, count]) => `${rule}: ${count}`).join(', ')}
                        </span>
                      )}
                      <span className="collapsible-chevron">{isExpanded ? '-' : '+'}</span>
                    </div>
                    {isExpanded && snapshotDetail && snapshotDetail.snapshot_id === snap.snapshot_id && (
                      <div className="snapshot-card-body">
                        <div className="snapshot-strategy-bar">
                          <span className="snapshot-strategy-title">Strategy</span>
                          <span>{(snapshotDetail.countries || []).map(c => COUNTRY_LABELS[c] || c).join(' ')}</span>
                          <span>£{snapshotDetail.point_value || 1}/pt</span>
                          <span className={snapshotDetail.jofs_control ? 'tag-on' : 'tag-off'}>JOFS {snapshotDetail.jofs_control ? 'ON' : 'OFF'}</span>
                          <span className={snapshotDetail.mark_ceiling_enabled ? 'tag-on' : 'tag-off'}>Ceiling {snapshotDetail.mark_ceiling_enabled ? 'ON' : 'OFF'}</span>
                          <span className={snapshotDetail.mark_floor_enabled ? 'tag-on' : 'tag-off'}>Floor {snapshotDetail.mark_floor_enabled ? 'ON' : 'OFF'}</span>
                          <span className={snapshotDetail.mark_uplift_enabled ? 'tag-on' : 'tag-off'}>Uplift {snapshotDetail.mark_uplift_enabled ? `${snapshotDetail.mark_uplift_stake || 3} pts` : 'OFF'}</span>
                        </div>
                        <table className="snapshot-results-table">
                          <thead>
                            <tr>
                              <th>Venue</th>
                              <th>Time</th>
                              <th>Favourite</th>
                              <th>Odds</th>
                              <th>Rule</th>
                              <th>Bets</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(snapshotDetail.results || []).map((r, i) => (
                              <tr key={i} className={r.skipped ? 'row-skip' : ''}>
                                <td>{r.venue}</td>
                                <td>{fmtTime(r.race_time)}</td>
                                <td>{r.favourite_name || '—'}</td>
                                <td>{r.favourite_odds?.toFixed(2) || '—'}</td>
                                <td>
                                  {r.skipped
                                    ? <span className="skip">SKIPPED — {r.skip_reason}</span>
                                    : <code>{r.rule_applied?.split(':')[0]}</code>
                                  }
                                </td>
                                <td>
                                  {r.bets && r.bets.length > 0 ? (
                                    <div className="snapshot-bets-cell">
                                      {r.bets.map((b, j) => (
                                        <div key={j} className="snapshot-bet-line">
                                          <span>{b.runner_name}</span>
                                          <span>@ {b.price?.toFixed(2)}</span>
                                          <span>£{b.size?.toFixed(2)}</span>
                                          <span className="text-muted">(£{b.liability?.toFixed(2)})</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Bet Settings Tab ──
function BetSettingsTab({ state, onToggleCountry, onToggleJofs, onToggleSpread, onToggleMarkCeiling, onToggleMarkFloor, onToggleMarkUplift, onSetMarkUpliftStake, onSetProcessWindow, onSetPointValue, onSetKelly, onToggleSignalOverround, onToggleSignalFieldSize, onToggleSignalSteamGate, onToggleSignalBandPerf, onToggleMarketOverlay, onToggleTop2Concentration, confirmed, onConfirm, onSettingsChanged }) {
  const s = state.summary || {}

  // Wrap every setting callback to mark dirty + unconfirmed
  const guard = (fn) => (...args) => { onSettingsChanged(); return fn(...args) }

  const handleConfirm = () => onConfirm()

  const handleReset = () => onSettingsChanged()
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
              onChange={guard(e => onSetProcessWindow(+e.target.value))}
            >
              {[
                { v: 0.5, label: '30 sec before off' },
                { v: 1, label: '1 min before off' },
                { v: 2, label: '2 min before off' },
                { v: 3, label: '3 min before off' },
                { v: 4, label: '4 min before off' },
                { v: 5, label: '5 min before off' },
                { v: 10, label: '10 min before off' },
                { v: 20, label: '20 min before off' },
                { v: 30, label: '30 min before off' },
                { v: 60, label: '1 hour before off' },
              ].map(({ v, label }) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </label>
          <label className="engine-label">
            Stake point value (£):
            <select
              value={state.point_value || 1}
              onChange={guard(e => onSetPointValue(e.target.value))}
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
                onClick={guard(() => onToggleCountry(c))}
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
            onClick={guard(onToggleJofs)}
            title="When gap between 1st and 2nd favourite is ≤ 0.2, stake is split evenly across both"
          >
            {state.jofs_control ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Spread Control:</span>
          <button
            className={`btn-toggle ${state.spread_control ? 'active' : ''}`}
            onClick={guard(onToggleSpread)}
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
            onClick={guard(onToggleMarkCeiling)}
            title="No lays above 8.0 odds — skip market entirely"
          >
            {state.mark_ceiling_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Hard Floor (&lt;1.5 skip):</span>
          <button
            className={`btn-toggle ${state.mark_floor_enabled ? 'active' : ''}`}
            onClick={guard(onToggleMarkFloor)}
            title="No lays below 1.5 odds — skip market entirely"
          >
            {state.mark_floor_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>2.5–3.5 Uplift:</span>
          <button
            className={`btn-toggle ${state.mark_uplift_enabled ? 'active' : ''}`}
            onClick={guard(onToggleMarkUplift)}
            title="When favourite odds are 2.5–3.5, increase stake"
          >
            {state.mark_uplift_enabled ? 'ON' : 'OFF'}
          </button>
          {state.mark_uplift_enabled && (
            <select
              className="select-small"
              value={state.mark_uplift_stake || 3}
              onChange={guard(e => onSetMarkUpliftStake(Number(e.target.value)))}
              style={{ marginLeft: 8, width: 70 }}
              title="Uplift stake (pts) for 2.5–3.5 band"
            >
              {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => (
                <option key={v} value={v}>{v} pts</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Signal Filters */}
      <div className="engine-section">
        <h3>Signal Filters</h3>
        <div className="engine-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <span className="engine-label">Overround:</span>
          <button
            className={`btn-toggle ${state.signal_overround_enabled ? 'active' : ''}`}
            onClick={guard(onToggleSignalOverround)}
            title="Halve stake when book >115%, skip when >120% — filters illiquid markets"
          >
            {state.signal_overround_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Field Size:</span>
          <button
            className={`btn-toggle ${state.signal_field_size_enabled ? 'active' : ''}`}
            onClick={guard(onToggleSignalFieldSize)}
            title="Cap stake at £10 when field >10 runners and fav odds ≥3.0 — large NH field filter"
          >
            {state.signal_field_size_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Steam Gate:</span>
          <button
            className={`btn-toggle ${state.signal_steam_gate_enabled ? 'active' : ''}`}
            onClick={guard(onToggleSignalSteamGate)}
            title="Skip bet when favourite has shortened ≥3% since first monitoring snapshot (live only)"
          >
            {state.signal_steam_gate_enabled ? 'ON' : 'OFF'}
          </button>
          <span className="engine-label" style={{ marginLeft: 16 }}>Band Perf:</span>
          <button
            className={`btn-toggle ${state.signal_band_perf_enabled ? 'active' : ''}`}
            onClick={guard(onToggleSignalBandPerf)}
            title="Cap stake at £10 when 5-day win rate for this odds band falls below 50%"
          >
            {state.signal_band_perf_enabled ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="engine-info" style={{ marginTop: 8 }}>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Overround: book &gt;115% → halve stake · &gt;120% → skip (illiquid market filter)
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Field Size: &gt;10 runners + odds ≥3.0 → cap £10 (high-variance NH field filter)
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Steam Gate: favourite shortening ≥3% → skip (laying into backed money, live only)
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Band Perf: 5-day win rate &lt;50% per odds band → cap £10 (rolling performance filter)
          </span>
          {(state.summary?.signal_rejections || 0) > 0 && (
            <span>Signal filtered this session: <strong style={{ color: '#f59e0b' }}>{state.summary.signal_rejections}</strong></span>
          )}
        </div>
      </div>

      {/* Market Overlay Modifier */}
      <div className="engine-section">
        <h3>Market Overlay Modifier</h3>
        <div className="engine-row">
          <span className="engine-label">Market Overlay:</span>
          <button
            className={`btn-toggle ${state.market_overlay_enabled ? 'active' : ''}`}
            onClick={guard(onToggleMarketOverlay)}
            title="Scales stakes by exchange overround: >1.02 ×1.15 · 1.00–1.02 ×1.00 · <1.00 ×0.80"
          >
            {state.market_overlay_enabled ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="engine-info" style={{ marginTop: 8 }}>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Overround &gt;1.02: ×1.15 stake (HIGH_OVERROUND — market unsettled, signals weighted higher)
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Overround 1.00–1.02: ×1.00 (NEUTRAL — no adjustment)
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            Overround &lt;1.00: ×0.80 stake (EFFICIENT_MARKET — edge already priced in, reduce aggression)
          </span>
        </div>
      </div>

      {/* TOP2_CONCENTRATION */}
      <div className="engine-section">
        <h3>TOP2 Concentration</h3>
        <div className="engine-row">
          <span className="engine-label">TOP2 Concentration:</span>
          <button
            className={`btn-toggle ${state.top2_concentration_enabled ? 'active' : ''}`}
            onClick={guard(onToggleTop2Concentration)}
            title="Suppresses or blocks lay bets when the market is heavily concentrated in the top two runners. SUPPRESS_MEDIUM ×0.60 · SUPPRESS_STRONG ×0.25 · BLOCK ×0.00. Requires ADVANCED tier data (pre-2026)."
          >
            {state.top2_concentration_enabled ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="engine-info" style={{ marginTop: 8 }}>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            WATCH: top2 ≥ 0.60 &amp; 3v2 ≤ 0.60 — log only, no stake change
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            SUPPRESS_MEDIUM: top2 ≥ 0.65 &amp; 3v2 ≤ 0.50 — stake ×0.60
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            SUPPRESS_STRONG: top2 ≥ 0.70 &amp; 3v2 ≤ 0.40 — stake ×0.25
          </span>
          <span style={{ color: '#8a8a9a', fontSize: 13 }}>
            BLOCK: top2 ≥ 0.80 &amp; 3v2 ≤ 0.30 &amp; 2v1 ≥ 0.85 — no lay placed
          </span>
        </div>
      </div>

      {/* Kelly Criterion */}
      <div className="engine-section">
        <h3>Kelly Criterion</h3>
        <div className="engine-row">
          <span className="engine-label">Kelly Criterion:</span>
          <button
            className={`btn-toggle ${state.kelly_enabled ? 'active' : ''}`}
            onClick={guard(() => onSetKelly({ enabled: !state.kelly_enabled }))}
            title="Size stakes using the Kelly Criterion — mathematically optimal bankroll allocation"
          >
            {state.kelly_enabled ? 'ON' : 'OFF'}
          </button>
        </div>
        {state.kelly_enabled && (
          <div className="engine-row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
            <label className="engine-label" style={{ gap: 6 }}>
              Fraction:
              <select
                className="select-small"
                value={state.kelly_fraction || 0.25}
                onChange={guard(e => onSetKelly({ fraction: parseFloat(e.target.value) }))}
                title="Quarter Kelly is strongly recommended to reduce variance"
              >
                <option value={0.25}>¼ Kelly (recommended)</option>
                <option value={0.5}>½ Kelly</option>
                <option value={1.0}>Full Kelly</option>
              </select>
            </label>
            <label className="engine-label" style={{ gap: 6 }}>
              Bankroll £:
              <input
                type="number"
                className="select-small"
                style={{ width: 90 }}
                value={state.kelly_bankroll || 1000}
                min={10}
                max={1000000}
                step={100}
                onChange={guard(e => onSetKelly({ bankroll: parseFloat(e.target.value) }))}
                title="Your total betting bankroll in £"
              />
            </label>
            <label className="engine-label" style={{ gap: 6 }}>
              Edge %:
              <input
                type="number"
                className="select-small"
                style={{ width: 70 }}
                value={state.kelly_edge_pct || 5}
                min={0}
                max={50}
                step={0.5}
                onChange={guard(e => onSetKelly({ edge_pct: parseFloat(e.target.value) }))}
                title="Your estimated edge over the market-implied probability (5% is a reasonable starting point)"
              />
            </label>
            <label className="engine-label" style={{ gap: 6 }}>
              Min stake £:
              <input
                type="number"
                className="select-small"
                style={{ width: 70 }}
                value={state.kelly_min_stake || 0.5}
                min={0.1}
                max={100}
                step={0.1}
                onChange={guard(e => onSetKelly({ min_stake: parseFloat(e.target.value) }))}
                title="Kelly stake will never go below this floor"
              />
            </label>
            <label className="engine-label" style={{ gap: 6 }}>
              Max stake £:
              <input
                type="number"
                className="select-small"
                style={{ width: 80 }}
                value={state.kelly_max_stake || 50}
                min={1}
                max={10000}
                step={1}
                onChange={guard(e => onSetKelly({ max_stake: parseFloat(e.target.value) }))}
                title="Kelly stake will never exceed this ceiling"
              />
            </label>
          </div>
        )}
        {state.kelly_enabled && (
          <div className="engine-info" style={{ marginTop: 6 }}>
            <span style={{ color: '#8a8a9a', fontSize: 13 }}>
              Replaces the strategy's fixed stake with a bankroll-proportional Kelly stake.
              Quarter Kelly is recommended — full Kelly maximises long-run growth but incurs large swings.
            </span>
          </div>
        )}
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

// ── Backtest History helpers ──
const BT_HISTORY_KEY = 'chimera_backtest_history'
const BT_HISTORY_MAX = 50

function btHistLoad() {
  try { return JSON.parse(localStorage.getItem(BT_HISTORY_KEY) || '[]') } catch { return [] }
}
function btHistSave(entries) {
  try { localStorage.setItem(BT_HISTORY_KEY, JSON.stringify(entries.slice(0, BT_HISTORY_MAX))) } catch {}
}

// Recompute summary stats from the results array so card and table always agree.
function computeSummaryFromResults(results, fallback = {}) {
  if (!results || !results.length) return fallback
  const active = results.filter(r => !r.skipped)
  const totalStake = active.reduce((s, r) => s + (r.instructions || []).reduce((ss, i) => ss + (i.size || 0), 0), 0)
  const totalLiab = active.reduce((s, r) => s + (r.instructions || []).reduce((ss, i) => ss + (i.liability || 0), 0), 0)
  const totalPnl = results.reduce((s, r) => s + (r.pnl || 0), 0)
  const betsPlaced = active.reduce((s, r) => s + (r.instructions || []).length, 0)
  const marketsPlaced = active.length
  const marketsSkipped = results.filter(r => r.skipped).length
  return {
    markets_evaluated: results.length,
    markets_placed: marketsPlaced,
    bets_placed: betsPlaced,
    markets_skipped: marketsSkipped,
    total_stake: Math.round(totalStake * 100) / 100,
    total_liability: Math.round(totalLiab * 100) / 100,
    total_pnl: Math.round(totalPnl * 100) / 100,
    roi: totalStake > 0 ? Math.round((totalPnl / totalStake) * 1000) / 10 : 0,
  }
}

// ── Cycle Run History helpers ──
const BT_CYCLE_KEY = 'chimera_backtest_cycle_history'
const BT_CYCLE_MAX = 20

function btCycleHistLoad() {
  try { return JSON.parse(localStorage.getItem(BT_CYCLE_KEY) || '[]') } catch { return [] }
}
function btCycleHistSave(entries) {
  try { localStorage.setItem(BT_CYCLE_KEY, JSON.stringify(entries.slice(0, BT_CYCLE_MAX))) } catch {}
}

// ── Backtest Tab ──
function BacktestTab() {
  const [datesLoading, setDatesLoading] = useState(true)
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState('')
  const [processWindow, setProcessWindow] = useState(5)
  const [countries, setCountries] = useState(['GB', 'IE'])
  const [jofsEnabled, setJofsEnabled] = useState(true)
  const [markCeiling, setMarkCeiling] = useState(false)
  const [markFloor, setMarkFloor] = useState(false)
  const [markUplift, setMarkUplift] = useState(false)
  const [markUpliftStake, setMarkUpliftStake] = useState(3)
  const [spreadControl, setSpreadControl] = useState(false)
  const [pointValue, setPointValue] = useState(1)
  const [aiAgentEnabled, setAiAgentEnabled] = useState(false)
  const [oddsAgentEnabled, setOddsAgentEnabled] = useState(false)
  const [oddsAgentInterval, setOddsAgentInterval] = useState(5)
  const [oddsAgentLookback, setOddsAgentLookback] = useState(30)
  const [kellyEnabled, setKellyEnabled] = useState(false)
  const [kellyFraction, setKellyFraction] = useState(0.25)
  const [kellyBankroll, setKellyBankroll] = useState(1000)
  const [kellyEdgePct, setKellyEdgePct] = useState(5)
  const [kellyMinStake, setKellyMinStake] = useState(0.5)
  const [kellyMaxStake, setKellyMaxStake] = useState(50)
  const [sigOverround, setSigOverround] = useState(false)
  const [sigFieldSize, setSigFieldSize] = useState(false)
  const [sigSteamGate, setSigSteamGate] = useState(false)
  const [sigBandPerf, setSigBandPerf] = useState(false)
  const [sigMarketOverlay, setSigMarketOverlay] = useState(false)
  const [top2Enabled, setTop2Enabled] = useState(false)

  const [marketsLoading, setMarketsLoading] = useState(false)
  const [markets, setMarkets] = useState([])
  const [selectedMarketIds, setSelectedMarketIds] = useState(new Set())

  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const [history, setHistory] = useState(() => btHistLoad())
  const [expandedHistId, setExpandedHistId] = useState(null)
  const [selectedHistIds, setSelectedHistIds] = useState(new Set())
  const [exportingSheets, setExportingSheets] = useState(false)

  // Cycle Run state
  const [cycleSelectedDates, setCycleSelectedDates] = useState(new Set())
  const lastCycleDateClick = useRef(null)
  const [cycleRunning, setCycleRunning] = useState(false)
  const [cycleProgress, setCycleProgress] = useState(null)
  const [cycleHistory, setCycleHistory] = useState(() => btCycleHistLoad())
  const [expandedCycleId, setExpandedCycleId] = useState(null)
  const [expandedCycleDayDate, setExpandedCycleDayDate] = useState(null)
  const [selectedCycleIds, setSelectedCycleIds] = useState(new Set())
  const [exportingCycleSheets, setExportingCycleSheets] = useState(false)

  // Load available dates on mount
  useEffect(() => {
    setDatesLoading(true)
    fetch(`${API}/api/backtest/dates`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then(d => {
        const list = d.dates || []
        setDates(list)
        if (list.length > 0) setSelectedDate(list[0])
        else setError('FSU has no available dates — check service is running')
      })
      .catch(e => setError(`Could not connect to FSU (${e.message})`))
      .finally(() => setDatesLoading(false))
  }, [])

  // Load markets when date or countries change
  const countriesKey = countries.join(',')
  useEffect(() => {
    if (!selectedDate || countries.length === 0) return
    setMarketsLoading(true)
    setMarkets([])
    setSelectedMarketIds(new Set())
    setResult(null)
    fetch(`${API}/api/backtest/markets?date=${selectedDate}&countries=${countriesKey}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then(d => {
        const list = d.markets || []
        setMarkets(list)
        setSelectedMarketIds(new Set(list.map(m => m.market_id)))
      })
      .catch(e => setError(`Could not load markets: ${e.message}`))
      .finally(() => setMarketsLoading(false))
  }, [selectedDate, countriesKey])

  function toggleCountry(c) {
    setCountries(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  }

  function toggleMarket(id) {
    setSelectedMarketIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function selectAll() { setSelectedMarketIds(new Set(markets.map(m => m.market_id))) }
  function deselectAll() { setSelectedMarketIds(new Set()) }

  async function runBacktest() {
    if (!selectedDate || selectedMarketIds.size === 0) return
    setRunning(true)
    setResult(null)
    setError('')
    try {
      // POST kicks off the job and returns immediately with a job_id
      const r = await fetch(`${API}/api/backtest/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: selectedDate,
          countries,
          process_window_mins: processWindow,
          jofs_enabled: jofsEnabled,
          spread_control: spreadControl,
          mark_ceiling_enabled: markCeiling,
          mark_floor_enabled: markFloor,
          mark_uplift_enabled: markUplift,
          mark_uplift_stake: markUpliftStake,
          point_value: pointValue,
          market_ids: [...selectedMarketIds],
          ai_agent_enabled: aiAgentEnabled,
          odds_agent_enabled: oddsAgentEnabled,
          odds_agent_interval_mins: oddsAgentInterval,
          odds_agent_lookback_mins: oddsAgentLookback,
          kelly_enabled: kellyEnabled,
          kelly_fraction: kellyFraction,
          kelly_bankroll: kellyBankroll,
          kelly_edge_pct: kellyEdgePct,
          kelly_min_stake: kellyMinStake,
          kelly_max_stake: kellyMaxStake,
          signal_overround_enabled: sigOverround,
          signal_field_size_enabled: sigFieldSize,
          signal_steam_gate_enabled: sigSteamGate,
          signal_band_perf_enabled: sigBandPerf,
          market_overlay_enabled: sigMarketOverlay,
          top2_concentration_enabled: top2Enabled,
        }),
      })
      if (!r.ok) throw new Error(`${r.status}`)
      const { job_id } = await r.json()

      // Poll until done
      let data = null
      while (true) {
        await new Promise(res => setTimeout(res, 3000))
        const poll = await fetch(`${API}/api/backtest/job/${job_id}`)
        if (!poll.ok) throw new Error(`Poll failed: ${poll.status}`)
        const pollData = await poll.json()
        if (pollData.status === 'done') { data = pollData.result; break }
        if (pollData.status === 'error') throw new Error(pollData.error || 'Backtest failed')
      }

      // Recompute summary from results to guarantee card/export consistency
      const recomputed = computeSummaryFromResults(data.results, {
        markets_evaluated: data.markets_evaluated,
        markets_placed: data.markets_placed || 0,
        bets_placed: data.bets_placed,
        markets_skipped: data.markets_skipped,
        total_stake: data.total_stake,
        total_liability: data.total_liability,
        total_pnl: data.total_pnl,
        roi: data.roi,
      })
      // Patch live result with recomputed values
      const patched = { ...data, ...recomputed }
      setResult(patched)
      // Persist to history
      const entry = {
        id: Date.now().toString(),
        run_at: new Date().toISOString(),
        date: selectedDate,
        config: {
          countries,
          process_window_mins: processWindow,
          jofs_enabled: jofsEnabled,
          spread_control: spreadControl,
          mark_ceiling_enabled: markCeiling,
          mark_floor_enabled: markFloor,
          mark_uplift_enabled: markUplift,
          mark_uplift_stake: markUpliftStake,
          point_value: pointValue,
          market_count: selectedMarketIds.size,
          ai_agent_enabled: aiAgentEnabled,
          odds_agent_enabled: oddsAgentEnabled,
          odds_agent_interval_mins: oddsAgentInterval,
          odds_agent_lookback_mins: oddsAgentLookback,
          kelly_enabled: kellyEnabled,
          kelly_fraction: kellyFraction,
          kelly_bankroll: kellyBankroll,
          kelly_edge_pct: kellyEdgePct,
          kelly_min_stake: kellyMinStake,
          kelly_max_stake: kellyMaxStake,
          signal_overround_enabled: sigOverround,
          signal_field_size_enabled: sigFieldSize,
          signal_steam_gate_enabled: sigSteamGate,
          signal_band_perf_enabled: sigBandPerf,
          market_overlay_enabled: sigMarketOverlay,
          top2_concentration_enabled: top2Enabled,
        },
        summary: recomputed,
        results: data.results,
      }
      const next = [entry, ...btHistLoad()]
      btHistSave(next)
      setHistory(next)
    } catch (e) {
      setError('Backtest failed: ' + e.message)
    } finally {
      setRunning(false)
    }
  }

  function toggleHistSelect(id) {
    setSelectedHistIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function selectAllHist() { setSelectedHistIds(new Set(history.map(h => h.id))) }
  function deselectAllHist() { setSelectedHistIds(new Set()) }

  function deleteSelected() {
    if (selectedHistIds.size === 0) return
    if (!window.confirm(`Delete ${selectedHistIds.size} backtest run${selectedHistIds.size !== 1 ? 's' : ''}?`)) return
    const next = history.filter(h => !selectedHistIds.has(h.id))
    btHistSave(next)
    setHistory(next)
    setSelectedHistIds(new Set())
    setExpandedHistId(null)
  }

  function exportSelectedLocal() {
    if (selectedHistIds.size === 0) return
    const entries = history.filter(h => selectedHistIds.has(h.id))

    let html = ''
    for (const entry of entries) {
      html += buildBacktestExportHtml(
        entry.summary,
        entry.results,
        { date: entry.date, countries: (entry.config || {}).countries, process_window_mins: (entry.config || {}).process_window_mins }
      )
      html += '<br/>'
    }

    const dateLabel = entries.length === 1 ? entries[0].date : `${entries.length}_runs`
    downloadTableAsExcelRaw(html, `chimera_backtest_${dateLabel}`)
  }

  async function exportSelectedToSheets() {
    if (selectedHistIds.size === 0) return
    setExportingSheets(true)
    try {
      const entries = history.filter(h => selectedHistIds.has(h.id))
      const r = await fetch(`${API}/api/backtest/export-sheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      })
      if (!r.ok) throw new Error(`${r.status}`)
      const data = await r.json()
      if (data.url) window.open(data.url, '_blank')
      else setError(data.error || 'Export failed')
    } catch (e) {
      setError('Google Sheets export failed: ' + e.message)
    } finally {
      setExportingSheets(false)
    }
  }

  // ── Cycle Run ──
  function toggleCycleDate(d, e) {
    if (e.shiftKey && lastCycleDateClick.current && lastCycleDateClick.current !== d) {
      const idxA = dates.indexOf(lastCycleDateClick.current)
      const idxB = dates.indexOf(d)
      const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA]
      const range = dates.slice(lo, hi + 1)
      setCycleSelectedDates(prev => {
        const next = new Set(prev)
        range.forEach(x => next.add(x))
        return next
      })
    } else {
      setCycleSelectedDates(prev => {
        const next = new Set(prev)
        next.has(d) ? next.delete(d) : next.add(d)
        return next
      })
    }
    lastCycleDateClick.current = d
  }
  function selectAllCycleDates() { setCycleSelectedDates(new Set(dates)) }
  function deselectAllCycleDates() { setCycleSelectedDates(new Set()) }

  async function runCycle() {
    if (cycleSelectedDates.size === 0) return
    const sortedDates = [...cycleSelectedDates].sort()
    setCycleRunning(true)
    setCycleProgress({ current: 0, total: sortedDates.length, currentDate: '' })
    const days = []
    for (let i = 0; i < sortedDates.length; i++) {
      const date = sortedDates[i]
      setCycleProgress({ current: i + 1, total: sortedDates.length, currentDate: date })
      try {
        const r = await fetch(`${API}/api/backtest/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date,
            countries,
            process_window_mins: processWindow,
            jofs_enabled: jofsEnabled,
            spread_control: spreadControl,
            mark_ceiling_enabled: markCeiling,
            mark_floor_enabled: markFloor,
            mark_uplift_enabled: markUplift,
            mark_uplift_stake: markUpliftStake,
            point_value: pointValue,
            market_ids: [],
            kelly_enabled: kellyEnabled,
            kelly_fraction: kellyFraction,
            kelly_bankroll: kellyBankroll,
            kelly_edge_pct: kellyEdgePct,
            kelly_min_stake: kellyMinStake,
            kelly_max_stake: kellyMaxStake,
            signal_overround_enabled: sigOverround,
            signal_field_size_enabled: sigFieldSize,
            signal_steam_gate_enabled: sigSteamGate,
            signal_band_perf_enabled: sigBandPerf,
            market_overlay_enabled: sigMarketOverlay,
            top2_concentration_enabled: top2Enabled,
          }),
        })
        if (!r.ok) throw new Error(`${r.status}`)
        const { job_id } = await r.json()
        // Poll until this day's job finishes before moving to next date
        let data = null
        while (true) {
          await new Promise(res => setTimeout(res, 3000))
          const poll = await fetch(`${API}/api/backtest/job/${job_id}`)
          if (!poll.ok) throw new Error(`Poll failed: ${poll.status}`)
          const pollData = await poll.json()
          if (pollData.status === 'done') { data = pollData.result; break }
          if (pollData.status === 'error') throw new Error(pollData.error || 'Backtest failed')
        }
        days.push({ date, ...data })
      } catch (e) {
        days.push({ date, error: e.message, markets_evaluated: 0, bets_placed: 0, markets_skipped: 0, total_stake: 0, total_liability: 0, total_pnl: 0, roi: 0, results: [] })
      }
    }
    const totStake = days.reduce((s, d) => s + (d.total_stake || 0), 0)
    const totPnl = days.reduce((s, d) => s + (d.total_pnl || 0), 0)
    const summary = {
      total_days: sortedDates.length,
      days_completed: days.filter(d => !d.error).length,
      markets_evaluated: days.reduce((s, d) => s + (d.markets_evaluated || 0), 0),
      markets_placed: days.reduce((s, d) => s + (d.markets_placed || 0), 0),
      bets_placed: days.reduce((s, d) => s + (d.bets_placed || 0), 0),
      markets_skipped: days.reduce((s, d) => s + (d.markets_skipped || 0), 0),
      total_stake: totStake,
      total_liability: days.reduce((s, d) => s + (d.total_liability || 0), 0),
      total_pnl: totPnl,
      roi: totStake > 0 ? Math.round((totPnl / totStake) * 1000) / 10 : 0,
    }
    const entry = {
      id: Date.now().toString(),
      run_at: new Date().toISOString(),
      dates: sortedDates,
      config: {
        countries,
        process_window_mins: processWindow,
        jofs_enabled: jofsEnabled,
        spread_control: spreadControl,
        mark_ceiling_enabled: markCeiling,
        mark_floor_enabled: markFloor,
        mark_uplift_enabled: markUplift,
        mark_uplift_stake: markUpliftStake,
        point_value: pointValue,
        signal_overround_enabled: sigOverround,
        signal_field_size_enabled: sigFieldSize,
        signal_steam_gate_enabled: sigSteamGate,
        signal_band_perf_enabled: sigBandPerf,
        market_overlay_enabled: sigMarketOverlay,
        top2_concentration_enabled: top2Enabled,
      },
      summary,
      days,
    }
    const next = [entry, ...btCycleHistLoad()]
    btCycleHistSave(next)
    setCycleHistory(next)
    setCycleRunning(false)
    setCycleProgress(null)
  }

  function toggleCycleSelect(id) {
    setSelectedCycleIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function deleteSelectedCycle() {
    if (selectedCycleIds.size === 0) return
    if (!window.confirm(`Delete ${selectedCycleIds.size} cycle run${selectedCycleIds.size !== 1 ? 's' : ''}?`)) return
    const next = cycleHistory.filter(h => !selectedCycleIds.has(h.id))
    btCycleHistSave(next)
    setCycleHistory(next)
    setSelectedCycleIds(new Set())
    setExpandedCycleId(null)
  }

  function exportCycleLocal(entries) {
    let html = ''
    for (const entry of entries) {
      const cfg = entry.config || {}
      const sm = entry.summary || {}
      html += `<h3>Cycle Run: ${(entry.dates || []).join(', ')} — ${(cfg.countries || []).join(',')} — Window: ${cfg.process_window_mins || '?'}min</h3>`
      html += `<p>Days: ${sm.total_days || 0} | Markets: ${sm.markets_evaluated || 0} | Bets: ${sm.bets_placed || 0} | P&amp;L: £${(sm.total_pnl || 0).toFixed(2)} | ROI: ${sm.roi || 0}%</p>`
      for (const day of (entry.days || [])) {
        html += `<h4>${day.date}${day.error ? ' — ERROR: ' + day.error : ` — Bets: ${day.bets_placed} | P&L: £${(day.total_pnl || 0).toFixed(2)}`}</h4>`
        if (!day.error) {
          html += '<table border="1" cellpadding="4" cellspacing="0"><tr><th>Time</th><th>Venue</th><th>Favourite</th><th>Odds</th><th>Rule</th><th>Stake</th><th>Liability</th><th>Result</th><th>P&amp;L</th></tr>'
          for (const r of (day.results || [])) {
            const instrs = r.instructions || []
            const totalStake = instrs.reduce((s, i) => s + (i.size || 0), 0)
            const totalLiab = instrs.reduce((s, i) => s + (i.liability || 0), 0)
            const outcomes = [...new Set(instrs.map(i => i.outcome).filter(Boolean))]
            const fav = r.favourite || {}
            html += '<tr>'
            html += `<td>${(r.race_time || '').slice(0, 16)}</td>`
            html += `<td>${r.venue || ''}</td>`
            html += `<td>${fav.name || ''}</td>`
            html += `<td>${fav.odds || ''}</td>`
            html += `<td>${r.skipped ? (r.skip_reason || 'SKIPPED') : (r.rule_applied || '')}</td>`
            html += `<td>${r.skipped ? '' : '£' + totalStake.toFixed(2)}</td>`
            html += `<td>${r.skipped ? '' : '£' + totalLiab.toFixed(2)}</td>`
            html += `<td>${r.skipped ? 'SKIPPED' : (outcomes.join('/') || '—')}</td>`
            html += `<td>${r.skipped ? '' : '£' + (r.pnl || 0).toFixed(2)}</td>`
            html += '</tr>'
          }
          html += '</table><br/>'
        }
      }
    }
    const label = entries.length === 1
      ? `${entries[0].dates[0]}_to_${entries[0].dates[entries[0].dates.length - 1]}`
      : `${entries.length}_cycles`
    downloadTableAsExcelRaw(html, `chimera_cycle_${label}`)
  }

  async function exportCycleToSheets(entries) {
    setExportingCycleSheets(true)
    try {
      // Convert cycle days into the same entry format as single backtests
      const flatEntries = entries.flatMap(cycle =>
        (cycle.days || []).filter(d => !d.error).map(day => ({
          id: `${cycle.id}-${day.date}`,
          run_at: cycle.run_at,
          date: day.date,
          config: cycle.config,
          summary: {
            markets_evaluated: day.markets_evaluated,
            bets_placed: day.bets_placed,
            markets_skipped: day.markets_skipped,
            total_stake: day.total_stake,
            total_liability: day.total_liability,
            total_pnl: day.total_pnl,
            roi: day.roi,
          },
          results: day.results,
        }))
      )
      const r = await fetch(`${API}/api/backtest/export-sheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: flatEntries }),
      })
      if (!r.ok) throw new Error(`${r.status}`)
      const data = await r.json()
      if (data.url) window.open(data.url, '_blank')
      else setError(data.error || 'Export failed')
    } catch (e) {
      setError('Google Sheets export failed: ' + e.message)
    } finally {
      setExportingCycleSheets(false)
    }
  }

  // Group markets by venue for the browser
  const marketsByVenue = markets.reduce((acc, m) => {
    const v = m.venue || 'Unknown'
    if (!acc[v]) acc[v] = []
    acc[v].push(m)
    return acc
  }, {})

  return (
    <div className="backtest-tab bt-wide">
      <h2>Backtest</h2>

      {/* Config panel */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="engine-section">
          <div className="bt-config-row">
            <div>
              <div className="engine-label">Date</div>
              <select
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="bt-select"
                disabled={datesLoading}
              >
                {datesLoading && <option>Loading…</option>}
                {!datesLoading && dates.length === 0 && <option>No dates available</option>}
                {dates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>

            <div>
              <div className="engine-label">Countries</div>
              <div className="bt-checkboxes">
                {['GB', 'IE'].map(c => (
                  <label key={c} className="bt-checkbox-label">
                    <input type="checkbox" checked={countries.includes(c)} onChange={() => toggleCountry(c)} />
                    {c}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="engine-label">Process Window</div>
              <select
                value={processWindow}
                onChange={e => setProcessWindow(Number(e.target.value))}
                className="bt-select"
              >
                {[
                  { v: 0.5, label: '30 sec' },
                  { v: 1, label: '1 min' },
                  { v: 2, label: '2 min' },
                  { v: 3, label: '3 min' },
                  { v: 4, label: '4 min' },
                  { v: 5, label: '5 min' },
                  { v: 10, label: '10 min' },
                  { v: 20, label: '20 min' },
                  { v: 30, label: '30 min' },
                  { v: 60, label: '1 hour' },
                ].map(({ v, label }) => (
                  <option key={v} value={v}>{label} before</option>
                ))}
              </select>
            </div>

            <button
              className="btn btn-primary btn-sm"
              onClick={runBacktest}
              disabled={running || selectedMarketIds.size === 0}
            >
              {running ? 'Running…' : `Run Backtest${selectedMarketIds.size > 0 ? ` (${selectedMarketIds.size})` : ''}`}
            </button>
          </div>

          <div className="bt-toggles">
            {[
              ['jofs', jofsEnabled, setJofsEnabled, 'JOFS (Joint/Close Fav)'],
              ['spread', spreadControl, setSpreadControl, 'Spread Control'],
              ['ceil', markCeiling, setMarkCeiling, 'Mark Ceiling (≤8.0)'],
              ['floor', markFloor, setMarkFloor, 'Mark Floor (≥1.5)'],
              ['uplift', markUplift, setMarkUplift, 'Mark Uplift (2.5–3.5)'],
              ['sig-overround', sigOverround, setSigOverround, 'Signal: Overround'],
              ['sig-field', sigFieldSize, setSigFieldSize, 'Signal: Field Size'],
              ['sig-steam', sigSteamGate, setSigSteamGate, 'Signal: Steam Gate'],
              ['sig-band', sigBandPerf, setSigBandPerf, 'Signal: Band Perf'],
              ['market-overlay', sigMarketOverlay, setSigMarketOverlay, 'Market Overlay Modifier'],
              ['top2-concentration', top2Enabled, setTop2Enabled, 'TOP2 Concentration'],
            ].map(([key, val, setter, label]) => (
              <label key={key} className="bt-toggle-label">
                <input type="checkbox" checked={val} onChange={e => setter(e.target.checked)} />
                {label}
                {key === 'uplift' && val && (
                  <select
                    className="select-small"
                    value={markUpliftStake}
                    onChange={e => { e.stopPropagation(); setMarkUpliftStake(Number(e.target.value)) }}
                    style={{ marginLeft: 6, width: 65 }}
                    onClick={e => e.stopPropagation()}
                  >
                    {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => (
                      <option key={v} value={v}>{v} pts</option>
                    ))}
                  </select>
                )}
              </label>
            ))}
            <label className="bt-toggle-label">
              Point Value:
              <select
                className="select-small"
                value={pointValue}
                onChange={e => setPointValue(Number(e.target.value))}
                style={{ marginLeft: 6, width: 80 }}
              >
                {[1, 2, 5, 10, 20, 50].map(v => (
                  <option key={v} value={v}>£{v}/pt</option>
                ))}
              </select>
            </label>
          </div>

          {/* AI Research Agent toggle */}
          <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(124,58,237,0.08)', borderRadius: 6, border: '1px solid rgba(124,58,237,0.25)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label className="bt-toggle-label" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={aiAgentEnabled}
                onChange={e => setAiAgentEnabled(e.target.checked)}
              />
              <span style={{ color: '#7c3aed', fontWeight: 600 }}>AI Research Agent</span>
            </label>
            <span style={{ fontSize: 11, color: '#8a8a9a', lineHeight: 1.4 }}>
              Searches the web for runner intelligence (pre-race-date only) and may overrule or adjust bets.
              <strong style={{ color: '#d97706' }}> Slower — allow extra time per race.</strong>
            </span>
          </div>

          {/* AI Odds Movement Agent toggle */}
          <div style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(6,182,212,0.07)', borderRadius: 6, border: '1px solid rgba(6,182,212,0.25)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label className="bt-toggle-label" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={oddsAgentEnabled}
                onChange={e => setOddsAgentEnabled(e.target.checked)}
              />
              <span style={{ color: '#0891b2', fontWeight: 600 }}>AI Odds Movement Agent</span>
            </label>
            {oddsAgentEnabled && (
              <>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Sample every
                  <select
                    className="select-small"
                    value={oddsAgentInterval}
                    onChange={e => setOddsAgentInterval(Number(e.target.value))}
                    style={{ marginLeft: 4, width: 68 }}
                  >
                    {[1, 2, 5, 10].map(v => <option key={v} value={v}>{v} min</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Look back
                  <select
                    className="select-small"
                    value={oddsAgentLookback}
                    onChange={e => setOddsAgentLookback(Number(e.target.value))}
                    style={{ marginLeft: 4, width: 72 }}
                  >
                    {[15, 30, 60, 120].map(v => <option key={v} value={v}>{v} min</option>)}
                  </select>
                </label>
              </>
            )}
            <span style={{ fontSize: 11, color: '#8a8a9a', lineHeight: 1.4 }}>
              Samples historical odds at intervals and analyses drift/steam before influencing the bet. No internet required.
            </span>
          </div>

          {/* Kelly Criterion toggle */}
          <div style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(22,163,74,0.07)', borderRadius: 6, border: '1px solid rgba(22,163,74,0.25)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label className="bt-toggle-label" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={kellyEnabled}
                onChange={e => setKellyEnabled(e.target.checked)}
              />
              <span style={{ color: '#16a34a', fontWeight: 600 }}>Kelly Criterion</span>
            </label>
            {kellyEnabled && (
              <>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Fraction
                  <select
                    className="select-small"
                    value={kellyFraction}
                    onChange={e => setKellyFraction(parseFloat(e.target.value))}
                    style={{ marginLeft: 4, width: 130 }}
                  >
                    <option value={0.25}>¼ Kelly (recommended)</option>
                    <option value={0.5}>½ Kelly</option>
                    <option value={1.0}>Full Kelly</option>
                  </select>
                </label>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Bankroll £
                  <input
                    type="number"
                    className="select-small"
                    style={{ marginLeft: 4, width: 80 }}
                    value={kellyBankroll}
                    min={10} max={1000000} step={100}
                    onChange={e => setKellyBankroll(parseFloat(e.target.value))}
                  />
                </label>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Edge %
                  <input
                    type="number"
                    className="select-small"
                    style={{ marginLeft: 4, width: 60 }}
                    value={kellyEdgePct}
                    min={0} max={50} step={0.5}
                    onChange={e => setKellyEdgePct(parseFloat(e.target.value))}
                  />
                </label>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Min £
                  <input
                    type="number"
                    className="select-small"
                    style={{ marginLeft: 4, width: 60 }}
                    value={kellyMinStake}
                    min={0.1} max={100} step={0.1}
                    onChange={e => setKellyMinStake(parseFloat(e.target.value))}
                  />
                </label>
                <label style={{ fontSize: 11, color: '#8a8a9a', display: 'flex', alignItems: 'center', gap: 4 }}>
                  Max £
                  <input
                    type="number"
                    className="select-small"
                    style={{ marginLeft: 4, width: 70 }}
                    value={kellyMaxStake}
                    min={1} max={10000} step={1}
                    onChange={e => setKellyMaxStake(parseFloat(e.target.value))}
                  />
                </label>
              </>
            )}
            <span style={{ fontSize: 11, color: '#8a8a9a', lineHeight: 1.4 }}>
              Replaces fixed rule stakes with bankroll-proportional Kelly sizing. Quarter Kelly recommended.
            </span>
          </div>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {/* Market browser */}
      {selectedDate && !datesLoading && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="engine-section">
            <div className="bt-browser-header">
              <span className="engine-label" style={{ fontWeight: 600 }}>
                Markets — {selectedDate}
                {marketsLoading ? ' (loading…)' : ` · ${markets.length} found`}
              </span>
              {!marketsLoading && markets.length > 0 && (
                <div className="bt-browser-actions">
                  <span className="bt-muted">{selectedMarketIds.size}/{markets.length} selected</span>
                  <button className="btn btn-secondary btn-sm" onClick={selectAll}>All</button>
                  <button className="btn btn-secondary btn-sm" onClick={deselectAll}>None</button>
                </div>
              )}
            </div>

            {marketsLoading && <div className="bt-muted" style={{ fontSize: 12 }}>Loading markets…</div>}
            {!marketsLoading && markets.length === 0 && (
              <div className="bt-muted" style={{ fontSize: 12 }}>No markets found for this date and country selection.</div>
            )}

            {!marketsLoading && Object.entries(marketsByVenue).sort(([a], [b]) => a.localeCompare(b)).map(([venue, vMarkets]) => (
              <div key={venue} className="bt-venue-group">
                <div className="bt-venue-header">{venue}</div>
                <div className="bt-market-list">
                  {[...vMarkets].sort((a, b) => a.race_time.localeCompare(b.race_time)).map(m => (
                    <label key={m.market_id} className="bt-market-row">
                      <input
                        type="checkbox"
                        checked={selectedMarketIds.has(m.market_id)}
                        onChange={() => toggleMarket(m.market_id)}
                      />
                      <span className="bt-market-time">{m.race_time.slice(11, 16)}</span>
                      <span className="bt-market-name">{m.market_name}</span>
                      <span className="bt-muted" style={{ fontSize: 10 }}>{m.runners?.length ?? 0} runners</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {running && <div className="empty-state">Running backtest for {selectedDate}…</div>}

      {result && (
        <>
          <div className="stats-ribbon" style={{ marginBottom: 12 }}>
            <div className="stats-ribbon-left">
              <span className="stat">Markets <strong>{result.markets_evaluated}</strong></span>
              <span className="stat">Placed <strong>{result.markets_placed ?? result.bets_placed}</strong></span>
              <span className="stat">Bets <strong>{result.bets_placed}</strong></span>
              <span className="stat">Skipped <strong>{result.markets_skipped}</strong></span>
              <span className="stat">Stake <strong>£{result.total_stake.toFixed(2)}</strong></span>
              <span className="stat">Liability <strong>£{result.total_liability.toFixed(2)}</strong></span>
              <span className={`stat ${result.total_pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                P&amp;L <strong>{result.total_pnl >= 0 ? '+' : ''}£{result.total_pnl.toFixed(2)}</strong>
              </span>
              <span className={`stat ${result.roi >= 0 ? 'text-success' : 'text-danger'}`}>
                ROI <strong>{result.roi >= 0 ? '+' : ''}{result.roi}%</strong>
              </span>
              {result.ai_agent_enabled && (
                <>
                  <span className="stat" style={{ color: '#7c3aed' }}>
                    Web Overrules <strong>{result.ai_agent_overrules ?? 0}</strong>
                  </span>
                  <span className="stat" style={{ color: '#7c3aed' }}>
                    Web Adj <strong>{result.ai_agent_adjustments ?? 0}</strong>
                  </span>
                </>
              )}
              {result.odds_agent_enabled && (
                <>
                  <span className="stat" style={{ color: '#0891b2' }}>
                    Odds Overrules <strong>{result.odds_agent_overrules ?? 0}</strong>
                  </span>
                  <span className="stat" style={{ color: '#0891b2' }}>
                    Odds Adj <strong>{result.odds_agent_adjustments ?? 0}</strong>
                  </span>
                </>
              )}
              {result.top2_concentration_enabled && (
                <>
                  <span className="stat" style={{ color: '#dc2626' }}>
                    TOP2 Blocked <strong>{result.top2_blocks ?? 0}</strong>
                  </span>
                  <span className="stat" style={{ color: '#d97706' }}>
                    TOP2 Suppressed <strong>{result.top2_suppressions ?? 0}</strong>
                  </span>
                </>
              )}
            </div>
            <SnapshotButton
              tableId="bt-results-table"
              filename={`backtest_${selectedDate}`}
              summary={result}
              results={result.results}
              config={{ date: selectedDate, countries, process_window_mins: processWindow }}
            />
          </div>

          <div className="card">
            <div className="table-scroll">
              <table id="bt-results-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Venue</th>
                    <th>Favourite</th>
                    <th>Rule</th>
                    <th>Stake</th>
                    <th>Liability</th>
                    <th>Result</th>
                    <th>P&amp;L</th>
                    {result.ai_agent_enabled && <th style={{ color: '#7c3aed' }}>Web</th>}
                    {result.odds_agent_enabled && <th style={{ color: '#0891b2' }}>Odds</th>}
                    {result.top2_concentration_enabled && <th style={{ color: '#059669' }}>TOP2</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.results.map(r => {
                    const time = r.race_time ? r.race_time.slice(11, 16) : '—'
                    const skipped = r.skipped
                    const instructions = r.instructions || []
                    const totalStake = instructions.reduce((s, i) => s + (i.size || 0), 0)
                    const totalLiab = instructions.reduce((s, i) => s + (i.liability || 0), 0)
                    const pnl = r.pnl || 0
                    const outcomes = [...new Set(instructions.map(i => i.outcome).filter(Boolean))]
                    const outcomeStr = skipped ? 'SKIPPED' : (outcomes.join('/') || '—')
                    const outcomeClass = outcomeStr === 'WON' ? 'text-success'
                      : outcomeStr === 'LOST' ? 'text-danger'
                      : outcomeStr === 'SKIPPED' ? 'bt-muted' : ''

                    // Collect internet agent decisions for this row
                    const agentDecisions = instructions.map(i => i.agent_decision).filter(Boolean)
                    const agentOverruled = agentDecisions.some(d => d.action === 'OVERRULE')
                    const agentAdjusted = agentDecisions.some(d => d.action === 'ADJUST')
                    const agentAction = agentOverruled ? 'OVERRULE' : agentAdjusted ? 'ADJUST' : agentDecisions.length > 0 ? 'CONFIRM' : null
                    const agentTooltip = agentDecisions.map(d =>
                      `${d.action} (${Math.round((d.confidence || 0) * 100)}% conf)\n${d.reasoning}`
                    ).join('\n\n')

                    // Collect odds movement agent decisions for this row
                    const oddsDecisions = instructions.map(i => i.odds_decision).filter(Boolean)
                    const oddsOverruled = oddsDecisions.some(d => d.action === 'OVERRULE')
                    const oddsAdjusted = oddsDecisions.some(d => d.action === 'ADJUST')
                    const oddsAction = oddsOverruled ? 'OVERRULE' : oddsAdjusted ? 'ADJUST' : oddsDecisions.length > 0 ? 'CONFIRM' : null
                    const oddsTooltip = oddsDecisions.map(d => {
                      const trend = d.trend ? ` [${d.trend}]` : ''
                      const delta = d.price_delta != null ? ` Δ${d.price_delta > 0 ? '+' : ''}${d.price_delta.toFixed(2)}` : ''
                      const prices = (d.price_open && d.price_close) ? ` ${d.price_open}→${d.price_close}` : ''
                      return `${d.action} (${Math.round((d.confidence || 0) * 100)}% conf)${trend}${prices}${delta}\n${d.reasoning}`
                    }).join('\n\n')

                    // TOP2_CONCENTRATION state for this row
                    const top2 = r.top2_concentration
                    const top2State = top2?.state
                    const top2Tooltip = top2
                      ? `${top2.state}  ×${top2.lay_multiplier}\ntop2=${top2.top2_combined?.toFixed(4)}  3v2=${top2.third_vs_second_ratio?.toFixed(4)}  2v1=${top2.second_vs_first_ratio?.toFixed(4)}\n${top2.reason}`
                      : ''

                    return (
                      <tr key={r.market_id} className={skipped ? 'bt-row-skipped' : ''}>
                        <td>{time}</td>
                        <td>{r.venue}</td>
                        <td>
                          {r.favourite
                            ? <span>{r.favourite.name} <span className="bt-muted">@ {r.favourite.odds}</span></span>
                            : '—'}
                        </td>
                        <td className="bt-rule-cell" title={r.rule_applied || r.skip_reason || ''}>
                          {skipped ? <span className="bt-muted">{r.skip_reason}</span> : r.rule_applied}
                        </td>
                        <td>{skipped ? '—' : `£${totalStake.toFixed(2)}`}</td>
                        <td>{skipped ? '—' : `£${totalLiab.toFixed(2)}`}</td>
                        <td className={outcomeClass}>{outcomeStr}</td>
                        <td className={pnl > 0 ? 'text-success' : pnl < 0 ? 'text-danger' : ''}>
                          {skipped ? '—' : `${pnl >= 0 ? '+' : ''}£${pnl.toFixed(2)}`}
                        </td>
                        {result.ai_agent_enabled && (
                          <td title={agentTooltip || ''} style={{ cursor: agentTooltip ? 'help' : 'default', whiteSpace: 'nowrap' }}>
                            {agentAction === 'OVERRULE' && <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 11 }}>✗ OVRL</span>}
                            {agentAction === 'ADJUST' && <span style={{ color: '#d97706', fontWeight: 600, fontSize: 11 }}>~ ADJ</span>}
                            {agentAction === 'CONFIRM' && <span style={{ color: '#16a34a', fontWeight: 600, fontSize: 11 }}>✓ OK</span>}
                            {!agentAction && <span className="bt-muted" style={{ fontSize: 11 }}>—</span>}
                          </td>
                        )}
                        {result.odds_agent_enabled && (
                          <td title={oddsTooltip || ''} style={{ cursor: oddsTooltip ? 'help' : 'default', whiteSpace: 'nowrap' }}>
                            {oddsAction === 'OVERRULE' && <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 11 }}>✗ OVRL</span>}
                            {oddsAction === 'ADJUST' && <span style={{ color: '#d97706', fontWeight: 600, fontSize: 11 }}>~ ADJ</span>}
                            {oddsAction === 'CONFIRM' && (
                              <span style={{ color: '#0891b2', fontWeight: 600, fontSize: 11 }}>
                                ✓ {oddsDecisions[0]?.trend === 'SHORTENING' ? '↘' : oddsDecisions[0]?.trend === 'DRIFTING' ? '↗' : '→'}
                              </span>
                            )}
                            {!oddsAction && <span className="bt-muted" style={{ fontSize: 11 }}>—</span>}
                          </td>
                        )}
                        {result.top2_concentration_enabled && (
                          <td title={top2Tooltip} style={{ cursor: top2Tooltip ? 'help' : 'default', whiteSpace: 'nowrap' }}>
                            {top2State === 'BLOCK' && <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 11 }}>✗ BLK</span>}
                            {top2State === 'SUPPRESS_STRONG' && <span style={{ color: '#ea580c', fontWeight: 600, fontSize: 11 }}>↓↓ ×.25</span>}
                            {top2State === 'SUPPRESS_MEDIUM' && <span style={{ color: '#d97706', fontWeight: 600, fontSize: 11 }}>↓ ×.60</span>}
                            {top2State === 'WATCH' && <span style={{ color: '#ca8a04', fontWeight: 600, fontSize: 11 }}>◉ WATCH</span>}
                            {(top2State === 'NONE' || !top2State) && <span className="bt-muted" style={{ fontSize: 11 }}>—</span>}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Backtest History ── */}
      {history.length > 0 && (
        <div className="bt-hist-section">
          <div className="bt-hist-section-header">
            <h3>History</h3>
            <span className="bt-muted">{history.length} run{history.length !== 1 ? 's' : ''} stored</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {selectedHistIds.size > 0 && (
                <span className="bt-muted" style={{ fontSize: 11 }}>{selectedHistIds.size} selected</span>
              )}
              <button className="btn btn-secondary btn-sm" onClick={selectedHistIds.size === history.length ? deselectAllHist : selectAllHist}>
                {selectedHistIds.size === history.length ? 'Deselect All' : 'Select All'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={selectedHistIds.size === 0}
                onClick={exportSelectedLocal}
              >
                Download XLS{selectedHistIds.size > 0 ? ` (${selectedHistIds.size})` : ''}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={selectedHistIds.size === 0 || exportingSheets}
                onClick={exportSelectedToSheets}
              >
                {exportingSheets ? 'Exporting…' : `Google Sheets${selectedHistIds.size > 0 ? ` (${selectedHistIds.size})` : ''}`}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                style={{ color: '#dc2626' }}
                disabled={selectedHistIds.size === 0}
                onClick={deleteSelected}
              >
                Delete{selectedHistIds.size > 0 ? ` (${selectedHistIds.size})` : ''}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                style={{ color: '#dc2626' }}
                onClick={() => { if (window.confirm('Clear all backtest history?')) { btHistSave([]); setHistory([]); setSelectedHistIds(new Set()) } }}
              >
                Clear All
              </button>
            </div>
          </div>

          {history.map(entry => {
            const isExpanded = expandedHistId === entry.id
            const pnl = entry.summary.total_pnl
            const tableId = `bt-hist-tbl-${entry.id}`
            return (
              <div key={entry.id} className={`bt-hist-card${isExpanded ? ' expanded' : ''}${selectedHistIds.has(entry.id) ? ' selected' : ''}`}>
                <div className="bt-hist-card-header" onClick={() => setExpandedHistId(isExpanded ? null : entry.id)}>
                  <input
                    type="checkbox"
                    checked={selectedHistIds.has(entry.id)}
                    onChange={e => { e.stopPropagation(); toggleHistSelect(entry.id) }}
                    onClick={e => e.stopPropagation()}
                    style={{ marginRight: 8 }}
                  />
                  <span className="bt-hist-date">{entry.date}</span>
                  <span className="bt-muted" style={{ fontSize: 10 }}>
                    {new Date(entry.run_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="bt-hist-stat">Bets <strong>{entry.summary.bets_placed}</strong></span>
                  <span className="bt-hist-stat">Stake <strong>£{entry.summary.total_stake.toFixed(2)}</strong></span>
                  <span className={`bt-hist-stat ${pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                    P&amp;L <strong>{pnl >= 0 ? '+' : ''}£{pnl.toFixed(2)}</strong>
                  </span>
                  <span className={`bt-hist-stat ${entry.summary.roi >= 0 ? 'text-success' : 'text-danger'}`}>
                    ROI <strong>{entry.summary.roi >= 0 ? '+' : ''}{entry.summary.roi}%</strong>
                  </span>
                  <span className="bt-hist-flags">
                    {entry.config.jofs_enabled && <span className="tag-on">JOFS</span>}
                    {entry.config.mark_ceiling_enabled && <span className="tag-on">Ceil</span>}
                    {entry.config.mark_floor_enabled && <span className="tag-on">Floor</span>}
                    {entry.config.mark_uplift_enabled && <span className="tag-on">Uplift {entry.config.mark_uplift_stake || 3} pts</span>}
                    {entry.config.market_overlay_enabled && <span className="tag-on">MOM</span>}
                    {entry.config.top2_concentration_enabled && <span className="tag-on">TOP2</span>}
                  </span>
                  <span className="collapsible-chevron">{isExpanded ? '−' : '+'}</span>
                </div>

                {isExpanded && (
                  <div className="bt-hist-card-body">
                    <div className="bt-hist-card-meta">
                      <span className="bt-muted">
                        {entry.config.countries.join('/')} · {fmtWindow(entry.config.process_window_mins)} window ·{' '}
                        {entry.summary.markets_evaluated} markets · {entry.summary.markets_placed ?? entry.summary.bets_placed} placed · {entry.summary.markets_skipped} skipped
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={e => {
                            e.stopPropagation()
                            const html = buildBacktestExportHtml(
                              entry.summary,
                              entry.results,
                              { date: entry.date, countries: entry.config.countries, process_window_mins: entry.config.process_window_mins }
                            )
                            downloadTableAsExcelRaw(html, `backtest_${entry.date}_${entry.id}`)
                          }}
                        >
                          Export XLS
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ color: '#dc2626' }}
                          onClick={e => {
                            e.stopPropagation()
                            const next = history.filter(h => h.id !== entry.id)
                            btHistSave(next)
                            setHistory(next)
                            setExpandedHistId(null)
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="table-scroll">
                      <table id={tableId}>
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Venue</th>
                            <th>Favourite</th>
                            <th>Rule</th>
                            <th>Stake</th>
                            <th>Liability</th>
                            <th>Result</th>
                            <th>P&amp;L</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(entry.results || []).map(r => {
                            const time = r.race_time ? r.race_time.slice(11, 16) : '—'
                            const skipped = r.skipped
                            const instructions = r.instructions || []
                            const totalStake = instructions.reduce((s, i) => s + (i.size || 0), 0)
                            const totalLiab = instructions.reduce((s, i) => s + (i.liability || 0), 0)
                            const rpnl = r.pnl || 0
                            const outcomes = [...new Set(instructions.map(i => i.outcome).filter(Boolean))]
                            const outcomeStr = skipped ? 'SKIPPED' : (outcomes.join('/') || '—')
                            const outcomeClass = outcomeStr === 'WON' ? 'text-success'
                              : outcomeStr === 'LOST' ? 'text-danger'
                              : outcomeStr === 'SKIPPED' ? 'bt-muted' : ''
                            return (
                              <tr key={r.market_id} className={skipped ? 'bt-row-skipped' : ''}>
                                <td>{time}</td>
                                <td>{r.venue}</td>
                                <td>
                                  {r.favourite
                                    ? <span>{r.favourite.name} <span className="bt-muted">@ {r.favourite.odds}</span></span>
                                    : '—'}
                                </td>
                                <td className="bt-rule-cell" title={r.rule_applied || r.skip_reason || ''}>
                                  {skipped ? <span className="bt-muted">{r.skip_reason}</span> : r.rule_applied}
                                </td>
                                <td>{skipped ? '—' : `£${totalStake.toFixed(2)}`}</td>
                                <td>{skipped ? '—' : `£${totalLiab.toFixed(2)}`}</td>
                                <td className={outcomeClass}>{outcomeStr}</td>
                                <td className={rpnl > 0 ? 'text-success' : rpnl < 0 ? 'text-danger' : ''}>
                                  {skipped ? '—' : `${rpnl >= 0 ? '+' : ''}£${rpnl.toFixed(2)}`}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Cycle Run ── */}
      <div className="bt-cycle-section">
        <div className="bt-hist-section-header" style={{ marginBottom: 12 }}>
          <h3>Cycle Run</h3>
          <span className="bt-muted">Select multiple dates to run in sequence</span>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="engine-section">
            <div className="bt-browser-header">
              <span className="engine-label" style={{ fontWeight: 600 }}>
                Dates
                {datesLoading ? ' (loading…)' : ` · ${dates.length} available`}
              </span>
              <div className="bt-browser-actions">
                <span className="bt-muted">{cycleSelectedDates.size} selected</span>
                <button className="btn btn-secondary btn-sm" onClick={selectAllCycleDates} disabled={datesLoading}>All</button>
                <button className="btn btn-secondary btn-sm" onClick={deselectAllCycleDates}>None</button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={runCycle}
                  disabled={cycleRunning || cycleSelectedDates.size === 0}
                >
                  {cycleRunning
                    ? `Running ${cycleProgress?.current || 0}/${cycleProgress?.total || 0}…`
                    : `Run Cycle${cycleSelectedDates.size > 0 ? ` (${cycleSelectedDates.size})` : ''}`}
                </button>
              </div>
            </div>

            {datesLoading && <div className="bt-muted" style={{ fontSize: 12 }}>Loading dates…</div>}
            {!datesLoading && (
              <div className="bt-cycle-date-grid">
                {dates.map(d => (
                  <label key={d} className="bt-market-row">
                    <input
                      type="checkbox"
                      checked={cycleSelectedDates.has(d)}
                      onChange={() => {}}
                      onClick={e => toggleCycleDate(d, e)}
                    />
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{d}</span>
                  </label>
                ))}
              </div>
            )}

            {cycleRunning && cycleProgress && (
              <div className="bt-cycle-progress">
                <div className="bt-cycle-progress-bar">
                  <div
                    className="bt-cycle-progress-fill"
                    style={{ width: `${(cycleProgress.current / cycleProgress.total) * 100}%` }}
                  />
                </div>
                <span className="bt-muted" style={{ fontSize: 11 }}>
                  {cycleProgress.current}/{cycleProgress.total} — {cycleProgress.currentDate}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Cycle History */}
        {cycleHistory.length > 0 && (
          <div className="bt-hist-section">
            <div className="bt-hist-section-header">
              <h3>Cycle History</h3>
              <span className="bt-muted">{cycleHistory.length} run{cycleHistory.length !== 1 ? 's' : ''} stored</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                {selectedCycleIds.size > 0 && (
                  <span className="bt-muted" style={{ fontSize: 11 }}>{selectedCycleIds.size} selected</span>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedCycleIds(selectedCycleIds.size === cycleHistory.length ? new Set() : new Set(cycleHistory.map(h => h.id)))}>
                  {selectedCycleIds.size === cycleHistory.length ? 'Deselect All' : 'Select All'}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={selectedCycleIds.size === 0}
                  onClick={() => exportCycleLocal(cycleHistory.filter(h => selectedCycleIds.has(h.id)))}
                >
                  Download XLS{selectedCycleIds.size > 0 ? ` (${selectedCycleIds.size})` : ''}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={selectedCycleIds.size === 0 || exportingCycleSheets}
                  onClick={() => exportCycleToSheets(cycleHistory.filter(h => selectedCycleIds.has(h.id)))}
                >
                  {exportingCycleSheets ? 'Exporting…' : `Google Sheets${selectedCycleIds.size > 0 ? ` (${selectedCycleIds.size})` : ''}`}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ color: '#dc2626' }}
                  disabled={selectedCycleIds.size === 0}
                  onClick={deleteSelectedCycle}
                >
                  Delete{selectedCycleIds.size > 0 ? ` (${selectedCycleIds.size})` : ''}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ color: '#dc2626' }}
                  onClick={() => { if (window.confirm('Clear all cycle history?')) { btCycleHistSave([]); setCycleHistory([]); setSelectedCycleIds(new Set()) } }}
                >
                  Clear All
                </button>
              </div>
            </div>

            {cycleHistory.map(entry => {
              const isExpanded = expandedCycleId === entry.id
              const sm = entry.summary || {}
              const pnl = sm.total_pnl || 0
              const dateRange = entry.dates?.length > 0
                ? `${entry.dates[0]} → ${entry.dates[entry.dates.length - 1]}`
                : '—'
              return (
                <div key={entry.id} className={`bt-hist-card${isExpanded ? ' expanded' : ''}${selectedCycleIds.has(entry.id) ? ' selected' : ''}`}>
                  <div className="bt-hist-card-header" onClick={() => setExpandedCycleId(isExpanded ? null : entry.id)}>
                    <input
                      type="checkbox"
                      checked={selectedCycleIds.has(entry.id)}
                      onChange={e => { e.stopPropagation(); toggleCycleSelect(entry.id) }}
                      onClick={e => e.stopPropagation()}
                      style={{ marginRight: 8 }}
                    />
                    <span className="bt-hist-date" style={{ fontSize: 11 }}>{dateRange}</span>
                    <span className="bt-muted" style={{ fontSize: 10 }}>
                      {new Date(entry.run_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="bt-hist-stat">{sm.total_days || 0} days</span>
                    <span className="bt-hist-stat">Bets <strong>{sm.bets_placed || 0}</strong></span>
                    <span className="bt-hist-stat">Stake <strong>£{(sm.total_stake || 0).toFixed(2)}</strong></span>
                    <span className={`bt-hist-stat ${pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                      P&amp;L <strong>{pnl >= 0 ? '+' : ''}£{pnl.toFixed(2)}</strong>
                    </span>
                    <span className={`bt-hist-stat ${(sm.roi || 0) >= 0 ? 'text-success' : 'text-danger'}`}>
                      ROI <strong>{(sm.roi || 0) >= 0 ? '+' : ''}{sm.roi || 0}%</strong>
                    </span>
                    <span className="bt-hist-flags">
                      {entry.config?.jofs_enabled && <span className="tag-on">JOFS</span>}
                      {entry.config?.mark_uplift_enabled && <span className="tag-on">Uplift {entry.config.mark_uplift_stake || 3} pts</span>}
                      {entry.config?.market_overlay_enabled && <span className="tag-on">MOM</span>}
                      {entry.config?.top2_concentration_enabled && <span className="tag-on">TOP2</span>}
                    </span>
                    <span className="collapsible-chevron">{isExpanded ? '−' : '+'}</span>
                  </div>

                  {isExpanded && (
                    <div className="bt-hist-card-body">
                      <div className="bt-hist-card-meta">
                        <span className="bt-muted">
                          {(entry.config?.countries || []).join('/')} · {fmtWindow(entry.config?.process_window_mins)} window ·{' '}
                          {sm.markets_evaluated || 0} markets · {sm.days_completed || 0}/{sm.total_days || 0} days completed
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={e => { e.stopPropagation(); exportCycleLocal([entry]) }}
                          >
                            Export XLS
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ color: '#dc2626' }}
                            onClick={e => {
                              e.stopPropagation()
                              const next = cycleHistory.filter(h => h.id !== entry.id)
                              btCycleHistSave(next)
                              setCycleHistory(next)
                              setExpandedCycleId(null)
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      {/* Per-day sub-cards */}
                      {(entry.days || []).map(day => {
                        const dayKey = `${entry.id}-${day.date}`
                        const isDayExpanded = expandedCycleDayDate === dayKey
                        const dpnl = day.total_pnl || 0
                        const tableId = `bt-cycle-tbl-${dayKey}`
                        return (
                          <div key={day.date} className={`bt-hist-card${isDayExpanded ? ' expanded' : ''}`} style={{ marginTop: 6 }}>
                            <div className="bt-hist-card-header" onClick={() => setExpandedCycleDayDate(isDayExpanded ? null : dayKey)}>
                              <span className="bt-hist-date">{day.date}</span>
                              {day.error
                                ? <span className="bt-muted" style={{ fontSize: 11, color: '#dc2626' }}>Error: {day.error}</span>
                                : <>
                                    <span className="bt-hist-stat">Bets <strong>{day.bets_placed || 0}</strong></span>
                                    <span className="bt-hist-stat">Stake <strong>£{(day.total_stake || 0).toFixed(2)}</strong></span>
                                    <span className={`bt-hist-stat ${dpnl >= 0 ? 'text-success' : 'text-danger'}`}>
                                      P&amp;L <strong>{dpnl >= 0 ? '+' : ''}£{dpnl.toFixed(2)}</strong>
                                    </span>
                                    <span className={`bt-hist-stat ${(day.roi || 0) >= 0 ? 'text-success' : 'text-danger'}`}>
                                      ROI <strong>{(day.roi || 0) >= 0 ? '+' : ''}{day.roi || 0}%</strong>
                                    </span>
                                  </>
                              }
                              <span className="collapsible-chevron">{isDayExpanded ? '−' : '+'}</span>
                            </div>

                            {isDayExpanded && !day.error && (
                              <div className="bt-hist-card-body">
                                <div className="bt-hist-card-meta">
                                  <span className="bt-muted">
                                    {day.markets_evaluated || 0} markets · {day.markets_skipped || 0} skipped
                                  </span>
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={e => { e.stopPropagation(); downloadTableAsExcel(tableId, `cycle_${day.date}_${entry.id}`) }}
                                  >
                                    Export XLS
                                  </button>
                                </div>
                                <div className="table-scroll">
                                  <table id={tableId}>
                                    <thead>
                                      <tr>
                                        <th>Time</th>
                                        <th>Venue</th>
                                        <th>Favourite</th>
                                        <th>Rule</th>
                                        <th>Stake</th>
                                        <th>Liability</th>
                                        <th>Result</th>
                                        <th>P&amp;L</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(day.results || []).map(r => {
                                        const time = r.race_time ? r.race_time.slice(11, 16) : '—'
                                        const skipped = r.skipped
                                        const instructions = r.instructions || []
                                        const totalStake = instructions.reduce((s, i) => s + (i.size || 0), 0)
                                        const totalLiab = instructions.reduce((s, i) => s + (i.liability || 0), 0)
                                        const rpnl = r.pnl || 0
                                        const outcomes = [...new Set(instructions.map(i => i.outcome).filter(Boolean))]
                                        const outcomeStr = skipped ? 'SKIPPED' : (outcomes.join('/') || '—')
                                        const outcomeClass = outcomeStr === 'WON' ? 'text-success'
                                          : outcomeStr === 'LOST' ? 'text-danger'
                                          : outcomeStr === 'SKIPPED' ? 'bt-muted' : ''
                                        return (
                                          <tr key={r.market_id} className={skipped ? 'bt-row-skipped' : ''}>
                                            <td>{time}</td>
                                            <td>{r.venue}</td>
                                            <td>
                                              {r.favourite
                                                ? <span>{r.favourite.name} <span className="bt-muted">@ {r.favourite.odds}</span></span>
                                                : '—'}
                                            </td>
                                            <td className="bt-rule-cell" title={r.rule_applied || r.skip_reason || ''}>
                                              {skipped ? <span className="bt-muted">{r.skip_reason}</span> : r.rule_applied}
                                            </td>
                                            <td>{skipped ? '—' : `£${totalStake.toFixed(2)}`}</td>
                                            <td>{skipped ? '—' : `£${totalLiab.toFixed(2)}`}</td>
                                            <td className={outcomeClass}>{outcomeStr}</td>
                                            <td className={rpnl > 0 ? 'text-success' : rpnl < 0 ? 'text-danger' : ''}>
                                              {skipped ? '—' : `${rpnl >= 0 ? '+' : ''}£${rpnl.toFixed(2)}`}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
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
    </div>
  )
}

// ── Strategy Tab ──
// ── Strategy Sandbox — FSU9 ───────────────────────────────────────────────────

const TRAY_STATUS_COLORS = {
  PENDING:   '#6b7280',
  RUNNING:   '#f59e0b',
  COMPLETED: '#10b981',
  PROMOTED:  '#6366f1',
  DISCARDED: '#ef4444',
}

const LAY_ACTION_COLORS = {
  WATCH:    '#f59e0b',
  SUPPRESS: '#f97316',
  BLOCK:    '#ef4444',
  ALLOW:    '#10b981',
}

function TrayStatusBadge({ status }) {
  return (
    <span className="badge" style={{
      background: TRAY_STATUS_COLORS[status] || '#6b7280',
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 4,
      fontWeight: 700,
      letterSpacing: '0.04em',
    }}>
      {status}
      {status === 'RUNNING' && <span style={{ marginLeft: 5 }}>●</span>}
    </span>
  )
}

function TrayCard({ tray, onPromote, onDiscard, onDelete, onRefresh }) {
  const [expanded, setExpanded] = useState(false)

  const res = tray.backtest_results || {}
  const hasResults = res.markets_evaluated !== undefined

  const layActionColor = LAY_ACTION_COLORS[tray.lay_action] || '#6b7280'

  return (
    <div className="tray-card" style={{
      background: 'var(--card-bg, #1a1d23)',
      border: '1px solid var(--border, #2a2d35)',
      borderRadius: 8,
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px',
        borderBottom: '1px solid var(--border, #2a2d35)',
        background: 'var(--card-header-bg, #14171d)',
      }}>
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 15, marginRight: 10 }}>
            {tray.rule_family || tray.name}
          </span>
          <TrayStatusBadge status={tray.status} />
          {tray.lay_action && (
            <span className="badge" style={{
              background: layActionColor, fontSize: 11, padding: '2px 7px',
              borderRadius: 4, fontWeight: 700, marginLeft: 6,
            }}>
              {tray.lay_action}
            </span>
          )}
          {tray.severity && (
            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>
              [{tray.severity}]
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {tray.status === 'COMPLETED' && (
            <>
              <button className="bt-run-btn" style={{ padding: '4px 12px', fontSize: 12, background: '#6366f1' }}
                onClick={() => onPromote(tray.id)}>
                Promote
              </button>
              <button className="bt-run-btn" style={{ padding: '4px 12px', fontSize: 12, background: '#6b7280' }}
                onClick={() => onDiscard(tray.id)}>
                Discard
              </button>
            </>
          )}
          {tray.status === 'RUNNING' && (
            <button className="bt-run-btn" style={{ padding: '4px 12px', fontSize: 12, background: '#f59e0b' }}
              onClick={onRefresh}>
              Refresh
            </button>
          )}
          <button style={{
            background: 'none', border: '1px solid #374151', color: '#9ca3af',
            borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer',
          }} onClick={() => setExpanded(e => !e)}>
            {expanded ? '▲ Less' : '▼ More'}
          </button>
          <button style={{
            background: 'none', border: '1px solid #374151', color: '#ef4444',
            borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer',
          }} onClick={() => onDelete(tray.id)}>
            ✕
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '12px 16px' }}>

        {/* Purpose */}
        {tray.purpose && (
          <p style={{ margin: '0 0 10px', color: '#d1d5db', fontSize: 13, lineHeight: 1.5 }}>
            {tray.purpose}
          </p>
        )}

        {/* Test instruction */}
        {tray.test_instruction && (
          <div style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Test instruction
            </span>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
              {tray.test_instruction}
            </p>
          </div>
        )}

        {/* Key spec row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 10 }}>
          {tray.priority && (
            <div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Priority</div>
              <div style={{ fontSize: 13 }}>{tray.priority}</div>
            </div>
          )}
          {tray.checkpoints?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Checkpoints</div>
              <div style={{ fontSize: 13 }}>{tray.checkpoints.join(', ')}</div>
            </div>
          )}
          {tray.lay_multiplier !== undefined && tray.lay_multiplier !== 1.0 && (
            <div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Lay Multiplier</div>
              <div style={{ fontSize: 13, color: layActionColor }}>×{tray.lay_multiplier}</div>
            </div>
          )}
          {tray.reason_codes?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Reason Codes</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>{tray.reason_codes.join(', ')}</div>
            </div>
          )}
        </div>

        {/* Threshold bands */}
        {tray.threshold_bands?.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
              Threshold Bands
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {tray.threshold_bands.map((b, i) => (
                <span key={i} style={{
                  background: '#1f2937', border: '1px solid #374151',
                  borderRadius: 4, padding: '2px 8px', fontSize: 11,
                }}>
                  <span style={{ color: '#9ca3af' }}>{b.name || b.severity || `Band ${i+1}`}:</span>{' '}
                  {b.field} {b.operator} {b.value}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Backtest results */}
        {hasResults && (
          <div style={{
            background: 'var(--card-header-bg, #14171d)',
            border: '1px solid var(--border, #2a2d35)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 10,
          }}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>
              Backtest Results — {res.date}
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {[
                ['Markets', res.markets_evaluated],
                ['Bets', res.bets_placed],
                ['Skipped', res.markets_skipped],
                ['Stake', `£${(res.total_stake||0).toFixed(2)}`],
                ['Liability', `£${(res.total_liability||0).toFixed(2)}`],
                ['P&L', <span style={{ color: (res.total_pnl||0) >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  {(res.total_pnl||0) >= 0 ? '+' : ''}£{(res.total_pnl||0).toFixed(2)}
                </span>],
                ['ROI', <span style={{ color: (res.roi||0) >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  {(res.roi||0) >= 0 ? '+' : ''}{(res.roi||0).toFixed(1)}%
                </span>],
              ].map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Agent analysis */}
        {tray.agent_analysis && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
              AI Analysis
            </div>
            <p style={{ margin: 0, fontSize: 13, color: '#d1d5db', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {tray.agent_analysis}
            </p>
          </div>
        )}

        {/* Expanded detail */}
        {expanded && (
          <div style={{ borderTop: '1px solid #2a2d35', paddingTop: 12, marginTop: 4 }}>
            {/* Inputs required */}
            {tray.inputs_required?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                  Inputs Required
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {tray.inputs_required.map((inp, i) => (
                    <code key={i} style={{
                      background: '#1f2937', border: '1px solid #374151',
                      borderRadius: 3, padding: '1px 6px', fontSize: 11,
                    }}>{inp}</code>
                  ))}
                </div>
              </div>
            )}

            {/* Derived metrics */}
            {tray.derived_metrics?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                  Derived Metrics
                </div>
                {tray.derived_metrics.map((m, i) => (
                  <div key={i} style={{ marginBottom: 4, fontSize: 12 }}>
                    <code style={{ color: '#a5b4fc' }}>{m.name || m.formula || JSON.stringify(m)}</code>
                    {m.description && <span style={{ color: '#6b7280', marginLeft: 8 }}>— {m.description}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Sub-rules */}
            {tray.sub_rules?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>
                  Sub-Rules ({tray.sub_rules.length})
                </div>
                {tray.sub_rules.map((r, i) => (
                  <div key={i} style={{
                    background: '#1a1d23', border: '1px solid #2a2d35',
                    borderRadius: 5, padding: '8px 10px', marginBottom: 6, fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: '#e2e8f0' }}>
                      {r.id || r.name || `Rule ${i+1}`}
                    </div>
                    {r.purpose && <div style={{ color: '#9ca3af', marginBottom: 2 }}>{r.purpose}</div>}
                    {r.trigger && <div><code style={{ color: '#86efac' }}>{r.trigger}</code></div>}
                    {r.effect && <div style={{ color: '#fcd34d', marginTop: 2 }}>→ {typeof r.effect === 'string' ? r.effect : JSON.stringify(r.effect)}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Expected output */}
            {tray.expected_output && Object.keys(tray.expected_output).length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                  Expected Output Schema
                </div>
                <pre style={{
                  background: '#111318', border: '1px solid #2a2d35', borderRadius: 5,
                  padding: '8px 10px', fontSize: 11, color: '#a5b4fc', overflowX: 'auto', margin: 0,
                }}>
                  {JSON.stringify(tray.expected_output, null, 2)}
                </pre>
              </div>
            )}

            {/* Full backtest per-market results */}
            {res.results?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>
                  Per-Market Results
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #2a2d35', color: '#6b7280', textAlign: 'left' }}>
                        {['Time','Venue','Favourite','Rule','Stake','P&L','Result'].map(h => (
                          <th key={h} style={{ padding: '4px 8px', fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {res.results.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #1f2937' }}>
                          <td style={{ padding: '4px 8px', color: '#9ca3af' }}>
                            {r.race_time ? new Date(r.race_time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : '—'}
                          </td>
                          <td style={{ padding: '4px 8px' }}>{r.venue || '—'}</td>
                          <td style={{ padding: '4px 8px', fontSize: 11 }}>{r.favourite_name || '—'}</td>
                          <td style={{ padding: '4px 8px', fontSize: 11, color: '#9ca3af' }}>{r.rule || r.skip_reason || '—'}</td>
                          <td style={{ padding: '4px 8px' }}>{r.stake ? `£${r.stake}` : '—'}</td>
                          <td style={{ padding: '4px 8px', color: (r.pnl||0) >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                            {r.pnl !== undefined ? `${r.pnl >= 0 ? '+' : ''}£${r.pnl.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ padding: '4px 8px' }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700,
                              color: r.result === 'WON' ? '#10b981' : r.result === 'LOST' ? '#ef4444' : '#6b7280',
                            }}>{r.result || 'SKIPPED'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Timestamps */}
            <div style={{ marginTop: 10, fontSize: 11, color: '#4b5563' }}>
              Created: {new Date(tray.created_at).toLocaleString('en-GB')}
              {tray.completed_at && ` · Completed: ${new Date(tray.completed_at).toLocaleString('en-GB')}`}
              {tray.backtest_job_id && ` · Job: ${tray.backtest_job_id.slice(0,8)}…`}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StrategyTab({ openChat }) {
  const [trays, setTrays] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const API = window.API_BASE || ''

  const fetchTrays = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/strategy/sandbox/trays`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setTrays(d.trays || [])
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [API])

  useEffect(() => {
    fetchTrays()
    // Poll every 5s while any tray is RUNNING
    pollRef.current = setInterval(() => {
      setTrays(prev => {
        if (prev.some(t => t.status === 'RUNNING')) {
          fetchTrays()
        }
        return prev
      })
    }, 5000)
    return () => clearInterval(pollRef.current)
  }, [fetchTrays])

  const handlePromote = async (id) => {
    await fetch(`${API}/api/strategy/sandbox/trays/${id}/promote`, { method: 'POST' })
    fetchTrays()
  }

  const handleDiscard = async (id) => {
    await fetch(`${API}/api/strategy/sandbox/trays/${id}/discard`, { method: 'POST' })
    fetchTrays()
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this tray?')) return
    await fetch(`${API}/api/strategy/sandbox/trays/${id}`, { method: 'DELETE' })
    fetchTrays()
  }

  // Tray summary counts
  const counts = trays.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1
    return acc
  }, {})

  return (
    <div className="backtest-tab bt-wide">
      {/* ── Header bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Strategy Sandbox</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
            FSU9 — Rule testing workspace. Tests are run by the AI agent; review and promote rules here.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {Object.entries(counts).map(([status, count]) => (
            <span key={status} style={{
              fontSize: 12, padding: '3px 10px', borderRadius: 4,
              background: TRAY_STATUS_COLORS[status] + '22',
              border: `1px solid ${TRAY_STATUS_COLORS[status]}44`,
              color: TRAY_STATUS_COLORS[status],
              fontWeight: 600,
            }}>
              {count} {status}
            </span>
          ))}
          {openChat && (
            <button className="bt-run-btn" style={{ padding: '5px 14px', fontSize: 12, background: '#1d4ed8' }}
              onClick={() => openChat(null, 'I want to test a new rule or strategy. Please ask me what I have in mind, then create a sandbox tray, define the rule logic, run a backtest, and summarise the results.')}>
              + New Test
            </button>
          )}
          <button className="bt-run-btn" style={{ padding: '5px 14px', fontSize: 12 }}
            onClick={fetchTrays}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Workflow hint ── */}
      {trays.length === 0 && !loading && (
        <div style={{
          background: '#14171d', border: '1px solid #2a2d35', borderRadius: 8,
          padding: '28px 24px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🧪</div>
          <h3 style={{ margin: '0 0 8px', color: '#d1d5db' }}>No active tests</h3>
          <p style={{ margin: 0, color: '#6b7280', fontSize: 13, maxWidth: 480, marginInline: 'auto' }}>
            Ask the AI agent to test a rule or strategy. It will create a tray here, run a backtest,
            and save results for your review. You can then promote the rule to production or discard it.
          </p>
          <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {[
              'Test the TOP2_CONCENTRATION rule on a recent date',
              'Run a backtest with the Market Overlay Modifier on 2025-11-15',
              'What dates have backtest data available?',
            ].map(hint => (
              <span key={hint}
                onClick={() => openChat && openChat(null, hint)}
                style={{
                  background: '#1f2937', border: '1px solid #374151', borderRadius: 4,
                  padding: '4px 10px', fontSize: 11, color: '#9ca3af', fontStyle: 'italic',
                  cursor: openChat ? 'pointer' : 'default',
                }}>
                "{hint}"
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p style={{ color: '#ef4444', fontSize: 13 }}>Error loading trays: {error}</p>
      )}

      {/* ── Tray status sections ── */}
      {['RUNNING', 'PENDING', 'COMPLETED', 'PROMOTED', 'DISCARDED'].map(status => {
        const group = trays.filter(t => t.status === status)
        if (!group.length) return null
        return (
          <div key={status} style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: TRAY_STATUS_COLORS[status],
              borderBottom: `1px solid ${TRAY_STATUS_COLORS[status]}33`,
              paddingBottom: 6, marginBottom: 12,
            }}>
              {status} ({group.length})
            </div>
            {group.map(tray => (
              <TrayCard
                key={tray.id}
                tray={tray}
                onPromote={handlePromote}
                onDiscard={handleDiscard}
                onDelete={handleDelete}
                onRefresh={fetchTrays}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ── Shared date formatter ──
const formatDateHeader = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

// ── History Tab (Sessions + Matched + Settled) ──
// ── Collapsible month helpers ──
function groupByMonth(items, getDate) {
  const groups = {}
  items.forEach(item => {
    const d = getDate(item)
    const month = d ? d.slice(0, 7) : 'unknown'
    if (!groups[month]) groups[month] = []
    groups[month].push(item)
  })
  return groups
}

function formatMonthLabel(ym) {
  if (!ym || ym === 'unknown') return 'Unknown Date'
  const [y, m] = ym.split('-')
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
  return `${months[parseInt(m, 10) - 1]} ${y}`
}

function CollapsibleMonth({ label, count, countLabel = 'item', defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="collapsible-month">
      <div className="collapsible-month-header" onClick={() => setOpen(o => !o)}>
        <span className="collapse-arrow">{open ? '▾' : '▸'}</span>
        <span className="collapse-label">{label}</span>
        <span className="collapse-count">{count} {countLabel}{count !== 1 ? 's' : ''}</span>
      </div>
      {open && <div className="collapsible-month-body">{children}</div>}
    </div>
  )
}

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
        setSessions((data.sessions || []).filter(s => s.mode === 'LIVE'))
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

  // Group sessions by date then by month
  const grouped = {}
  sessions.forEach(s => {
    if (!grouped[s.date]) grouped[s.date] = []
    grouped[s.date].push(s)
  })
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a))
  const monthMap = {}
  sortedDates.forEach(date => {
    const month = date.slice(0, 7)
    if (!monthMap[month]) monthMap[month] = []
    monthMap[month].push(date)
  })
  const sortedMonths = Object.keys(monthMap).sort((a, b) => b.localeCompare(a))

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
          {sortedMonths.map((month, mi) => (
            <CollapsibleMonth
              key={month}
              label={formatMonthLabel(month)}
              count={monthMap[month].reduce((sum, d) => sum + grouped[d].length, 0)}
              countLabel="session"
              defaultOpen={mi === 0}
            >
          {monthMap[month].map(date => (
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
            </CollapsibleMonth>
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

          {(() => {
            const allDates = Object.keys(data.bets_by_date).sort((a, b) => b.localeCompare(a))
            const byMonth = groupByMonth(allDates, d => d)
            const sortedMonths = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))
            return sortedMonths.map((month, mi) => {
              const monthDates = byMonth[month]
              const monthBets = monthDates.reduce((sum, d) => sum + (data.bets_by_date[d]?.length || 0), 0)
              return (
                <CollapsibleMonth key={month} label={formatMonthLabel(month)} count={monthBets} countLabel="bet" defaultOpen={mi === 0}>
                  {monthDates.map(date => {
                    const bets = data.bets_by_date[date]
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
                </CollapsibleMonth>
              )
            })
          })()}
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
          {(() => {
            const allDates = Object.keys(data.days).sort((a, b) => b.localeCompare(a))
            const byMonth = groupByMonth(allDates, d => d)
            const sortedMonths = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))
            return sortedMonths.map((month, mi) => {
              const monthDates = byMonth[month]
              const monthBets = monthDates.reduce((sum, d) => sum + (getFilteredBets(data.days[d]?.bets || []).length), 0)
              if (monthBets === 0) return null
              return (
                <CollapsibleMonth key={month} label={formatMonthLabel(month)} count={monthBets} countLabel="bet" defaultOpen={mi === 0}>
                  {monthDates.map(date => {
            const dayData = data.days[date]
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
                </CollapsibleMonth>
              )
            })
          })()}
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

// ── Data Source Labels ──
const DATA_SOURCE_LABELS = {
  session_data:       { label: 'Session Data',       desc: 'Live/dry-run session bets and rule evaluations', icon: '📊' },
  settled_bets:       { label: 'Settled Bets',       desc: 'Betfair settled bet outcomes with actual P/L', icon: '✅' },
  historical_summary: { label: 'Historical Summary', desc: 'Cumulative performance across all operating days', icon: '📈' },
  engine_state:       { label: 'Engine State',       desc: 'Current engine status, balance, and configuration', icon: '⚙️' },
  rule_definitions:   { label: 'Rule Definitions',   desc: 'Active betting rules and their parameters', icon: '📐' },
  backtest_results:   { label: 'Backtest Results',   desc: 'Historical backtest data from FSU', icon: '🧪' },
  github_codebase:    { label: 'GitHub Codebase',    desc: 'Source code from the lay-engine repository', icon: '💻' },
}

const AI_CAPABILITY_LABELS = {
  send_emails:   { label: 'Send Emails',     desc: 'Auto-dispatch reports to recipients after generation', icon: '📧' },
  write_reports: { label: 'Write Reports',   desc: 'Generate AI-powered performance reports', icon: '📝' },
  fetch_files:   { label: 'Fetch Files',     desc: 'Access and read files from connected storage', icon: '📁' },
  github_access: { label: 'GitHub Access',   desc: 'Browse and understand the app codebase on GitHub', icon: '🐙' },
}

// ── Settings Tab ──
function SettingsTab({ theme, setTheme }) {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    api('/api/settings')
      .then(data => { setSettings(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  const addRecipient = async () => {
    if (!newEmail.trim()) return
    const updated = [...(settings.report_recipients || []), { email: newEmail.trim(), name: newName.trim() }]
    setSaving(true)
    const res = await api('/api/settings/recipients', {
      method: 'PUT',
      body: JSON.stringify({ recipients: updated }),
    })
    if (res.recipients) setSettings(prev => ({ ...prev, report_recipients: res.recipients }))
    setNewEmail('')
    setNewName('')
    setSaving(false)
    showToast('Recipient added')
  }

  const removeRecipient = async (idx) => {
    const updated = settings.report_recipients.filter((_, i) => i !== idx)
    const res = await api('/api/settings/recipients', {
      method: 'PUT',
      body: JSON.stringify({ recipients: updated }),
    })
    if (res.recipients) setSettings(prev => ({ ...prev, report_recipients: res.recipients }))
    showToast('Recipient removed')
  }

  const toggleDataSource = async (key) => {
    const current = settings.ai_data_sources[key]
    const res = await api('/api/settings/ai-data-sources', {
      method: 'PUT',
      body: JSON.stringify({ ai_data_sources: { [key]: !current } }),
    })
    if (res.ai_data_sources) setSettings(prev => ({ ...prev, ai_data_sources: res.ai_data_sources }))
  }

  const toggleCapability = async (key) => {
    const current = settings.ai_capabilities[key]
    const res = await api('/api/settings/ai-capabilities', {
      method: 'PUT',
      body: JSON.stringify({ ai_capabilities: { [key]: !current } }),
    })
    if (res.ai_capabilities) setSettings(prev => ({ ...prev, ai_capabilities: res.ai_capabilities }))
  }

  if (loading) return <p className="empty">Loading settings...</p>
  if (!settings) return <p className="empty">Failed to load settings.</p>

  const recipients = settings.report_recipients || []
  const dataSources = settings.ai_data_sources || {}
  const capabilities = settings.ai_capabilities || {}
  const enabledCount = Object.values(dataSources).filter(Boolean).length
  const totalCount = Object.keys(dataSources).length

  return (
    <div>
      {toast && <div className="settings-toast">{toast}</div>}

      {/* ── Betfair Connection ── */}
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

      {/* ── Report Recipients ── */}
      <div className="engine-section" style={{ marginTop: 12 }}>
        <h2>Report Recipients</h2>
        <p className="api-description">
          When AI generates a report, copies are automatically emailed to all recipients listed below
          (requires <strong>Send Emails</strong> capability enabled).
        </p>

        <div className="recipients-list">
          {recipients.length === 0 ? (
            <p className="empty">No recipients configured. Add email addresses below.</p>
          ) : (
            recipients.map((r, i) => (
              <div key={i} className="recipient-row">
                <span className="recipient-icon">📧</span>
                <div className="recipient-info">
                  <span className="recipient-email">{r.email}</span>
                  {r.name && <span className="recipient-name">{r.name}</span>}
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => removeRecipient(i)}>Remove</button>
              </div>
            ))
          )}
        </div>

        <div className="recipient-add-form">
          <input
            type="email"
            placeholder="Email address"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addRecipient()}
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addRecipient()}
          />
          <button className="btn btn-primary" onClick={addRecipient} disabled={saving || !newEmail.trim()}>
            {saving ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>

      {/* ── AI Data Sources ── */}
      <div className="engine-section" style={{ marginTop: 12 }}>
        <h2>AI Data Sources</h2>
        <p className="api-description">
          Control which data sets are exposed to the Chimera AI agent when generating reports
          and answering questions. <strong>{enabledCount}/{totalCount}</strong> sources enabled.
        </p>

        <div className="data-sources-grid">
          {Object.entries(DATA_SOURCE_LABELS).map(([key, meta]) => {
            const enabled = dataSources[key] ?? false
            return (
              <div
                key={key}
                className={`data-source-card ${enabled ? 'enabled' : 'disabled'}`}
                onClick={() => toggleDataSource(key)}
              >
                <div className="data-source-header">
                  <span className="data-source-icon">{meta.icon}</span>
                  <span className="data-source-label">{meta.label}</span>
                  <span className={`data-source-toggle ${enabled ? 'on' : 'off'}`}>
                    {enabled ? 'ON' : 'OFF'}
                  </span>
                </div>
                <p className="data-source-desc">{meta.desc}</p>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── AI Capabilities ── */}
      <div className="engine-section" style={{ marginTop: 12 }}>
        <h2>Chimera AI Capabilities</h2>
        <p className="api-description">
          Control what actions the AI agent is allowed to perform. Disabled capabilities
          restrict the agent even if the underlying service is configured.
        </p>

        <div className="data-sources-grid">
          {Object.entries(AI_CAPABILITY_LABELS).map(([key, meta]) => {
            const enabled = capabilities[key] ?? false
            return (
              <div
                key={key}
                className={`data-source-card ${enabled ? 'enabled' : 'disabled'}`}
                onClick={() => toggleCapability(key)}
              >
                <div className="data-source-header">
                  <span className="data-source-icon">{meta.icon}</span>
                  <span className="data-source-label">{meta.label}</span>
                  <span className={`data-source-toggle ${enabled ? 'on' : 'off'}`}>
                    {enabled ? 'ON' : 'OFF'}
                  </span>
                </div>
                <p className="data-source-desc">{meta.desc}</p>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Appearance ── */}
      <div className="engine-section" style={{ marginTop: 12 }}>
        <h2>Appearance</h2>
        <p className="api-description">Choose the visual theme for the CHIMERA interface.</p>
        <div className="theme-switcher">
          {[
            { id: 'classic', label: 'Classic', desc: 'Light professional theme' },
            { id: 'dark',    label: 'Dark Glass', desc: 'Dark background with glass panels' },
            { id: 'light',   label: 'Light Glass', desc: 'Light background with frosted panels' },
          ].map(t => (
            <div
              key={t.id}
              className={`theme-option${theme === t.id ? ' active' : ''}`}
              onClick={() => setTheme(t.id)}
            >
              <div className={`theme-option-preview theme-preview-${t.id}`} />
              <span className="theme-option-label">{t.label}</span>
              <span className="theme-option-desc">{t.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── API Keys ── */}
      <div style={{ marginTop: 12 }}>
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
  const [sendingEmail, setSendingEmail] = useState(false)
  const [savingDrive, setSavingDrive] = useState(false)
  const [emailToast, setEmailToast] = useState('')
  const [reportError, setReportError] = useState('')
  const reportContentRef = useRef(null)

  // Data Registry & Dry Run Archive state
  const [registry, setRegistry] = useState(null)
  const [registryLoading, setRegistryLoading] = useState(false)
  const [snapshots, setSnapshots] = useState([])
  const [archivingId, setArchivingId] = useState(null)
  const [activeSection, setActiveSection] = useState('reports') // 'reports' | 'dryrun' | 'registry'

  useEffect(() => {
    api('/api/reports/templates').then(data => setTemplates(data.templates || []))
    fetchReports()
    fetchSnapshots()
    fetchRegistry()
  }, [])

  const fetchRegistry = () => {
    setRegistryLoading(true)
    api('/api/data-registry')
      .then(data => { setRegistry(data); setRegistryLoading(false) })
      .catch(() => setRegistryLoading(false))
  }

  const fetchSnapshots = () => {
    api('/api/snapshots').then(data => setSnapshots(data.snapshots || []))
  }

  const handleArchiveSnapshot = async (snapshotId) => {
    setArchivingId(snapshotId)
    await api(`/api/snapshots/${snapshotId}/archive`, { method: 'POST' })
    fetchSnapshots()
    fetchRegistry()
    setArchivingId(null)
  }

  const handleDownloadSnapshot = (snapshotId, createdAt) => {
    const ts = createdAt ? createdAt.slice(0, 10) : snapshotId
    window.open(`${API}/api/snapshots/${snapshotId}/export`, '_blank')
  }

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
    setReportError('')
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
        if (res.email_result?.sent > 0) {
          setEmailToast(`Report auto-sent to ${res.email_result.sent} recipient${res.email_result.sent !== 1 ? 's' : ''}`)
          setTimeout(() => setEmailToast(''), 4000)
        }
      } else {
        // Backend returned an error body — surface the message to the user
        const msg = res.message || res.detail || 'Report generation failed — check server logs'
        setReportError(msg)
        console.error('Report generation error:', res)
      }
    } catch (e) {
      setReportError(`Network error: ${e.message}`)
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

  const handleSendEmail = async (reportId) => {
    setSendingEmail(true)
    setEmailToast('')
    try {
      const res = await api(`/api/reports/${reportId}/send`, { method: 'POST' })
      if (res.sent > 0) {
        setEmailToast(`Report sent to ${res.sent} recipient${res.sent !== 1 ? 's' : ''}`)
      } else {
        setEmailToast(res.error || 'Failed to send')
      }
    } catch (e) {
      setEmailToast('Email send failed')
    }
    setSendingEmail(false)
    setTimeout(() => setEmailToast(''), 4000)
  }

  const handleSaveDrive = async (reportId) => {
    setSavingDrive(true)
    setEmailToast('')
    try {
      const res = await api(`/api/reports/${reportId}/save-drive`, { method: 'POST' })
      if (res.url) {
        setEmailToast('Saved to Google Drive')
        window.open(res.url, '_blank')
      } else {
        setEmailToast(res.error || res.detail || 'Save failed')
      }
    } catch (e) {
      setEmailToast('Google Drive save failed')
    }
    setSavingDrive(false)
    setTimeout(() => setEmailToast(''), 4000)
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
    const fmtPL = (v) => { if (v == null || isNaN(v)) return '—'; return v >= 0 ? `+£${v.toFixed(2)}` : `−£${Math.abs(v).toFixed(2)}` }
    const fmtPct = (v) => { if (v == null || isNaN(v)) return '—'; return `${(v * 100).toFixed(1)}%` }
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
        h += `<tr><td>${b.race_time || ''}</td><td>${b.selection}</td><td>${b.venue}</td><td>${b.market || ''}</td><td>${fmtOdds(b.odds)}</td><td>${b.stake != null ? '£' + b.stake.toFixed(2) : '—'}</td><td>${b.liability != null ? '£' + b.liability.toFixed(2) : '—'}</td><td>${fmtPL(b.pl)}</td><td style="${resultClass}"><strong>${b.result}</strong></td><td>${b.band_label || ''}</td><td>${b.rule || ''}</td></tr>`
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
          // JSON is malformed — most likely truncated due to output token limit
          return `<div style="padding:2rem;text-align:center;color:#e88;">
            <h2>⚠️ Report Render Error</h2>
            <p>The AI response was truncated before completing the report JSON.<br/>
            Please delete this report and regenerate it — the fix has been applied to prevent this happening again.</p>
          </div>`
        }
      }
    }
    if (typeof content === 'object') return renderJsonReport(content)
    return renderMarkdown(content)
  }

  if (viewingReport) {
    return (
      <div>
        {emailToast && <div className="settings-toast">{emailToast}</div>}
        <div className="tab-toolbar">
          <button className="btn btn-secondary btn-back" onClick={() => setViewingReport(null)}>
            ← Back to Reports
          </button>
          <h2>{viewingReport.title}</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-secondary"
              onClick={() => handleSendEmail(viewingReport.report_id)}
              disabled={sendingEmail}
            >
              {sendingEmail ? 'Sending...' : '📧 Email'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => handleSaveDrive(viewingReport.report_id)}
              disabled={savingDrive}
            >
              {savingDrive ? 'Saving...' : 'Save to Drive'}
            </button>
            <button className="btn btn-primary" onClick={handleDownloadPDF}>
              Print / PDF
            </button>
          </div>
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
                {reportError && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.4)', borderRadius: 6, color: '#ff6b6b', fontSize: 13 }}>
                    ⚠ {reportError}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Section Nav ── */}
      <div className="report-section-nav">
        {[
          { id: 'reports', label: '📄 Generated Reports', count: reports.length },
          { id: 'dryrun',  label: '🧪 Dry Run Archive',  count: snapshots.length },
          { id: 'registry',label: '🗂 Data Registry',    count: registry?.entries?.length || 0 },
        ].map(s => (
          <button
            key={s.id}
            className={`report-section-btn ${activeSection === s.id ? 'active' : ''}`}
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
            <span className="report-section-count">{s.count}</span>
          </button>
        ))}
      </div>

      {/* ── Generated Reports ── */}
      {activeSection === 'reports' && (
        <div className="report-list-section">
          {reports.length === 0 ? (
            <p className="empty">No reports generated yet. Select a date and sessions above to create one.</p>
          ) : (
            <div className="report-list">
              {(() => {
                const byMonth = groupByMonth(reports, r => r.created_at?.slice(0, 10) || '')
                const sortedMonths = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))
                return sortedMonths.map((month, mi) => (
                  <CollapsibleMonth key={month} label={formatMonthLabel(month)} count={byMonth[month].length} countLabel="report" defaultOpen={mi === 0}>
                    {byMonth[month].map(r => (
                      <div key={r.report_id} className="card report-card">
                        <div className="report-card-info">
                          <strong>{r.title}</strong>
                          <span className="report-card-meta">
                            {r.template_name} · {new Date(r.created_at).toLocaleString()} · {r.session_ids?.length || 0} session{(r.session_ids?.length || 0) !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <div className="report-card-actions">
                          <button className="btn btn-secondary btn-sm" onClick={() => handleViewReport(r.report_id)}>View</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDeleteReport(r.report_id)}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </CollapsibleMonth>
                ))
              })()}
            </div>
          )}
        </div>
      )}

      {/* ── Dry Run Archive ── */}
      {activeSection === 'dryrun' && (
        <div className="dryrun-archive-section">
          {snapshots.length === 0 ? (
            <p className="empty">No dry-run snapshots recorded yet.</p>
          ) : (
            <div className="dryrun-archive-list">
              {(() => {
                const byMonth = groupByMonth(snapshots, s => s.created_at?.slice(0, 10) || '')
                const sortedMonths = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))
                return sortedMonths.map((month, mi) => (
                  <CollapsibleMonth key={month} label={formatMonthLabel(month)} count={byMonth[month].length} countLabel="snapshot" defaultOpen={mi === 0}>
                    {byMonth[month].map(s => (
                      <div key={s.snapshot_id} className={`card dryrun-archive-card ${s.archived ? 'archived' : ''}`}>
                        <div className="dryrun-archive-info">
                          <div className="dryrun-archive-meta">
                            <span className="dryrun-archive-date">
                              {new Date(s.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                            </span>
                            {s.archived && <span className="badge badge-archived">Archived</span>}
                          </div>
                          <div className="dryrun-archive-stats">
                            <span>Markets: <strong>{s.markets_evaluated}</strong></span>
                            <span>Would place: <strong>{s.bets_would_place}</strong></span>
                            <span>Stake: <strong>£{(s.total_stake || 0).toFixed(2)}</strong></span>
                            <span>Liability: <strong>£{(s.total_liability || 0).toFixed(2)}</strong></span>
                          </div>
                        </div>
                        <div className="dryrun-archive-actions">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleDownloadSnapshot(s.snapshot_id, s.created_at)}
                            title="Download as JSON"
                          >
                            ⬇ Download
                          </button>
                          <button
                            className={`btn btn-sm ${s.archived ? 'btn-secondary' : 'btn-warning'}`}
                            onClick={() => handleArchiveSnapshot(s.snapshot_id)}
                            disabled={archivingId === s.snapshot_id}
                            title={s.archived ? 'Unarchive' : 'Archive'}
                          >
                            {archivingId === s.snapshot_id ? '...' : s.archived ? '↩ Unarchive' : '📦 Archive'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </CollapsibleMonth>
                ))
              })()}
            </div>
          )}
        </div>
      )}

      {/* ── Data Registry ── */}
      {activeSection === 'registry' && (
        <div className="registry-section">
          {registryLoading ? (
            <p className="empty">Loading data registry...</p>
          ) : !registry ? (
            <p className="empty">Unable to load registry.</p>
          ) : (
            <>
              {/* Storage Locations */}
              <div className="registry-storage">
                <h3>Storage Locations</h3>
                <div className="registry-storage-grid">
                  {Object.entries(registry.storage_locations || {}).map(([key, loc]) => (
                    <div key={key} className="registry-storage-card">
                      <div className="registry-storage-key">{key.replace(/_/g, ' ').toUpperCase()}</div>
                      <div className="registry-storage-desc">{loc.description}</div>
                      <div className="registry-storage-paths">
                        <span className="registry-path gcs" title="Google Cloud Storage">☁ {loc.gcs}</span>
                        <span className="registry-path local" title="Cloud Run local">💾 {loc.local}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Per-day record inventory */}
              <div className="registry-entries">
                <h3>
                  Record Inventory
                  <span className="registry-totals">
                    {registry.total_sessions} sessions · {registry.total_snapshots} dry runs · {registry.total_reports} reports
                    {registry.earliest_date && ` · from ${registry.earliest_date}`}
                  </span>
                </h3>
                {registry.entries.length === 0 ? (
                  <p className="empty">No records found.</p>
                ) : (
                  <div className="registry-table-wrap">
                    {(() => {
                      const byMonth = groupByMonth(registry.entries, e => e.date)
                      const sortedMonths = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))
                      return sortedMonths.map((month, mi) => {
                        const entries = byMonth[month]
                        return (
                          <CollapsibleMonth
                            key={month}
                            label={formatMonthLabel(month)}
                            count={entries.length}
                            countLabel="day"
                            defaultOpen={mi === 0}
                          >
                            <table className="registry-table">
                              <thead>
                                <tr>
                                  <th>Date</th>
                                  <th>Sessions</th>
                                  <th>Dry Runs</th>
                                  <th>Reports</th>
                                  <th>Total Records</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entries.map(e => {
                                  const liveSessions = e.sessions.filter(s => s.mode === 'LIVE').length
                                  const drySessions  = e.sessions.filter(s => s.mode === 'DRY_RUN').length
                                  const totalBets    = e.sessions.reduce((sum, s) => sum + (s.total_bets || 0), 0)
                                  const archived     = e.dry_run_snapshots.filter(s => s.archived).length
                                  return (
                                    <tr key={e.date}>
                                      <td><strong>{e.date}</strong></td>
                                      <td>
                                        {liveSessions > 0 && <span className="badge badge-live" style={{marginRight:4}}>{liveSessions} LIVE</span>}
                                        {drySessions  > 0 && <span className="badge badge-dry">{drySessions} DRY</span>}
                                        {totalBets > 0 && <span style={{marginLeft:6,fontSize:11,color:'#6b7280'}}>{totalBets} bets</span>}
                                      </td>
                                      <td>
                                        {e.dry_run_snapshots.length > 0
                                          ? <span>{e.dry_run_snapshots.length} snapshot{e.dry_run_snapshots.length !== 1 ? 's' : ''}{archived > 0 ? ` (${archived} archived)` : ''}</span>
                                          : <span className="registry-none">—</span>}
                                      </td>
                                      <td>
                                        {e.reports.length > 0
                                          ? <span>{e.reports.length} report{e.reports.length !== 1 ? 's' : ''}</span>
                                          : <span className="registry-none">—</span>}
                                      </td>
                                      <td>
                                        <strong>{e.sessions.length + e.dry_run_snapshots.length + e.reports.length}</strong>
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </CollapsibleMonth>
                        )
                      })
                    })()}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── BSP Optimiser Tab ──
function BspOptimiserTab() {
  const [subTab, setSubTab] = useState('analysis')

  // ── Analysis state ──
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 14)
    return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [countries, setCountries] = useState(['GB', 'IE'])
  const [threshold, setThreshold] = useState(10)
  const [maxBsp, setMaxBsp] = useState(10)

  const [jobId, setJobId] = useState(null)
  const [jobStatus, setJobStatus] = useState(null) // null | 'running' | 'done' | 'error'
  const [jobResult, setJobResult] = useState(null)
  const [jobError, setJobError] = useState('')
  const pollRef = useRef(null)

  // ── Live settings state ──
  const [liveSettings, setLiveSettings] = useState(null)
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveSaving, setLiveSaving] = useState(false)
  const [liveError, setLiveError] = useState('')

  // ── Load live settings on mount and when switching to live tab ──
  useEffect(() => {
    if (subTab === 'live') fetchLiveSettings()
  }, [subTab])

  function fetchLiveSettings() {
    setLiveLoading(true)
    api('/api/bsp-optimiser/settings')
      .then(d => { setLiveSettings(d); setLiveLoading(false) })
      .catch(() => setLiveLoading(false))
  }

  async function saveLiveSettings(patch) {
    setLiveSaving(true)
    setLiveError('')
    try {
      const updated = await api('/api/bsp-optimiser/settings', {
        method: 'POST',
        body: JSON.stringify(patch),
      })
      setLiveSettings(updated)
    } catch (e) {
      setLiveError('Save failed: ' + e.message)
    }
    setLiveSaving(false)
  }

  function toggleCountry(c) {
    setCountries(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  }

  async function runAnalysis() {
    setJobStatus('running')
    setJobResult(null)
    setJobError('')
    setJobId(null)
    try {
      const res = await api('/api/bsp-optimiser/run', {
        method: 'POST',
        body: JSON.stringify({
          date_from: dateFrom,
          date_to: dateTo,
          countries,
          contraction_threshold_pct: threshold,
          max_bsp: maxBsp,
        }),
      })
      if (!res.job_id) throw new Error(res.detail || 'No job ID returned')
      setJobId(res.job_id)
      pollRef.current = setInterval(() => pollJob(res.job_id), 2000)
    } catch (e) {
      setJobStatus('error')
      setJobError(e.message)
    }
  }

  async function pollJob(id) {
    try {
      const res = await api(`/api/bsp-optimiser/job/${id}`)
      if (res.status === 'done') {
        clearInterval(pollRef.current)
        setJobStatus('done')
        setJobResult(res.result)
      } else if (res.status === 'error') {
        clearInterval(pollRef.current)
        setJobStatus('error')
        setJobError(res.error || 'Unknown error')
      }
    } catch (e) {
      clearInterval(pollRef.current)
      setJobStatus('error')
      setJobError(e.message)
    }
  }

  useEffect(() => () => clearInterval(pollRef.current), [])

  function downloadCsv() {
    if (!jobResult?.runners) return
    const rows = jobResult.runners
    const headers = ['date', 'market_id', 'venue', 'race_time', 'distance', 'race_type',
      'runner_name', 'bsp', 'pre_off_ltp', 'contraction_pct', 'inplay_min', 'inplay_max', 'won']
    const csv = [headers.join(','),
      ...rows.map(r => headers.map(h => {
        const v = r[h] ?? ''
        return typeof v === 'string' && v.includes(',') ? `"${v}"` : v
      }).join(','))
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `bsp_analysis_${dateFrom}_${dateTo}.csv`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  const summary = jobResult?.summary || {}
  const bands = jobResult?.bsp_bands || []
  const runners = jobResult?.runners || []

  return (
    <div className="backtest-tab bt-wide">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>BSP Optimiser</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
            Pre-race back / in-running lay contraction strategy — analysis and live rule control
          </p>
        </div>
        {liveSettings && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 14px', borderRadius: 6,
            background: liveSettings.enabled ? '#16a34a22' : '#6b728022',
            border: `1px solid ${liveSettings.enabled ? '#16a34a44' : '#6b728044'}`,
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: liveSettings.enabled ? '#22c55e' : '#6b7280',
            }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: liveSettings.enabled ? '#22c55e' : '#6b7280' }}>
              {liveSettings.enabled ? 'Live Rule ACTIVE' : 'Live Rule OFF'}
            </span>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="sub-tabs" style={{ marginBottom: 20 }}>
        {[{ id: 'analysis', label: 'Analysis' }, { id: 'live', label: 'Live Rule Settings' }].map(t => (
          <button key={t.id} className={subTab === t.id ? 'active' : ''} onClick={() => setSubTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Analysis Sub-tab ── */}
      {subTab === 'analysis' && (
        <div>
          {/* Controls */}
          <div className="engine-section" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="engine-label">
                Date from
                <input type="date" value={dateFrom}
                  max={dateTo}
                  onChange={e => setDateFrom(e.target.value)}
                  style={{ display: 'block', marginTop: 4 }}
                />
              </label>
              <label className="engine-label">
                Date to
                <input type="date" value={dateTo}
                  min={dateFrom} max={new Date().toISOString().slice(0, 10)}
                  onChange={e => setDateTo(e.target.value)}
                  style={{ display: 'block', marginTop: 4 }}
                />
              </label>
              <div>
                <span className="engine-label" style={{ display: 'block', marginBottom: 4 }}>Countries</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['GB', 'IE', 'US', 'AU', 'ZA', 'FR'].map(c => (
                    <button key={c}
                      className={`btn-toggle ${countries.includes(c) ? 'active' : ''}`}
                      onClick={() => toggleCountry(c)}
                    >{c}</button>
                  ))}
                </div>
              </div>
              <label className="engine-label">
                Contraction threshold (%)
                <input type="number" value={threshold} min={1} max={50}
                  onChange={e => setThreshold(+e.target.value)}
                  style={{ display: 'block', marginTop: 4, width: 80 }}
                />
              </label>
              <label className="engine-label">
                Max BSP filter
                <input type="number" value={maxBsp} min={1} max={100}
                  onChange={e => setMaxBsp(+e.target.value)}
                  style={{ display: 'block', marginTop: 4, width: 80 }}
                />
              </label>
              <button
                className="btn btn-primary"
                onClick={runAnalysis}
                disabled={jobStatus === 'running' || countries.length === 0}
              >
                {jobStatus === 'running' ? 'Running...' : 'Run Analysis'}
              </button>
            </div>
          </div>

          {/* Progress / Error */}
          {jobStatus === 'running' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, color: '#6b7280', fontSize: 13 }}>
              <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
              Analysing markets from {dateFrom} to {dateTo}...
            </div>
          )}
          {jobStatus === 'error' && (
            <div className="alert alert-danger" style={{ marginBottom: 16 }}>{jobError}</div>
          )}

          {/* Results */}
          {jobStatus === 'done' && jobResult && (
            <div>
              {/* Summary cards */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                {[
                  { label: 'Days Analysed', value: summary.days_analysed ?? '—' },
                  { label: 'Markets', value: summary.markets_analysed ?? '—' },
                  { label: 'Favourites', value: summary.favourites_tracked ?? '—' },
                  { label: 'Qualified', value: summary.qualified_count ?? '—', highlight: true },
                  { label: 'Win Rate', value: summary.win_rate_pct != null ? summary.win_rate_pct.toFixed(1) + '%' : '—' },
                  { label: 'Avg Contraction', value: summary.avg_contraction_pct != null ? summary.avg_contraction_pct.toFixed(1) + '%' : '—' },
                  { label: 'Avg BSP', value: summary.avg_bsp != null ? summary.avg_bsp.toFixed(2) : '—' },
                ].map(({ label, value, highlight }) => (
                  <div key={label} style={{
                    padding: '12px 18px', borderRadius: 8, minWidth: 100,
                    background: highlight ? '#1d4ed822' : 'var(--card-bg, #1a1a2e)',
                    border: `1px solid ${highlight ? '#1d4ed844' : 'var(--border, #2a2a3e)'}`,
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? '#60a5fa' : 'var(--text, #e2e8f0)' }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* BSP band breakdown */}
              {bands.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>BSP Band Breakdown</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="bt-table" style={{ minWidth: 500 }}>
                      <thead>
                        <tr>
                          <th>BSP Band</th>
                          <th>Count</th>
                          <th>Qualified</th>
                          <th>Win Rate</th>
                          <th>Avg Contraction</th>
                          <th>Avg In-play Min</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bands.map((b, i) => (
                          <tr key={i}>
                            <td>{b.band}</td>
                            <td>{b.count}</td>
                            <td>{b.qualified}</td>
                            <td>{b.win_rate_pct != null ? b.win_rate_pct.toFixed(1) + '%' : '—'}</td>
                            <td>{b.avg_contraction_pct != null ? b.avg_contraction_pct.toFixed(1) + '%' : '—'}</td>
                            <td>{b.avg_inplay_min != null ? b.avg_inplay_min.toFixed(2) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Full runner table */}
              {runners.length > 0 && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
                      Runner Data ({runners.length} rows)
                    </h3>
                    <button className="btn btn-secondary btn-sm" onClick={downloadCsv}>
                      Download CSV
                    </button>
                  </div>
                  <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                    <table className="bt-table" style={{ minWidth: 800, fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Venue</th>
                          <th>Time</th>
                          <th>Distance</th>
                          <th>Type</th>
                          <th>Runner</th>
                          <th>BSP</th>
                          <th>Pre-off LTP</th>
                          <th>Contraction</th>
                          <th>In-play Min</th>
                          <th>In-play Max</th>
                          <th>Won</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runners.map((r, i) => (
                          <tr key={i}>
                            <td>{r.date}</td>
                            <td>{r.venue}</td>
                            <td>{r.race_time}</td>
                            <td>{r.distance || '—'}</td>
                            <td>{r.race_type || '—'}</td>
                            <td>{r.runner_name}</td>
                            <td>{r.bsp != null ? r.bsp.toFixed(2) : '—'}</td>
                            <td>{r.pre_off_ltp != null ? r.pre_off_ltp.toFixed(2) : '—'}</td>
                            <td style={{ color: r.contraction_pct >= threshold ? '#22c55e' : undefined }}>
                              {r.contraction_pct != null ? r.contraction_pct.toFixed(1) + '%' : '—'}
                            </td>
                            <td>{r.inplay_min != null ? r.inplay_min.toFixed(2) : '—'}</td>
                            <td>{r.inplay_max != null ? r.inplay_max.toFixed(2) : '—'}</td>
                            <td>{r.won == null ? '—' : r.won ? 'Yes' : 'No'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {runners.length === 0 && (
                <p style={{ color: '#6b7280', fontSize: 13 }}>No qualifying favourites found in this date range.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Live Rule Settings Sub-tab ── */}
      {subTab === 'live' && (
        <div>
          {liveLoading ? (
            <p style={{ color: '#6b7280', fontSize: 13 }}>Loading settings...</p>
          ) : !liveSettings ? (
            <p style={{ color: '#ef4444', fontSize: 13 }}>Could not load settings.</p>
          ) : (
            <div className="engine-section">
              {liveError && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{liveError}</div>}

              {/* Enable toggle */}
              <div className="engine-row" style={{ marginBottom: 16 }}>
                <label className="engine-label" style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                  <div style={{ position: 'relative', width: 40, height: 22 }}>
                    <input type="checkbox" checked={liveSettings.enabled}
                      onChange={e => saveLiveSettings({ enabled: e.target.checked })}
                      style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                    />
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                      borderRadius: 22, cursor: 'pointer',
                      background: liveSettings.enabled ? '#16a34a' : '#374151',
                      transition: 'background 0.2s',
                    }}
                      onClick={() => saveLiveSettings({ enabled: !liveSettings.enabled })}
                    >
                      <div style={{
                        position: 'absolute', height: 18, width: 18, borderRadius: '50%',
                        background: '#fff', top: 2,
                        left: liveSettings.enabled ? 20 : 2,
                        transition: 'left 0.2s',
                      }} />
                    </div>
                  </div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {liveSettings.enabled ? 'BSP Rule ENABLED' : 'BSP Rule DISABLED'}
                  </span>
                </label>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
                  When enabled, the engine monitors favourites after they go in-play and places a lay bet when the LTP contracts to the target.
                </p>
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
                <label className="engine-label">
                  Contraction threshold (%)
                  <input type="number" value={liveSettings.contraction_threshold_pct ?? 10}
                    min={1} max={50}
                    onChange={e => saveLiveSettings({ contraction_threshold_pct: +e.target.value })}
                    style={{ display: 'block', marginTop: 4, width: 80 }}
                    disabled={liveSaving}
                  />
                </label>
                <label className="engine-label">
                  Stake (pts)
                  <input type="number" value={liveSettings.stake_pts ?? 2}
                    min={0.5} max={50} step={0.5}
                    onChange={e => saveLiveSettings({ stake_pts: +e.target.value })}
                    style={{ display: 'block', marginTop: 4, width: 80 }}
                    disabled={liveSaving}
                  />
                </label>
                <label className="engine-label">
                  Max BSP
                  <input type="number" value={liveSettings.max_bsp ?? 10}
                    min={1} max={100}
                    onChange={e => saveLiveSettings({ max_bsp: +e.target.value })}
                    style={{ display: 'block', marginTop: 4, width: 80 }}
                    disabled={liveSaving}
                  />
                </label>
                <label className="engine-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={liveSettings.dry_run ?? true}
                    onChange={e => saveLiveSettings({ dry_run: e.target.checked })}
                    disabled={liveSaving}
                  />
                  Dry run mode
                </label>
              </div>

              {liveSaving && <span style={{ fontSize: 12, color: '#6b7280' }}>Saving...</span>}

              {/* Active candidates */}
              <div style={{ marginTop: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Active Candidates</h3>
                {(liveSettings.active_candidates || []).length === 0 ? (
                  <p style={{ fontSize: 12, color: '#6b7280' }}>No candidates registered. Candidates are set when eligible markets start in-play.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {liveSettings.active_candidates.map((c, i) => (
                      <div key={i} style={{
                        padding: '10px 14px', borderRadius: 6,
                        background: 'var(--card-bg, #1a1a2e)',
                        border: '1px solid var(--border, #2a2a3e)',
                        display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13,
                      }}>
                        <span><strong>{c.runner_name}</strong></span>
                        <span style={{ color: '#6b7280' }}>{c.venue} {c.race_time}</span>
                        <span>BSP proxy: <strong>{c.bsp_proxy?.toFixed(2) ?? '—'}</strong></span>
                        <span>Target: <strong>{c.target?.toFixed(2) ?? '—'}</strong></span>
                        <span style={{
                          color: c.status === 'monitoring' ? '#f59e0b' : c.status === 'placed' ? '#22c55e' : '#6b7280',
                          fontWeight: 600,
                        }}>{c.status ?? 'pending'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
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
  { id: 'bsp', label: 'BSP Optimiser' },
]

// ── Dashboard ──
function Dashboard() {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('live')
  const [settingsConfirmed, setSettingsConfirmed] = useState(
    () => localStorage.getItem('betSettingsConfirmed') === 'true'
  )
  const [settingsDirty, setSettingsDirty] = useState(false)
  const intervalRef = useRef(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInitialDate, setChatInitialDate] = useState(null)
  const [chatInitialMessage, setChatInitialMessage] = useState(null)

  // ── Network / reconnect state ──
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [wasOffline, setWasOffline] = useState(false)

  // ── Theme ──
  const [theme, setTheme] = useState(() => localStorage.getItem('chimera-theme') || 'dark')
  useEffect(() => {
    document.body.className = `theme-${theme}`
    localStorage.setItem('chimera-theme', theme)
  }, [theme])

  // ── Dry Run snapshot state (lifted for tab persistence) ──
  const [checkedMarkets, setCheckedMarkets] = useState(new Set())
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotResult, setSnapshotResult] = useState(null)
  const [snapshotHistory, setSnapshotHistory] = useState([])
  const [expandedSnapshotId, setExpandedSnapshotId] = useState(null)
  const [snapshotDetail, setSnapshotDetail] = useState(null)

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

  // ── Offline / online detection ──
  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false)
      setWasOffline(true)
    }
    const handleOnline = () => {
      setIsOnline(true)
      // Immediately re-sync state when connection restored
      fetchState()
      // Auto-hide the "back online" banner after 3 seconds
      setTimeout(() => setWasOffline(false), 3000)
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
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
  const handleToggleSignalOverround = async () => {
    await api('/api/engine/signal/overround', { method: 'POST' })
    fetchState()
  }
  const handleToggleSignalFieldSize = async () => {
    await api('/api/engine/signal/field-size', { method: 'POST' })
    fetchState()
  }
  const handleToggleSignalSteamGate = async () => {
    await api('/api/engine/signal/steam-gate', { method: 'POST' })
    fetchState()
  }
  const handleToggleSignalBandPerf = async () => {
    await api('/api/engine/signal/band-perf', { method: 'POST' })
    fetchState()
  }
  const handleToggleMarketOverlay = async () => {
    await api('/api/engine/market-overlay', { method: 'POST' })
    fetchState()
  }
  const handleToggleTop2Concentration = async () => {
    await api('/api/engine/top2-concentration', { method: 'POST' })
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
  const handleSetMarkUpliftStake = async (value) => {
    await api('/api/engine/mark-uplift-stake', {
      method: 'POST',
      body: JSON.stringify({ value }),
    })
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
  const handleSetKelly = async (patch) => {
    const current = {
      enabled: state.kelly_enabled ?? false,
      fraction: state.kelly_fraction ?? 0.25,
      bankroll: state.kelly_bankroll ?? 1000,
      edge_pct: state.kelly_edge_pct ?? 5,
      min_stake: state.kelly_min_stake ?? 0.5,
      max_stake: state.kelly_max_stake ?? 50,
    }
    await api('/api/engine/kelly', {
      method: 'POST',
      body: JSON.stringify({ ...current, ...patch }),
    })
    fetchState()
  }
  const handleSettingsChanged = () => {
    setSettingsDirty(true)
    setSettingsConfirmed(false)
    localStorage.removeItem('betSettingsConfirmed')
  }
  const handleSettingsConfirm = () => {
    setSettingsDirty(false)
    setSettingsConfirmed(true)
    localStorage.setItem('betSettingsConfirmed', 'true')
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
      {/* ── Network status banners ── */}
      {!isOnline && (
        <div className="network-banner network-banner--offline">
          ⚡ Connection lost — reconnecting… The engine is still running on the server.
        </div>
      )}
      {isOnline && wasOffline && (
        <div className="network-banner network-banner--restored">
          ✓ Connection restored
        </div>
      )}

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
            onClick={() => {
              if (tab === 'bet-settings' && settingsDirty && t.id !== 'bet-settings') {
                if (!window.confirm('You have unconfirmed Bet Settings changes. Leave without confirming?')) return
              }
              setTab(t.id)
            }}
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
            settingsConfirmed={settingsConfirmed}
          />
        )}
        {tab === 'dryrun' && (
          <LiveTab
            state={state}
            onStart={handleStart}
            onStop={handleStop}
            settingsConfirmed={settingsConfirmed}
            mode="dryrun"
            checkedMarkets={checkedMarkets} setCheckedMarkets={setCheckedMarkets}
            snapshotLoading={snapshotLoading} setSnapshotLoading={setSnapshotLoading}
            snapshotResult={snapshotResult} setSnapshotResult={setSnapshotResult}
            snapshotHistory={snapshotHistory} setSnapshotHistory={setSnapshotHistory}
            expandedSnapshotId={expandedSnapshotId} setExpandedSnapshotId={setExpandedSnapshotId}
            snapshotDetail={snapshotDetail} setSnapshotDetail={setSnapshotDetail}
          />
        )}
        {tab === 'backtest' && <BacktestTab />}
        {tab === 'strategy' && <StrategyTab openChat={openChat} />}
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
            onSetMarkUpliftStake={handleSetMarkUpliftStake}
            onSetProcessWindow={handleSetProcessWindow}
            onSetPointValue={handleSetPointValue}
            onSetKelly={handleSetKelly}
            onToggleSignalOverround={handleToggleSignalOverround}
            onToggleSignalFieldSize={handleToggleSignalFieldSize}
            onToggleSignalSteamGate={handleToggleSignalSteamGate}
            onToggleSignalBandPerf={handleToggleSignalBandPerf}
            onToggleMarketOverlay={handleToggleMarketOverlay}
            onToggleTop2Concentration={handleToggleTop2Concentration}
            confirmed={settingsConfirmed}
            onConfirm={handleSettingsConfirm}
            onSettingsChanged={handleSettingsChanged}
          />
        )}
        {tab === 'settings' && <SettingsTab theme={theme} setTheme={setTheme} />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'bsp' && <BspOptimiserTab />}
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
