/**
 * QueryPilot-X — Automated Email Notification Service
 * Powered by Resend API
 *
 * Dispatches real-time security alerts for Fraud Detection & Live Change Log,
 * as well as Daily Data Analysis executive summaries.
 */

export interface EmailNotificationConfig {
  apiKey?: string;
  fromEmail?: string;
  recipientEmail: string;
  fraudAlertsEnabled: boolean;
  dailyAnalysisEnabled: boolean;
  minSeverity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export interface EmailDispatchResult {
  success: boolean;
  id?: string;
  error?: string;
  simulated?: boolean;
}

const DEFAULT_RESEND_KEY = process.env.RESEND_API_KEY || "";
const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || "QueryPilot-X <onboarding@resend.dev>";

/**
 * Sends a raw email using the Resend API.
 */
export async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  apiKey?: string;
  from?: string;
}): Promise<EmailDispatchResult> {
  const key = params.apiKey || DEFAULT_RESEND_KEY;
  const from = params.from || DEFAULT_FROM;

  if (!params.to || !params.to.includes("@")) {
    return { success: false, error: "Invalid recipient email address." };
  }

  if (!key) {
    return { success: false, error: "Resend API key is not configured." };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to.trim()],
        subject: params.subject,
        html: params.html,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const errorMsg = data?.message || data?.error || `Resend API returned HTTP ${res.status}`;
      return { success: false, error: errorMsg };
    }

    return { success: true, id: data.id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error contacting Resend API.",
    };
  }
}

/**
 * Sends an email verification / test notification.
 */
export async function sendTestVerificationEmail(toEmail: string, clientName = "QueryPilot User"): Promise<EmailDispatchResult> {
  const subject = "✅ [QueryPilot-X] Notification Email Successfully Activated";
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; }
          .header { background: #0f172a; padding: 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
          .header p { margin: 6px 0 0; color: #94a3b8; font-size: 13px; }
          .content { padding: 28px; }
          .status-badge { display: inline-block; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; margin-bottom: 18px; }
          .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 18px 0; font-size: 13px; line-height: 1.6; }
          .footer { background: #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>QueryPilot-X System Notification</h1>
            <p>Intelligent Workspace Security & Analytics</p>
          </div>
          <div class="content">
            <div class="status-badge">EMAIL CHANNEL ACTIVE</div>
            <h2>Hello, ${clientName}!</h2>
            <p>Your email address has been successfully verified and connected to your QueryPilot-X workspace.</p>
            <div class="card">
              <strong>Active Alert Subscriptions:</strong><br/>
              • <strong>Fraud Detection & Live Change Log:</strong> Real-time critical data mutations & privilege escalations<br/>
              • <strong>Daily Data Analysis:</strong> Executive summaries, metric velocity & anomaly digests<br/>
              • <strong>Supabase Storage:</strong> Signed report generation & audit archiving
            </div>
            <p style="color: #64748b; font-size: 12px;">This is an automated system confirmation. You do not need to reply to this message.</p>
          </div>
          <div class="footer">
            QueryPilot-X · Real-Time Intelligence & Fraud Detection Engine
          </div>
        </div>
      </body>
    </html>
  `;

  return sendResendEmail({ to: toEmail, subject, html });
}

/**
 * Sends a high-severity Fraud Detection & Security Incident Alert Email.
 */
export async function sendFraudIncidentAlertEmail(
  toEmail: string,
  incident: {
    id: string;
    tableName: string;
    recordId: string;
    columnName: string;
    oldValue: unknown;
    newValue: unknown;
    changedBy?: string | null;
    timestamp: string;
    riskScore?: number;
    riskSeverity?: string;
    reason?: string;
    recommendation?: string;
  }
): Promise<EmailDispatchResult> {
  const sev = (incident.riskSeverity || "HIGH").toUpperCase();
  const score = incident.riskScore ?? 75;
  const isCritical = sev === "CRITICAL";

  const subject = `${isCritical ? "🚨 CRITICAL" : "⚠️ HIGH"} [Security Alert] Data Mutation in ${incident.tableName} (#${incident.recordId})`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #1e293b; margin: 0; padding: 24px; }
          .container { max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #334155; }
          .banner { background: ${isCritical ? "#991b1b" : "#c2410c"}; color: #ffffff; padding: 20px 24px; }
          .banner h1 { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: -0.3px; }
          .banner p { margin: 4px 0 0; font-size: 12px; color: #fee2e2; }
          .body { padding: 24px; }
          .score-box { display: flex; align-items: center; justify-content: space-between; background: #fef2f2; border: 1px solid #fecaca; padding: 12px 18px; border-radius: 8px; margin-bottom: 20px; }
          .score-val { font-size: 22px; font-weight: 800; color: #dc2626; }
          .table-diff { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13px; }
          .table-diff th { background: #f1f5f9; text-align: left; padding: 10px 12px; border: 1px solid #e2e8f0; font-size: 11px; text-transform: uppercase; color: #64748b; }
          .table-diff td { padding: 10px 12px; border: 1px solid #e2e8f0; font-family: monospace; }
          .old-val { color: #dc2626; text-decoration: line-through; }
          .new-val { color: #16a34a; font-weight: 700; }
          .rec-box { background: #eff6ff; border-left: 4px solid #2563eb; padding: 14px 18px; border-radius: 0 8px 8px 0; margin-top: 18px; font-size: 13px; line-height: 1.5; color: #1e40af; }
          .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; font-size: 11px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="banner">
            <h1>🚨 QueryPilot-X Security Incident Alert</h1>
            <p>Automated detection of anomalous database modification</p>
          </div>
          <div class="body">
            <div class="score-box">
              <div>
                <strong style="color: #991b1b; text-transform: uppercase; font-size: 13px;">${sev} ANOMALY DETECTED</strong><br/>
                <span style="font-size: 11px; color: #64748b;">Table: <strong>${incident.tableName}</strong> · Record: <strong>#${incident.recordId}</strong></span>
              </div>
              <div class="score-val">${score} / 100</div>
            </div>

            <p style="font-size: 13px; line-height: 1.6; margin: 0 0 16px;">
              A verified database update occurred on field <strong>${incident.columnName}</strong> that triggered heuristic risk alarms.
            </p>

            <table class="table-diff">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Previous State</th>
                  <th>Tampered / New State</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>${incident.columnName}</strong></td>
                  <td class="old-val">${String(incident.oldValue)}</td>
                  <td class="new-val">${String(incident.newValue)}</td>
                </tr>
              </tbody>
            </table>

            <div style="font-size: 12px; color: #475569; margin: 12px 0;">
              • <strong>Timestamp:</strong> ${incident.timestamp}<br/>
              • <strong>Source / Actor:</strong> ${incident.changedBy || "Database Editor / Direct SQL"}<br/>
              • <strong>Event Signature:</strong> <code>${incident.id}</code>
            </div>

            <div class="rec-box">
              <strong>Forensic Action Recommendation:</strong><br/>
              ${incident.recommendation || "Review the modified record immediately. Verify authorizing credentials and evaluate rollback necessity."}
            </div>
          </div>
          <div class="footer">
            QueryPilot-X Fraud Detection & Notification Subsystem · Real-Time Incident Protection
          </div>
        </div>
      </body>
    </html>
  `;

  return sendResendEmail({ to: toEmail, subject, html });
}

/**
 * Sends a Daily Data Analysis Executive Summary Email.
 */
export async function sendDailyAnalysisDigestEmail(
  toEmail: string,
  summary: {
    projectName: string;
    date: string;
    metricsAnalyzed: number;
    anomaliesFound: number;
    topFindings: string[];
    pdfReportLink?: string;
  }
): Promise<EmailDispatchResult> {
  const subject = `📊 [QueryPilot-X] Daily Intelligence Digest — ${summary.date}`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; }
          .header { background: #1e293b; color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0; font-size: 20px; }
          .header p { margin: 4px 0 0; color: #94a3b8; font-size: 12px; }
          .content { padding: 28px; }
          .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 20px 0; }
          .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; padding: 14px; border-radius: 8px; text-align: center; }
          .stat-card strong { font-size: 22px; color: #0f172a; display: block; }
          .stat-card span { font-size: 11px; color: #64748b; }
          .findings { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px; font-size: 13px; line-height: 1.6; color: #166534; }
          .footer { background: #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Daily Intelligence Digest</h1>
            <p>Workspace: ${summary.projectName} · ${summary.date}</p>
          </div>
          <div class="content">
            <p>Here is your automated business and data performance summary generated by QueryPilot-X:</p>
            <div class="stat-grid">
              <div class="stat-card">
                <strong>${summary.metricsAnalyzed}</strong>
                <span>Metrics Evaluated</span>
              </div>
              <div class="stat-card">
                <strong style="color: ${summary.anomaliesFound > 0 ? "#ea580c" : "#16a34a"}">${summary.anomaliesFound}</strong>
                <span>Anomalies Highlighted</span>
              </div>
            </div>
            <h3>Key Executive Findings:</h3>
            <div class="findings">
              <ul style="margin: 0; padding-left: 20px;">
                ${summary.topFindings.map(f => `<li>${f}</li>`).join("")}
              </ul>
            </div>
            ${summary.pdfReportLink ? `<p style="margin-top: 20px;"><a href="${summary.pdfReportLink}" style="background: #0f172a; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: 700;">Download Complete PDF Report</a></p>` : ""}
          </div>
          <div class="footer">
            QueryPilot-X Autonomous Daily Analytics Engine
          </div>
        </div>
      </body>
    </html>
  `;

  return sendResendEmail({ to: toEmail, subject, html });
}
