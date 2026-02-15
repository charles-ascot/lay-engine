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

// ── Dashboard ──
function Dashboard() {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('history')
  const intervalRef = useRef(null)

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
  const handleLogout = async () => {
    await api('/api/logout', { method: 'POST' })
    window.location.reload()
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
        <div className="stats-row">
          <span>Markets: <strong>{s.total_markets || 0}</strong></span>
          <span>Processed: <strong>{s.processed || 0}</strong></span>
          <span>Bets: <strong>{s.bets_placed || 0}</strong></span>
          <span>Staked: <strong>£{(s.total_stake || 0).toFixed(2)}</strong></span>
          <span>Liability: <strong>£{(s.total_liability || 0).toFixed(2)}</strong></span>
        </div>
        {state.last_scan && (
          <p className="last-scan">
            Last scan: {new Date(state.last_scan).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* ── Tabs ── */}
      <nav className="tabs">
        {['history', 'bets', 'rules', 'errors'].map(t => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {/* ── Tab Content ── */}
      <div className="tab-content">
        {tab === 'history' && <HistoryTab />}
        {tab === 'bets' && <BetsTab bets={state.recent_bets} />}
        {tab === 'rules' && <RulesTab results={state.recent_results} />}
        {tab === 'errors' && <ErrorsTab errors={state.errors} />}
      </div>
    </div>
  )
}

// ── History Tab ──
function HistoryTab() {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [analysis, setAnalysis] = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [analysisDate, setAnalysisDate] = useState(null)

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

  const runAnalysis = async (date) => {
    setAnalysisLoading(true)
    setAnalysisError('')
    setAnalysis(null)
    setAnalysisDate(date)
    try {
      const res = await api('/api/sessions/analyse', {
        method: 'POST',
        body: JSON.stringify({ date }),
      })
      if (res.points) {
        setAnalysis(res.points)
      } else {
        setAnalysisError(res.message || 'Analysis failed')
      }
    } catch (e) {
      setAnalysisError('Failed to connect to analysis service')
    }
    setAnalysisLoading(false)
  }

  if (loading) return <p className="empty">Loading sessions...</p>

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
          <SnapshotButton tableId="session-bets-table" filename={`session_${detail.session_id}`} />
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
            <p className="empty">No bets in this session.</p>
          ) : (
            <table id="session-bets-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Market ID</th>
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
                    <td title={b.market_id}>...{b.market_id?.slice(-8)}</td>
                    <td>{b.runner_name}</td>
                    <td>{b.price?.toFixed(2)}</td>
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

  // Get unique dates from sessions for analysis buttons
  const dates = [...new Set(sessions.map(s => s.date))]

  // ── List View ──
  return (
    <div>
      <div className="tab-toolbar">
        <h2>Session History</h2>
        {dates.length > 0 && (
          <button
            className="btn btn-analysis"
            disabled={analysisLoading}
            onClick={() => runAnalysis(dates[0])}
          >
            {analysisLoading ? 'Analysing...' : `Analysis ${dates[0]}`}
          </button>
        )}
      </div>

      {/* ── Analysis Panel ── */}
      {analysisLoading && (
        <div className="analysis-panel">
          <div className="analysis-loading">Running AI analysis on {analysisDate}...</div>
        </div>
      )}
      {analysisError && (
        <div className="analysis-panel analysis-error">
          <strong>Analysis failed:</strong> {analysisError}
        </div>
      )}
      {analysis && (
        <div className="analysis-panel">
          <div className="analysis-header">
            <strong>AI Analysis — {analysisDate}</strong>
            <button className="btn-sm" onClick={() => setAnalysis(null)}>Dismiss</button>
          </div>
          <ul className="analysis-points">
            {analysis.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      )}

      {sessions.length === 0 ? (
        <p className="empty">No sessions recorded yet. Start the engine to create one.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Mode</th>
              <th>Date</th>
              <th>Start</th>
              <th>Stop</th>
              <th>Bets</th>
              <th>Stake</th>
              <th>Liability</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr
                key={s.session_id}
                className="session-row"
                onClick={() => setSelectedId(s.session_id)}
              >
                <td>
                  <span className={`badge ${s.mode === 'LIVE' ? 'badge-live' : 'dry-run'}`}>
                    {s.mode}
                  </span>
                </td>
                <td>{s.date}</td>
                <td>{new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                <td>{s.stop_time
                  ? new Date(s.stop_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : '---'}</td>
                <td>{s.summary?.total_bets || 0}</td>
                <td>£{(s.summary?.total_stake || 0).toFixed(2)}</td>
                <td>£{(s.summary?.total_liability || 0).toFixed(2)}</td>
                <td>
                  <span className={`badge badge-${s.status.toLowerCase()}`}>
                    {s.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Bets Tab ──
function BetsTab({ bets }) {
  if (!bets || bets.length === 0) {
    return <p className="empty">No bets placed yet today.</p>
  }
  const fname = `chimera_bets_${new Date().toISOString().slice(0, 10)}`
  return (
    <div>
      <div className="tab-toolbar">
        <h2>Recent Bets</h2>
        <SnapshotButton tableId="bets-table" filename={fname} />
      </div>
      <table id="bets-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market ID</th>
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
              <td title={b.market_id}>...{b.market_id?.slice(-8)}</td>
              <td>{b.runner_name}</td>
              <td>{b.price?.toFixed(2)}</td>
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
      <div className="tab-toolbar bottom">
        <SnapshotButton tableId="bets-table" filename={fname} />
      </div>
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
