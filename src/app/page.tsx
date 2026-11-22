"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BarChart3, Bell, Check, LockKeyhole, LogOut, ShieldCheck, ShieldAlert } from "lucide-react";
import type { Table } from "@features/smart_data_analysis_and_visualization/components/DatasetsPanel";
import DailyAnalysisDashboard from "@features/daily_data_analysis_and_notification/components/DailyAnalysisDashboard";
import FraudDetectionDashboard from "@features/fraud_detection_and_notification/components/FraudDetectionDashboard";
import SmartWorkspace from "@features/smart_data_analysis_and_visualization/components/SmartWorkspace";
import LandingPage from "@/components/LandingPage";

type Project = { id: string; name: string };
type Session = {
  connected: boolean;
  configured: boolean;
  oauthEnabled: boolean;
  aiEnabled: boolean;
  projectName: string;
  projectRef: string;
  projects: Project[];
  mode: "oauth" | "postgres" | null;
};

type Screen = "home" | "setup" | "dashboard" | "daily-analysis" | "fraud-detection";

function SupabaseMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M13.5 2.1c.35-.48 1.11-.23 1.11.36v8.17h5.7c.54 0 .83.64.47 1.05l-9.87 10.2c-.39.42-1.1.14-1.1-.43v-8.12H4.1c-.54 0-.83-.64-.47-1.05L13.5 2.1Z" fill="#3ECF8E"/>
      <path d="M9.81 13.33h4.8v-2.7h-4.8v2.7Z" fill="#239B69" opacity=".45"/>
    </svg>
  );
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [projectRef, setProjectRef] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [error, setError] = useState("");

  async function loadSession() {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load connection status.");
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
      if (!response.ok) throw new Error(data.error || "Cannot load datasets.");
      setTables(data.tables || []);
    } catch (err) {
      setTables([]);
      setError(err instanceof Error ? err.message : "Cannot load datasets.");
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
      }
    }).catch(() => setError("Cannot load your session. Check server settings."));

    if (params.toString()) window.history.replaceState({}, "", "/");
  }, []);

  function beginSetup() {
    setError("");
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

  return (
    <div className={"app" + (screen === "home" || screen === "setup" ? " auth-app" : "")}>
      {(screen === "home" || screen === "setup") && <header className="top-brand"><img className="brand-logo" src="/querypilot-logo.svg" alt="QueryPilot logo" width={36} height={36}/><span>Query<strong>Pilot</strong></span></header>}

      {!session && <div className="loading-screen"><img className="loading-logo" src="/querypilot-logo.svg" alt="QueryPilot logo" width={54} height={54}/><p>Loading QueryPilot...</p></div>}

      {session && (screen === "home" || screen === "setup") && (
        <main className="welcome login-landing" aria-label="QueryPilot sign in">
          <section className="login-media" aria-label="QueryPilot introduction">
            <div className="login-video-wrap">
              <video
                className="login-video"
                src="https://d2ol7oe51mr4n9.cloudfront.net/user_3MAuXQv43Z5PqLIskwD8gbspT5a/af68d7c1-e581-4c94-af9e-e9141fc27d57.mp4"
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                disablePictureInPicture
                aria-label="QueryPilot motion graphic"
              />
            </div>
            <div className="login-media-caption"><span className="login-media-dot" /> A clearer view of your business data</div>
          </section>

          <section className="login-content" aria-live="polite">
            {screen === "home" ? (
              <div className="login-copy">
                <div className="login-kicker"><span className="login-kicker-line" /> THE INTELLIGENT DATA WORKSPACE</div>
                <h1>Make data<br/><span>make sense.</span></h1>
                <p>From raw numbers to confident decisions. Analyze your data, stay ahead of daily changes, and monitor what matters — all in one place.</p>
                <div className="login-features">
                  <span><BarChart3 size={16}/> Smart analytics</span>
                  <span><Bell size={16}/> Daily insights</span>
                  <span><ShieldCheck size={16}/> Secure monitoring</span>
                </div>
                <button type="button" className="primary login-cta" onClick={beginSetup}>
                  Get started <ArrowRight size={19}/>
                </button>
                <div className="login-footnote"><LockKeyhole size={14}/> Secure access, powered by Supabase</div>
              </div>
            ) : (
              <div className="login-copy login-setup-copy">
                <button className="back login-inline-back" type="button" onClick={() => { setError(""); setScreen(session.connected ? "dashboard" : "home"); }}>
                  <ArrowLeft size={15}/> Back
                </button>
                <div className="login-supabase-identity">
                  <div className="login-supabase-logo"><SupabaseMark size={27}/></div>
                  <span>SUPABASE CONNECTION</span>
                </div>
                <h1 className="login-setup-title">{session.projects.length ? "Choose your project." : "Connect with Supabase."}</h1>
                <p className="login-setup-description">
                  {session.projects.length
                    ? "Your Supabase account is authorized. Select the project you want to work with."
                    : "Sign in securely to your Supabase account to view and connect your authorized projects."}
                </p>

                {session.projects.length > 0 ? (
                  <div className="login-project-picker">
                    <div className="field-title">YOUR SUPABASE PROJECTS</div>
                    <div className="login-project-list" role="group" aria-label="Select a Supabase project">
                      {session.projects.map(project => (
                        <button
                          type="button"
                          key={project.id}
                          className={"project " + (projectRef === project.id ? "active" : "")}
                          aria-pressed={projectRef === project.id}
                          onClick={() => setProjectRef(project.id)}
                        >
                          <SupabaseMark size={18}/>
                          <span><strong>{project.name}</strong><small>{project.id}</small></span>
                          {projectRef === project.id && <Check size={17}/>}
                        </button>
                      ))}
                    </div>
                    <button className="primary login-cta login-connect-button" type="button" disabled={!projectRef || busy} onClick={connectProject}>
                      {busy ? "Connecting..." : "Connect selected project"} <ArrowRight size={18}/>
                    </button>
                  </div>
                ) : (
                  <div className="login-auth-action">
                    <button
                      className="primary login-cta login-connect-button"
                      type="button"
                      disabled={!session.configured || !session.oauthEnabled}
                      onClick={() => window.location.assign("/api/auth/start")}
                    >
                      <SupabaseMark size={22}/> Continue with Supabase <ArrowRight size={18}/>
                    </button>
                    {(!session.configured || !session.oauthEnabled) && (
                      <p className="login-config-warning" role="status">Supabase sign-in is not configured on this deployment. Check the OAuth and session environment variables.</p>
                    )}
                  </div>
                )}
                <div className="login-footnote"><LockKeyhole size={14}/> Encrypted session · Supabase authorization</div>
              </div>
            )}
            <div className="login-bottom-note"><span>ANALYZE</span><span className="login-separator"/><span>UNDERSTAND</span><span className="login-separator"/><span>ACT</span></div>
          </section>
        </main>
      )}

      {session && screen === "home" && <LandingPage onStart={beginSetup} />}

      {session && (screen === "dashboard" || screen === "daily-analysis" || screen === "fraud-detection") && (
        <div className="workspace">
          <header className="workspace-header">
            <div className="brand-inline"><img className="brand-logo" src="/querypilot-logo.svg" alt="QueryPilot logo" width={36} height={36}/>Query<strong>Pilot</strong></div>
            <nav className="header-modules" aria-label="Workspace modules">
              <span className="header-workspace-label">WORKSPACE</span>
              <button type="button" className={"header-module " + (screen === "dashboard" ? "selected" : "")} aria-current={screen === "dashboard" ? "page" : undefined} onClick={() => setScreen("dashboard")}><BarChart3 size={16}/> Smart Dashboard and Analysis</button>
              <button type="button" className={"header-module " + (screen === "daily-analysis" ? "selected" : "")} aria-current={screen === "daily-analysis" ? "page" : undefined} onClick={() => setScreen("daily-analysis")}><Bell size={16}/> Daily analysis</button>
              <button type="button" className={"header-module " + (screen === "fraud-detection" ? "selected" : "")} aria-current={screen === "fraud-detection" ? "page" : undefined} onClick={() => setScreen("fraud-detection")}><ShieldAlert size={16}/> Fraud detection</button>
            </nav>
            <div className="header-actions"><span className="connection-status"><i/>{session.projectName || "Supabase project"}</span>
              <button className="small-button" onClick={() => { setScreen("setup"); }}>Switch</button>
              <button className="icon-button" title="Disconnect" aria-label="Disconnect" disabled={busy} onClick={disconnect}><LogOut size={18}/></button>
            </div>
          </header>
          <div className="workspace-body">
            <main className="main-panel smart-main" style={{display:screen === "dashboard" ? undefined : "none"}}>
              <SmartWorkspace tables={tables} loading={loadingTables} onRefresh={() => void loadTables()} projectName={session.projectName || "Supabase project"} projectRef={session.projectRef || "connected-project"} aiEnabled={session.aiEnabled}/>
            </main>
            {screen === "daily-analysis" && <main className="main-panel"><DailyAnalysisDashboard onBack={() => setScreen("dashboard")}/></main>}
            {screen === "fraud-detection" && <main className="main-panel"><FraudDetectionDashboard/></main>}
          </div>
        </div>
      )}

      {error && <div className="error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Close message">×</button></div>}
      {(screen === "home" || screen === "setup") && <div className="footer">QUERY PILOT <span>·</span> DATA MADE CLEAR</div>}
    </div>
  );
}
