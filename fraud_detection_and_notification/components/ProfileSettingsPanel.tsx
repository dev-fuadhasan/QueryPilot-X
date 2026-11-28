"use client";

import React, { useState, useEffect } from "react";
import {
  User,
  Mail,
  CheckCircle2,
  AlertTriangle,
  Send,
  Save,
  ArrowLeft,
  Bell,
} from "lucide-react";

interface ProfileSettingsPanelProps {
  onBack?: () => void;
  onNavigate?: (screen: string) => void;
}

export default function ProfileSettingsPanel({ onBack }: ProfileSettingsPanelProps) {
  const [sessionData, setSessionData] = useState<any>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [fraudAlertsEnabled, setFraudAlertsEnabled] = useState(true);
  const [dailyAnalysisEnabled, setDailyAnalysisEnabled] = useState(true);
  const [minSeverity, setMinSeverity] = useState<"CRITICAL" | "HIGH" | "MEDIUM">("HIGH");

  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    async function loadProfile() {
      try {
        const [sessionRes, emailRes] = await Promise.all([
          fetch("/api/session", { cache: "no-store" }),
          fetch("/api/notifications/email", { cache: "no-store" }),
        ]);

        if (sessionRes.ok) {
          setSessionData(await sessionRes.json());
        }

        if (emailRes.ok) {
          const mail = await emailRes.json();
          if (mail.settings) {
            setRecipientEmail(mail.settings.recipientEmail || "");
            setFraudAlertsEnabled(mail.settings.fraudAlertsEnabled ?? true);
            setDailyAnalysisEnabled(mail.settings.dailyAnalysisEnabled ?? true);
            setMinSeverity(mail.settings.minSeverity || "HIGH");
          }
        }
      } catch {
        // Ignore initial load failures
      }
    }

    void loadProfile();
  }, []);

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
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
          message: "Settings saved successfully.",
        });
        setTimeout(() => setStatusNotice(null), 4000);
      } else {
        setStatusNotice({
          type: "error",
          message: data.error || "Failed to save settings.",
        });
      }
    } catch {
      setStatusNotice({
        type: "error",
        message: "Network error while saving settings.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!recipientEmail || !recipientEmail.includes("@")) {
      setStatusNotice({
        type: "error",
        message: "Please enter a valid email address first.",
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
          message: `Test email sent to ${recipientEmail.trim()}. Check your inbox!`,
        });
      } else {
        setStatusNotice({
          type: "error",
          message: data.error || "Failed to send test email.",
        });
      }
    } catch {
      setStatusNotice({
        type: "error",
        message: "Network error while sending test email.",
      });
    } finally {
      setSendingTest(false);
    }
  };

  return (
    <div className="datasets-panel" style={{ maxWidth: "760px", margin: "0 auto", paddingBottom: "60px" }}>
      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div>
          <div className="section-eyebrow" style={{ marginBottom: "4px" }}>PROFILE & SETTINGS</div>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 700, color: "#0f172a" }}>
            Profile & Email Alerts
          </h1>
        </div>
        {onBack && (
          <button
            type="button"
            className="secondary-button"
            onClick={onBack}
            style={{ padding: "8px 14px", fontSize: "12px" }}
          >
            <ArrowLeft size={14} /> Back
          </button>
        )}
      </div>

      {/* STATUS NOTICE */}
      {statusNotice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            background: statusNotice.type === "success" ? "#f0fdf4" : "#fef2f2",
            border: `1px solid ${statusNotice.type === "success" ? "#bbf7d0" : "#fecaca"}`,
            color: statusNotice.type === "success" ? "#166534" : "#991b1b",
            padding: "12px 16px",
            borderRadius: "10px",
            marginBottom: "18px",
            fontSize: "13px",
            fontWeight: 500,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {statusNotice.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>{statusNotice.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontSize: "16px" }}
          >
            ×
          </button>
        </div>
      )}

      {/* SIMPLE ACCOUNT CARD */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #eaedf0",
          borderRadius: "12px",
          padding: "20px",
          marginBottom: "18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "10px",
                background: "#f1f5f9",
                color: "#0f172a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <User size={20} />
            </div>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                {sessionData?.projectName || "Connected Workspace"}
              </div>
              <div style={{ fontSize: "12px", color: "#64748b" }}>
                {sessionData?.mode === "oauth" ? "Supabase OAuth" : "PostgreSQL Connection"}
                {sessionData?.projectRef ? ` · ${sessionData.projectRef}` : ""}
              </div>
            </div>
          </div>

          <span
            className="connection-status"
            style={{
              background: "#f0fdf4",
              borderColor: "#bbf7d0",
              color: "#15803d",
              fontWeight: 600,
              fontSize: "12px",
            }}
          >
            <i style={{ background: "#22c55e" }} />
            Connected
          </span>
        </div>
      </div>

      {/* SIMPLE EMAIL ACTIVATION CARD */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #eaedf0",
          borderRadius: "12px",
          padding: "24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
          <Bell size={18} style={{ color: "#2563eb" }} />
          <div>
            <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
              Email Notification Activation
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
              Set a client email to receive Fraud Detection alerts and Daily Analysis summaries.
            </p>
          </div>
        </div>

        <form onSubmit={handleSavePreferences} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* EMAIL INPUT + TEST BUTTON */}
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
              Client Email Address
            </label>
            <div style={{ display: "flex", gap: "10px" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <Mail
                  size={15}
                  style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }}
                />
                <input
                  type="email"
                  required
                  placeholder="client@example.com"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "10px 12px 10px 36px",
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
                style={{ padding: "10px 14px", fontSize: "12px", fontWeight: 600 }}
              >
                <Send size={13} className={sendingTest ? "spinning" : undefined} />
                {sendingTest ? "Sending..." : "Send Test"}
              </button>
            </div>
          </div>

          {/* ALERT OPTIONS */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", background: "#f8fafc", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", fontSize: "13px", fontWeight: 500, color: "#0f172a" }}>
              <input
                type="checkbox"
                checked={fraudAlertsEnabled}
                onChange={(e) => setFraudAlertsEnabled(e.target.checked)}
                style={{ width: "16px", height: "16px", accentColor: "#2563eb" }}
              />
              Fraud Detection & Live Change Log Alerts
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", fontSize: "13px", fontWeight: 500, color: "#0f172a" }}>
              <input
                type="checkbox"
                checked={dailyAnalysisEnabled}
                onChange={(e) => setDailyAnalysisEnabled(e.target.checked)}
                style={{ width: "16px", height: "16px", accentColor: "#2563eb" }}
              />
              Daily Analysis Summary Emails
            </label>
          </div>

          {/* SENSITIVITY */}
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
              Fraud Alert Threshold
            </label>
            <select
              value={minSeverity}
              onChange={(e) => setMinSeverity(e.target.value as any)}
              style={{
                width: "100%",
                padding: "9px 12px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            >
              <option value="CRITICAL">Critical Only</option>
              <option value="HIGH">High & Critical (Recommended)</option>
              <option value="MEDIUM">Medium, High & Critical</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: "4px" }}>
            <button
              type="submit"
              disabled={saving}
              className="primary"
              style={{ minHeight: "38px", padding: "8px 20px", display: "inline-flex", alignItems: "center", gap: "8px" }}
            >
              <Save size={14} className={saving ? "spinning" : undefined} />
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
