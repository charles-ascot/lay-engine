import { useState, useEffect, useCallback } from "react";

// In production (Cloudflare Pages), point to Cloud Run backend
// In local dev, Vite proxy handles /api → localhost:8080
const API_BASE = import.meta.env.PROD
  ? "https://lay-engine-950990732577.europe-west2.run.app"
  : "";

// ── Rule descriptions ──
const RULES = [
  { id: "RULE 1", cond: "Fav odds < 2.0", action: "LAY fav @ £3", color: "#10b981" },
  { id: "RULE 2", cond: "Fav odds 2.0–5.0", action: "LAY fav @ £2", color: "#3b82f6" },
  { id: "RULE 3A", cond: "Fav > 5.0 & gap < 2", action: "£1 fav + £1 2nd fav", color: "#f59e0b" },
  { id: "RULE 3B", cond: "Fav > 5.0 & gap ≥ 2", action: "LAY fav @ £1", color: "#ef4444" },
];

function StatusBadge({ status }) {
  const colors = {
    RUNNING: { bg: "#052e16", text: "#4ade80", dot: "#22c55e" },
    STOPPED: { bg: "#1c1917", text: "#a8a29e", dot: "#78716c" },
    STARTING: { bg: "#172554", text: "#60a5fa", dot: "#3b82f6" },
    AUTH_FAILED: { bg: "#450a0a", text: "#fca5a5", dot: "#ef4444" },
  };
  const c = colors[status] || colors.STOPPED;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "4px 14px", borderRadius: 6, background: c.bg,
      fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: c.text, fontWeight: 600,
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%", background: c.dot,
        boxShadow: status === "RUNNING" ? `0 0 8px ${c.dot}` : "none",
        animation: status === "RUNNING" ? "pulse 2s infinite" : "none",
      }} />
      {status}
    </div>
  );
}

function Card({ title, children, accent }) {
  return (
    <div style={{
      background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 10,
      borderTop: accent ? `2px solid ${accent}` : "1px solid #1e1e1e",
      overflow: "hidden",
    }}>
      {title && (
        <div style={{
          padding: "12px 18px", borderBottom: "1px solid #1e1e1e",
          fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
          textTransform: "uppercase", color: "#525252",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {title}
        </div>
      )}
      <div style={{ padding: 18 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, sub, accent }) {
  return (
    <div>
      <div style={{
        fontSize: 11, color: "#525252", fontWeight: 600, letterSpacing: "0.05em",
        textTransform: "uppercase", marginBottom: 4, fontFamily: "'JetBrains Mono', monospace",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 28, fontWeight: 800, color: accent || "#e5e5e5",
        fontFamily: "'JetBrains Mono', monospace", lineHeight: 1,
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: "#525252", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BetRow({ bet }) {
  const isSuccess = bet.betfair_response?.status === "SUCCESS" || bet.betfair_response?.status === "DRY_RUN";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 80px 60px 70px 80px 90px",
      gap: 12, padding: "10px 0", borderBottom: "1px solid #141414",
      fontSize: 13, fontFamily: "'JetBrains Mono', monospace", alignItems: "center",
    }}>
      <div style={{ color: "#d4d4d4", fontWeight: 600 }}>{bet.runner_name}</div>
      <div style={{ color: "#737373" }}>{bet.price?.toFixed(2)}</div>
      <div style={{ color: "#e5e5e5", fontWeight: 700 }}>£{bet.size?.toFixed(2)}</div>
      <div style={{ color: "#ef4444", fontSize: 12 }}>-£{bet.liability?.toFixed(2)}</div>
      <div style={{
        fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4, textAlign: "center",
        background: isSuccess ? "#052e16" : "#450a0a",
        color: isSuccess ? "#4ade80" : "#fca5a5",
      }}>
        {bet.dry_run ? "DRY" : isSuccess ? "PLACED" : "FAILED"}
      </div>
      <div style={{ color: "#525252", fontSize: 11 }}>
        {bet.rule_applied?.replace("RULE_", "R").replace("_", " ").substring(0, 12)}
      </div>
    </div>
  );
}

function UpcomingRow({ market }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "70px 1fr 60px",
      gap: 12, padding: "8px 0", borderBottom: "1px solid #141414",
      fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ color: "#525252" }}>
        {market.race_time
          ? new Date(market.race_time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : "--:--"}
      </div>
      <div style={{ color: "#d4d4d4" }}>
        <span style={{ fontWeight: 600 }}>{market.venue}</span>
        <span style={{ color: "#525252", marginLeft: 8 }}>{market.market_name}</span>
      </div>
      <div style={{ color: "#737373", textAlign: "right", fontSize: 12 }}>
        {market.minutes_to_off?.toFixed(0)}m
      </div>
    </div>
  );
}

function ResultRow({ result }) {
  const ruleColor = result.rule_applied?.includes("RULE_1") ? "#10b981"
    : result.rule_applied?.includes("RULE_2") ? "#3b82f6"
    : result.rule_applied?.includes("RULE_3A") ? "#f59e0b"
    : result.rule_applied?.includes("RULE_3B") ? "#ef4444" : "#525252";

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "70px 1fr 100px 60px 60px",
      gap: 8, padding: "8px 0", borderBottom: "1px solid #141414",
      fontSize: 12, fontFamily: "'JetBrains Mono', monospace", alignItems: "center",
    }}>
      <div style={{ color: "#525252" }}>
        {result.race_time
          ? new Date(result.race_time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : ""}
      </div>
      <div>
        <span style={{ color: "#d4d4d4", fontWeight: 600 }}>{result.venue}</span>
        {result.favourite && (
          <span style={{ color: "#737373", marginLeft: 8 }}>
            Fav: {result.favourite.name} @ {result.favourite.odds?.toFixed(2)}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
        background: result.skipped ? "#1c1917" : `${ruleColor}15`,
        color: result.skipped ? "#78716c" : ruleColor, textAlign: "center",
      }}>
        {result.skipped ? "SKIP" : result.rule_applied?.match(/RULE_\w+/)?.[0] || "—"}
      </div>
      <div style={{ color: "#e5e5e5", textAlign: "right" }}>
        {result.total_stake > 0 ? `£${result.total_stake.toFixed(2)}` : "—"}
      </div>
      <div style={{ color: "#ef4444", textAlign: "right", fontSize: 11 }}>
        {result.total_liability > 0 ? `-£${result.total_liability.toFixed(2)}` : "—"}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin, error, loading }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(username, password);
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#050505", color: "#e5e5e5",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center",
    }}>
      <div style={{
        fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em",
        fontFamily: "'JetBrains Mono', monospace", marginBottom: 8,
      }}>
        <span style={{ color: "#525252" }}>CHIMERA</span>
        <span style={{ color: "#e5e5e5", marginLeft: 8 }}>LAY ENGINE</span>
      </div>
      <div style={{
        fontSize: 12, color: "#525252", marginBottom: 32,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        Betfair Login
      </div>
      <form onSubmit={handleSubmit} style={{
        background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 10,
        padding: 32, width: 380,
      }}>
        {error && (
          <div style={{
            padding: "8px 12px", marginBottom: 16, borderRadius: 6,
            background: "#450a0a", color: "#fca5a5", fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {error}
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <label style={{
            display: "block", fontSize: 11, fontWeight: 600,
            letterSpacing: "0.05em", textTransform: "uppercase",
            color: "#525252", marginBottom: 6,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 6,
              border: "1px solid #262626", background: "#141414",
              color: "#e5e5e5", fontSize: 14, outline: "none",
              fontFamily: "'JetBrains Mono', monospace",
              boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={{
            display: "block", fontSize: 11, fontWeight: 600,
            letterSpacing: "0.05em", textTransform: "uppercase",
            color: "#525252", marginBottom: 6,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 6,
              border: "1px solid #262626", background: "#141414",
              color: "#e5e5e5", fontSize: 14, outline: "none",
              fontFamily: "'JetBrains Mono', monospace",
              boxSizing: "border-box",
            }}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%", padding: "10px 0", borderRadius: 6,
            border: "none", background: "#052e16", color: "#4ade80",
            fontSize: 13, fontWeight: 700, letterSpacing: "0.05em",
            cursor: loading ? "not-allowed" : "pointer",
            fontFamily: "'JetBrains Mono', monospace",
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? "AUTHENTICATING..." : "LOGIN"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/state`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState(data);
      setError(null);
      if (data.authenticated === false) {
        setIsLoggedIn(false);
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [fetchState, isLoggedIn]);

  const handleLogin = async (username, password) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setIsLoggedIn(true);
        fetchState();
      } else {
        setLoginError(data.message || "Login failed");
      }
    } catch (e) {
      setLoginError("Cannot connect to backend: " + e.message);
    }
    setLoginLoading(false);
  };

  const toggleEngine = async () => {
    setLoading(true);
    try {
      const action = state?.status === "RUNNING" ? "stop" : "start";
      await fetch(`${API_BASE}/api/engine/${action}`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 500));
      await fetchState();
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const s = state?.summary || {};
  const isRunning = state?.status === "RUNNING";

  if (!isLoggedIn) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        error={loginError}
        loading={loginLoading}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#050505", color: "#e5e5e5" }}>
      {/* Header */}
      <div style={{
        padding: "16px 28px", borderBottom: "1px solid #1e1e1e",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            <span style={{ color: "#525252" }}>CHIMERA</span>
            <span style={{ color: "#e5e5e5", marginLeft: 6 }}>LAY ENGINE</span>
          </div>
          <StatusBadge status={state?.status || "—"} />
          <button
            onClick={async () => {
              const newMode = !state?.dry_run;
              const msg = newMode
                ? "Switch to DRY RUN mode? (no real bets)"
                : "Switch to LIVE mode? This will place REAL BETS with REAL MONEY!";
              if (!window.confirm(msg)) return;
              await fetch(`${API_BASE}/api/engine/dry-run`, { method: "POST" });
              await fetchState();
            }}
            style={{
              fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 4,
              border: "none", cursor: "pointer",
              background: state?.dry_run ? "#422006" : "#450a0a",
              color: state?.dry_run ? "#fbbf24" : "#fca5a5",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {state?.dry_run ? "DRY RUN" : "LIVE"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {state?.balance != null && (
            <div style={{
              fontSize: 13, color: "#737373",
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              BAL: <span style={{ color: "#e5e5e5", fontWeight: 700 }}>£{state.balance.toFixed(2)}</span>
            </div>
          )}
          <button
            onClick={toggleEngine}
            disabled={loading}
            style={{
              padding: "8px 20px", borderRadius: 6, border: "none",
              fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              background: isRunning ? "#450a0a" : "#052e16",
              color: isRunning ? "#fca5a5" : "#4ade80",
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? "..." : isRunning ? "■ STOP" : "▶ START"}
          </button>
          <button
            onClick={async () => {
              await fetch(`${API_BASE}/api/logout`, { method: "POST" });
              setIsLoggedIn(false);
              setState(null);
            }}
            style={{
              padding: "8px 16px", borderRadius: 6, border: "1px solid #262626",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              background: "transparent", color: "#525252",
            }}
          >
            LOGOUT
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div style={{
          padding: "8px 28px", background: "#450a0a", color: "#fca5a5",
          fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
        }}>
          Connection error: {error}
        </div>
      )}

      <div style={{ padding: 28, maxWidth: 1400, margin: "0 auto" }}>
        {/* Stats Row */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(5, 1fr)",
          gap: 16, marginBottom: 24,
        }}>
          <Card accent="#3b82f6">
            <Stat label="Markets Today" value={s.total_markets || 0} sub={`${s.processed || 0} processed`} />
          </Card>
          <Card accent="#10b981">
            <Stat label="Bets Placed" value={s.bets_placed || 0} accent="#4ade80" />
          </Card>
          <Card accent="#f59e0b">
            <Stat label="Total Staked" value={`£${(s.total_stake || 0).toFixed(2)}`} accent="#fbbf24" />
          </Card>
          <Card accent="#ef4444">
            <Stat label="Total Liability" value={`£${(s.total_liability || 0).toFixed(2)}`} accent="#f87171" />
          </Card>
          <Card accent="#8b5cf6">
            <Stat
              label="Last Scan"
              value={
                state?.last_scan
                  ? new Date(state.last_scan).toLocaleTimeString("en-GB", {
                      hour: "2-digit", minute: "2-digit", second: "2-digit",
                    })
                  : "—"
              }
            />
          </Card>
        </div>

        {/* Rules Reference */}
        <Card title="Active Rules">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            {RULES.map((r) => (
              <div
                key={r.id}
                style={{
                  padding: 12, borderRadius: 8, background: "#141414",
                  borderLeft: `3px solid ${r.color}`,
                }}
              >
                <div style={{
                  fontSize: 11, fontWeight: 700, color: r.color, marginBottom: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {r.id}
                </div>
                <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 6 }}>{r.cond}</div>
                <div style={{
                  fontSize: 13, fontWeight: 700, color: "#e5e5e5",
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {r.action}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Main Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          {/* Upcoming Races */}
          <Card title={`Upcoming Races (${state?.upcoming?.length || 0})`} accent="#3b82f6">
            <div style={{ maxHeight: 400, overflow: "auto" }}>
              {state?.upcoming?.length > 0 ? (
                state.upcoming.map((m) => <UpcomingRow key={m.market_id} market={m} />)
              ) : (
                <div style={{
                  color: "#525252", fontSize: 13,
                  fontFamily: "'JetBrains Mono', monospace",
                  padding: "20px 0", textAlign: "center",
                }}>
                  {state?.status === "RUNNING" ? "No upcoming races" : "Engine not running"}
                </div>
              )}
            </div>
          </Card>

          {/* Bets Placed Today */}
          <Card title={`Bets Placed Today (${state?.recent_bets?.length || 0})`} accent="#10b981">
            <div style={{ maxHeight: 400, overflow: "auto" }}>
              {state?.recent_bets?.length > 0 ? (
                <>
                  <div style={{
                    display: "grid", gridTemplateColumns: "1fr 80px 60px 70px 80px 90px",
                    gap: 12, padding: "0 0 8px", borderBottom: "1px solid #262626",
                    fontSize: 10, color: "#525252", fontWeight: 700,
                    letterSpacing: "0.05em",
                    fontFamily: "'JetBrains Mono', monospace",
                    textTransform: "uppercase",
                  }}>
                    <div>Runner</div><div>Odds</div><div>Stake</div>
                    <div>Liab.</div><div>Status</div><div>Rule</div>
                  </div>
                  {state.recent_bets.map((b, i) => (
                    <BetRow key={i} bet={b} />
                  ))}
                </>
              ) : (
                <div style={{
                  color: "#525252", fontSize: 13,
                  fontFamily: "'JetBrains Mono', monospace",
                  padding: "20px 0", textAlign: "center",
                }}>
                  No bets placed yet today
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Race Evaluations */}
        <div style={{ marginTop: 16 }}>
          <Card title={`Race Evaluations (${state?.recent_results?.length || 0})`} accent="#8b5cf6">
            <div style={{ maxHeight: 350, overflow: "auto" }}>
              {state?.recent_results?.length > 0 ? (
                <>
                  <div style={{
                    display: "grid", gridTemplateColumns: "70px 1fr 100px 60px 60px",
                    gap: 8, padding: "0 0 8px", borderBottom: "1px solid #262626",
                    fontSize: 10, color: "#525252", fontWeight: 700,
                    letterSpacing: "0.05em",
                    fontFamily: "'JetBrains Mono', monospace",
                    textTransform: "uppercase",
                  }}>
                    <div>Time</div><div>Race</div><div>Rule</div><div>Stake</div><div>Liab.</div>
                  </div>
                  {state.recent_results.map((r, i) => (
                    <ResultRow key={i} result={r} />
                  ))}
                </>
              ) : (
                <div style={{
                  color: "#525252", fontSize: 13,
                  fontFamily: "'JetBrains Mono', monospace",
                  padding: "20px 0", textAlign: "center",
                }}>
                  No evaluations yet
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Errors */}
        {state?.errors?.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Card title="Errors" accent="#ef4444">
              {state.errors.map((e, i) => (
                <div
                  key={i}
                  style={{
                    padding: "6px 0", borderBottom: "1px solid #141414",
                    fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                    color: "#fca5a5",
                  }}
                >
                  <span style={{ color: "#525252" }}>
                    {new Date(e.timestamp).toLocaleTimeString("en-GB")}
                  </span>{" "}
                  {e.message}
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
