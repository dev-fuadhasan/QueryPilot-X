"use client";

import React, { useState, useEffect } from "react";
import {
  User,
  Mail,
  ShieldCheck,
  ShieldAlert,
  Database,
  Cloud,
  CheckCircle2,
  AlertTriangle,
  Send,
  Save,
  RefreshCw,
  Key,
  Lock,
  ArrowLeft,
  Bell,
  Sparkles,
  ExternalLink,
  Sliders
} from "lucide-react";

interface ProfileSettingsPanelProps {
  onBack?: () => void;
  onNavigate?: (screen: string) => void;
}

export default function ProfileSettingsPanel({ onBack, onNavigate }: ProfileSettingsPanelProps) {
  // Session & Storage state
  const [sessionData, setSessionData] = useState<any>(null);
  const [storageStatus, setStorageStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Email Notification configuration state
  const [recipientEmail, setRecipientEmail] = useState("");
  const [fraudAlertsEnabled, setFraudAlertsEnabled] = useState(true);
  const [dailyAnalysisEnabled, setDailyAnalysisEnabled] = useState(true);
  const [minSeverity, setMinSeverity] = useState<"CRITICAL" | "HIGH" | "MEDIUM">("HIGH");
  const [hasApiKey, setHasApiKey] = useState(true);

  // UI status feedback
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Load session, storage, and email preferences
  useEffect(() => {
    async function loadAll() {
      setLoading(true);
      try {
        const [sessionRes, storageRes, emailRes] = await Promise.all([
          fetch("/api/session", { cache: "no-store" }),
          fetch("/api/storage/status", { cache: "no-store" }),
          fetch("/api/notifications/email", { cache: "no-store" }),
        ]);

        if (sessionRes.ok) {
          const sess = await sessionRes.json();
          setSessionData(sess);
        }

        if (storageRes.ok) {
          const stor = await storageRes.json();
          setStorageStatus(stor);
        }

        if (emailRes.ok) {
          const mail = await emailRes.json();
          if (mail.settings) {
            setRecipientEmail(mail.settings.recipientEmail || "");
            setFraudAlertsEnabled(mail.settings.fraudAlertsEnabled ?? true);
            setDailyAnalysisEnabled(mail.settings.dailyAnalysisEnabled ?? true);
            setMinSeverity(mail.settings.minSeverity || "HIGH");
          }
          setHasApiKey(Boolean(mail.hasApiKey));
        }
      } catch (err) {
        console.warn("Failed loading profile settings:", err);
      } finally {
        setLoading(false);
      }
    }

    void loadAll();
  }, []);

  // Save email notification preferences
  const handleSavePreferences = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setStatusNotice(null);

    try {
      const res = await fetch("/api/notifications/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-settings",
          recipientEmail: recipientEmail.trim(),
          fraudAlertsEnabled,
          dailyAnalysisEnabled,
          minSeverity,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setStatusNotice({
          type: "success",
          message: "Notification preferences saved successfully!",
        });
        setTimeout(() => setStatusNotice(null), 5000);
      } else {
        setStatusNotice({
          type: "error",
          message: data.error || "Failed to save notification preferences.",
        });
      }
    } catch {
      setStatusNotice({
        type: "error",
        message: "Network error saving notification settings.",
      });
    } finally {
      setSaving(false);
    }
  };

  // Dispatch live test email via Resend
  const handleSendTestEmail = async () => {
    if (!recipientEmail || !recipientEmail.includes("@")) {
      setStatusNotice({
        type: "error",
        message: "Please enter a valid email address before sending a test notification.",
      });
      return;
    }

    setSendingTest(true);
    setStatusNotice(null);

    try {
      const res = await fetch("/api/notifications/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          recipientEmail: recipientEmail.trim(),
        }),
      });

      const data = await res.json();
      if (data.success) {
        setStatusNotice({
          type: "success",
          message: `Verification test email sent to ${recipientEmail.trim()}! Please check your inbox.`,
        });
      } else {
        setStatusNotice({
          type: "error",
          message: data.error || "Failed to send verification email.",
        });
      }
    } catch {
      setStatusNotice({
        type: "error",
        message: "Network error sending test email.",
      });
    } finally {
      setSendingTest(false);
    }
  };

  return (
    <div className="datasets-panel" style={{ paddingBottom: "60px" }}>
      {/* NAVIGATION & EYEBROW */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
        <div className="section-eyebrow" style={{ margin: 0 }}>
          USER PROFILE & ALERT AUTOMATION
        </div>
        {onBack && (
          <button
            type="button"
            className="secondary-button"
            onClick={onBack}
            style={{ padding: "6px 12px", fontSize: "11px" }}
          >
            <ArrowLeft size={13} /> Back to Dashboard
          </button>
        )}
      </div>

      {/* SECTION HEADING */}
      <div className="section-heading">
        <div>
          <h1>Profile & Notification Settings</h1>
          <p>
            Manage your connected workspace identity, Supabase security status, and automated email alert channels.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <span
            className="connection-status"
            style={{
              background: "#f0fdf4",
              borderColor: "#bbf7d0",
              color: "#15803d",
              fontWeight: 600,
            }}
          >
            <i style={{ background: "#22c55e" }} />
            {sessionData?.projectName || "Connected Workspace"}
          </span>
        </div>
      </div>

      {/* STATUS NOTICES */}
      {statusNotice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            background: statusNotice.type === "success" ? "#f0fdf4" : "#fef2f2",
            border: `1px solid ${statusNotice.type === "success" ? "#bbf7d0" : "#fecaca"}`,
            color: statusNotice.type === "success" ? "#166534" : "#991b1b",
            padding: "14px 18px",
            borderRadius: "10px",
            marginBottom: "24px",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {statusNotice.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>{statusNotice.message}</span>
          </div>
          <button
            onClick={() => setStatusNotice(null)}
            style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontSize: "16px" }}
          >
            ×
          </button>
        </div>
      )}

      {/* TOP STAT METRIC CARDS */}
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="stat-card">
          <User size={20} />
          <span>Active Identity</span>
          <strong style={{ fontSize: "16px", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
            {sessionData?.projectName || "PostgreSQL Client"}
          </strong>
          <div className="stat-connected">
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
            Mode: {sessionData?.mode === "oauth" ? "Supabase OAuth" : "Direct Database"}
          </div>
        </div>

        <div className="stat-card">
          <Mail size={20} style={{ color: recipientEmail ? "#2563eb" : "#94a3b8" }} />
          <span>Email Alert Channel</span>
          <strong style={{ fontSize: "16px", color: recipientEmail ? "#1d4ed8" : "#64748b", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
            {recipientEmail || "Not Configured"}
          </strong>
          <div className="stat-connected" style={{ color: recipientEmail ? "#15803d" : "#ea580c" }}>
            {recipientEmail ? "Active & Listening" : "Action Required"}
          </div>
        </div>

        <div className="stat-card">
          <Cloud size={20} />
          <span>Cloud Storage Subsystem</span>
          <strong style={{ fontSize: "16px" }}>
            {storageStatus?.configured ? "querypilotx-storage" : "Local Staging"}
          </strong>
          <div className="stat-connected" style={{ color: storageStatus?.hasServiceRoleKey ? "#15803d" : "#64748b" }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: storageStatus?.hasServiceRoleKey ? "#22c55e" : "#cbd5e1", display: "inline-block" }} />
            {storageStatus?.hasServiceRoleKey ? "Private Service Role Active" : "Standard Key"}
          </div>
        </div>
      </div>

      {/* MAIN TWO-COLUMN SETTINGS SECTION */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 0.9fr)", gap: "20px", alignItems: "start" }}>
        
        {/* LEFT COLUMN: EMAIL ALERT ACTIVATION */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #eaedf0",
            borderRadius: "14px",
            padding: "26px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "10px",
                background: "#eff6ff",
                color: "#2563eb",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid #bfdbfe",
              }}
            >
              <Bell size={18} />
            </div>
            <div>
              <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
                Automated Email Alert Dispatch
              </h2>
              <p style={{ margin: 0, fontSize: "11px", color: "#64748b" }}>
                Deliver real-time security alerts and analytics digests directly to client stakeholders.
              </p>
            </div>
          </div>

          <hr style={{ border: 0, borderTop: "1px solid #f1f5f9", margin: "18px 0" }} />

          <form onSubmit={handleSavePreferences} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            {/* EMAIL INPUT */}
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                Recipient Client Email Address <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <div style={{ display: "flex", gap: "10px" }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <Mail
                    size={16}
                    style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }}
                  />
                  <input
                    type="email"
                    required
                    placeholder="e.g. client@example.com or admin@company.com"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "10px 14px 10px 38px",
                      borderRadius: "8px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      outline: 0,
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleSendTestEmail}
                  disabled={sendingTest || !recipientEmail}
                  className="secondary-button"
                  style={{
                    padding: "10px 14px",
                    fontWeight: 600,
                    fontSize: "12px",
                    borderColor: "#bfdbfe",
                    background: "#eff6ff",
                    color: "#1d4ed8",
                  }}
                  title="Test email dispatch via Resend API"
                >
                  <Send size={13} className={sendingTest ? "spinning" : undefined} />
                  {sendingTest ? "Testing..." : "Send Test"}
                </button>
              </div>
              <small style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#64748b" }}>
                Powered by Resend Email Gateway. Emails are dispatched instantly upon anomalous events.
              </small>
            </div>

            {/* CHANNEL TOGGLES */}
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "16px" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "#64748b", display: "block", marginBottom: "12px" }}>
                Subscribed Alert Channels
              </span>

              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {/* CHANNEL 1: FRAUD DETECTION */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={fraudAlertsEnabled}
                    onChange={(e) => setFraudAlertsEnabled(e.target.checked)}
                    style={{ marginTop: "3px", width: "16px", height: "16px", accentColor: "#2563eb" }}
                  />
                  <div>
                    <strong style={{ fontSize: "13px", color: "#0f172a", display: "block" }}>
                      Fraud Detection & Real-Time Security Incident Alerts
                    </strong>
                    <span style={{ fontSize: "11px", color: "#64748b", lineHeight: 1.5 }}>
                      Dispatches immediate high-priority alerts with forensic diffs when critical data tampering, role escalation, or ledger violations occur.
                    </span>
                  </div>
                </label>

                {/* CHANNEL 2: DAILY ANALYSIS */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={dailyAnalysisEnabled}
                    onChange={(e) => setDailyAnalysisEnabled(e.target.checked)}
                    style={{ marginTop: "3px", width: "16px", height: "16px", accentColor: "#2563eb" }}
                  />
                  <div>
                    <strong style={{ fontSize: "13px", color: "#0f172a", display: "block" }}>
                      Daily Data Analysis Executive Summary Digests
                    </strong>
                    <span style={{ fontSize: "11px", color: "#64748b", lineHeight: 1.5 }}>
                      Sends automated business performance highlights, metric velocity trends, and periodic health summaries.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* MINIMUM SEVERITY SELECTOR */}
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                Minimum Incident Alert Sensitivity
              </label>
              <select
                value={minSeverity}
                onChange={(e) => setMinSeverity(e.target.value as any)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  fontSize: "12px",
                  background: "#ffffff",
                  color: "#0f172a",
                }}
              >
                <option value="CRITICAL">🔴 Critical Incidents Only (Privilege Escalation, Ledger Inversion)</option>
                <option value="HIGH">🟠 High & Critical Incidents (Recommended)</option>
                <option value="MEDIUM">🟡 Medium, High, and Critical Incidents</option>
              </select>
            </div>

            {/* ACTION BUTTONS */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "10px" }}>
              <button
                type="submit"
                disabled={saving}
                className="primary"
                style={{ minHeight: "38px", padding: "8px 20px", display: "inline-flex", alignItems: "center", gap: "8px" }}
              >
                <Save size={14} className={saving ? "spinning" : undefined} />
                {saving ? "Saving..." : "Save Preferences"}
              </button>
            </div>
          </form>
        </div>

        {/* RIGHT COLUMN: SECURITY TELEMETRY & WORKSPACE INFO */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* WORKSPACE DETAILS CARD */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #eaedf0",
              borderRadius: "14px",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
              <Database size={16} style={{ color: "#2563eb" }} />
              <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0f172a", textTransform: "uppercase" }}>
                Workspace Telemetry
              </h3>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span style={{ color: "#64748b" }}>Project Reference:</span>
                <strong style={{ color: "#0f172a", fontFamily: "monospace" }}>
                  {sessionData?.projectRef || "pg_session"}
                </strong>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span style={{ color: "#64748b" }}>Storage Namespace:</span>
                <strong style={{ color: "#0f172a", fontFamily: "monospace", fontSize: "11px" }}>
                  {storageStatus?.currentUser?.userId || "derived_user"}
                </strong>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span style={{ color: "#64748b" }}>Security Bridge:</span>
                <span style={{ color: "#166534", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <ShieldCheck size={13} /> Multi-Tenant Isolated
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "2px" }}>
                <span style={{ color: "#64748b" }}>Resend Gateway:</span>
                <span style={{ color: hasApiKey ? "#166534" : "#dc2626", fontWeight: 700 }}>
                  {hasApiKey ? "Ready (Configured)" : "Missing Key"}
                </span>
              </div>
            </div>
          </div>

          {/* QUICK SHORTCUTS CARD */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #eaedf0",
              borderRadius: "14px",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
              <Sparkles size={16} style={{ color: "#d97706" }} />
              <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0f172a", textTransform: "uppercase" }}>
                Module Navigation
              </h3>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {onNavigate && (
                <>
                  <button
                    type="button"
                    onClick={() => onNavigate("fraud-detection")}
                    className="secondary-button"
                    style={{ width: "100%", justifyContent: "flex-start", fontSize: "12px", padding: "10px 14px" }}
                  >
                    <ShieldAlert size={14} style={{ color: "#dc2626" }} /> Fraud Detection & Live Logs
                  </button>

                  <button
                    type="button"
                    onClick={() => onNavigate("daily-analysis")}
                    className="secondary-button"
                    style={{ width: "100%", justifyContent: "flex-start", fontSize: "12px", padding: "10px 14px" }}
                  >
                    <Bell size={14} style={{ color: "#d97706" }} /> Daily Analysis Dashboard
                  </button>

                  <button
                    type="button"
                    onClick={() => onNavigate("dashboard")}
                    className="secondary-button"
                    style={{ width: "100%", justifyContent: "flex-start", fontSize: "12px", padding: "10px 14px" }}
                  >
                    <Database size={14} style={{ color: "#2563eb" }} /> Smart Workspace Datasets
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
