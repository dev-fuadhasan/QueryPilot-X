"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Database, Eye, EyeOff, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Table2 } from "lucide-react";

type Project = { id: string; name: string };
type Table = { name: string; columns: string[] };
type Session = {
  connected: boolean;
  configured: boolean;
  oauthEnabled: boolean;
  projectName: string;
  projectRef: string;
  projects: Project[];
  mode: "oauth" | "postgres" | null;
};

type Screen = "home" | "setup" | "dashboard";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [manual, setManual] = useState(false);
  const [projectRef, setProjectRef] = useState("");
  const [databaseUri, setDatabaseUri] = useState("");
  const [showUri, setShowUri] = useState(false);
  const [tables, setTables] = useState<Table[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [error, setError] = useState("");

  async function loadSession() {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load the connection status.");
    const data: Session = await response.json();
    setSession(data);
    setProjectRef(data.projectRef || data.projects[0]?.id || "");
    return data;
  }

  async function loadTables() {
    setLoadingTables(true);
    try {
      const response = await fetch("/api/tables", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Cannot load tables.");
      setTables(data.tables || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cannot load tables.");
    } finally {
      setLoadingTables(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const message = params.get("error");
    if (message) setError(message);

    loadSession().then(data => {
      if (data.connected) {
        setScreen("dashboard");
        void loadTables();
      } else if (data.projects.length || params.has("setup")) {
        setScreen("setup");
        setManual(!data.projects.length);
      }
    }).catch(() => setError("Cannot load your session. Check the server settings."));

    if (params.toString()) window.history.replaceState({}, "", "/");
  }, []);

  function beginSetup() {
    if (!session?.configured) {
      setError("Add SESSION_SECRET to .env.local before connecting.");
      return;
    }
    setError("");
    setManual(!session.oauthEnabled && !session.projects.length);
    setScreen("setup");
  }

  async function connectProject() {
    if (!projectRef) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/projects/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectRef })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect the project.");
      await loadSession();
      setScreen("dashboard");
      await loadTables();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function connectManually(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!databaseUri.trim()) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: databaseUri.trim() })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect to the database.");
      setDatabaseUri("");
      await loadSession();
      setScreen("dashboard");
      await loadTables();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/disconnect", { method: "POST" });
      if (!response.ok) throw new Error("Could not disconnect.");
      setTables([]);
      await loadSession();
      setScreen("home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }

  const totalColumns = tables.reduce((total, table) => total + table.columns.length, 0);

  return (
    <div className="app">
      {screen !== "dashboard" && (
        <header className="top-brand"><div className="brand-mark"><Database size={19}/></div><span>Smart<strong>Data</strong></span></header>
      )}

      {!session && <div className="loading-screen"><Database size={30}/><p>Loading your workspace...</p></div>}

      {session && screen === "home" && (
        <main className="welcome">
          <div className="hero-icon"><Database size={29}/></div>
          <div className="eyebrow">SMART DATA ANALYSIS & VISUALIZATION</div>
          <h1>Your data,<br/><span>connected.</span></h1>
          <p>Connect your Supabase database and get your workspace ready.</p>
          <button className="primary welcome-button" onClick={beginSetup}>
            <Database size={18}/> Connect your database <ArrowRight size={17}/>
          </button>
          <div className="hint"><ShieldCheck size={15}/> Secure connection with Supabase</div>
        </main>
      )}

      {session && screen === "setup" && (
        <main className="setup">
          <button className="back" onClick={() => { setError(""); setScreen(session.connected ? "dashboard" : "home"); }}><ArrowLeft size={15}/> Back</button>
          <div className="setup-icon"><Database size={25}/></div>
          <h1>{!manual && session.projects.length ? "Choose your project" : "Connect your database"}</h1>
          <p className="muted">{!manual && session.projects.length ? "Select the Supabase project you want to connect." : "Use Supabase OAuth or a read-only PostgreSQL connection string."}</p>

          {!manual && !session.projects.length && session.oauthEnabled && (
            <button className="primary full" onClick={() => window.location.assign("/api/auth/start")}>
              <Database size={18}/> Authorize with Supabase <ArrowRight size={17}/>
            </button>
          )}

          {!manual && session.projects.length > 0 && (
            <div className="project-list">
              <div className="field-title">AUTHORIZED PROJECTS</div>
              {session.projects.map(project => (
                <button key={project.id} className={"project " + (projectRef === project.id ? "active" : "")} onClick={() => setProjectRef(project.id)}>
                  <Database size={18}/>
                  <span><strong>{project.name}</strong><small>{project.id}</small></span>
                  {projectRef === project.id && <Check size={16}/>}
                </button>
              ))}
              <button className="primary full" disabled={!projectRef || busy} onClick={connectProject}>
                {busy ? "Connecting..." : "Connect selected project"}<ArrowRight size={17}/>
              </button>
            </div>
          )}

          {manual && (
            <form onSubmit={connectManually} className="connect-form">
              <label htmlFor="database-uri">PostgreSQL connection string</label>
              <div className="uri-input">
                <input id="database-uri" type={showUri ? "text" : "password"} value={databaseUri}
                  onChange={event => setDatabaseUri(event.target.value)}
                  placeholder="postgresql://user.project:password@...pooler.supabase.com:5432/postgres"
                  autoComplete="off" spellCheck={false} required/>
                <button type="button" aria-label={showUri ? "Hide connection string" : "Show connection string"} onClick={() => setShowUri(!showUri)}>
                  {showUri ? <EyeOff size={17}/> : <Eye size={17}/>}
                </button>
              </div>
              <button className="primary full" disabled={!databaseUri.trim() || busy} type="submit">
                <LockKeyhole size={16}/>{busy ? "Verifying connection..." : "Connect securely"}<ArrowRight size={17}/>
              </button>
            </form>
          )}

          {session.oauthEnabled && (
            <button className="text-button" type="button" onClick={() => {
              if (manual && !session.projects.length) window.location.assign("/api/auth/start");
              else setManual(!manual);
            }}>
              {manual ? session.projects.length ? "Use authorized projects" : "Connect using Supabase OAuth" : "Use a PostgreSQL connection string"}
              <ArrowRight size={15}/>
            </button>
          )}

          <div className="safe-note"><ShieldCheck size={17}/><span>Sessions are encrypted. Use a read-only database account when connecting manually.</span></div>
          <a className="help-link" href="https://supabase.com/docs/guides/database/connecting-to-postgres" target="_blank" rel="noreferrer">Where do I find my connection string?</a>
        </main>
      )}

      {session && screen === "dashboard" && (
        <div className="workspace">
          <header className="workspace-header">
            <div className="brand-inline"><div className="brand-mark"><Database size={18}/></div>Smart<strong>Data</strong></div>
            <div className="header-actions">
              <span className="connection-status"><i/>{session.projectName || "Supabase project"}</span>
              <button className="small-button" onClick={() => { setManual(session.mode === "postgres"); setScreen("setup"); }}>Switch</button>
              <button className="icon-button" title="Disconnect" aria-label="Disconnect" disabled={busy} onClick={disconnect}><LogOut size={18}/></button>
            </div>
          </header>
          <div className="workspace-body">
            <section className="main-panel">
              <div className="panel-label">DATABASE WORKSPACE</div>
              <div className="connected-hero"><div className="connected-icon"><Check size={26}/></div><h1>Database connected</h1><p>Your Supabase project is ready for the analysis module.</p></div>
              <div className="table-header"><div><Table2 size={18}/><h2>Available tables</h2><span>{tables.length}</span></div><button className="small-button" disabled={loadingTables} onClick={loadTables}><RefreshCw size={14}/> Refresh</button></div>
              {loadingTables ? <p className="empty-table">Reading public tables...</p> : tables.length ? (
                <div className="table-grid">{tables.map(table => (
                  <div className="table-card" key={table.name}><div><Table2 size={17}/><strong>{table.name}</strong></div><small>{table.columns.length} columns</small></div>
                ))}</div>
              ) : <p className="empty-table">No readable tables found.</p>}
            </section>
            <aside className="details-panel">
              <div className="aside-heading"><Database size={20}/><h2>Connection details</h2></div>
              <div className="detail"><span>Project</span><strong>{session.projectName || "Supabase project"}</strong></div>
              <div className="detail"><span>Project reference</span><strong className="reference">{session.projectRef || "Not selected"}</strong></div>
              <div className="detail"><span>Connection</span><strong>{session.mode === "oauth" ? "Supabase OAuth" : "PostgreSQL"}</strong></div>
              <div className="detail"><span>Public tables</span><strong>{tables.length}</strong></div>
              <div className="detail"><span>Columns</span><strong>{totalColumns}</strong></div>
              <div className="detail"><span>Access</span><strong className="read-only"><ShieldCheck size={14}/> Read only</strong></div>
              <div className="aside-foot"><LockKeyhole size={15}/> Database credentials are not shown in the browser.</div>
            </aside>
          </div>
        </div>
      )}

      {error && <div className="error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Close message">×</button></div>}
      {screen !== "dashboard" && <div className="footer">SMART DATA <span>·</span> SECURE BY DESIGN</div>}
    </div>
  );
}
