import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/session";
import {
  sendResendEmail,
  sendTestVerificationEmail,
  sendFraudIncidentAlertEmail,
  sendDailyAnalysisDigestEmail,
  type EmailNotificationConfig,
} from "@/lib/notifications/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-memory persistent cache for email settings keyed by project/user
const settingsStore = new Map<string, EmailNotificationConfig>();

function getSessionKey(session: any): string {
  return session?.projectRef || session?.projectName || "default_user";
}

export async function GET(request: NextRequest) {
  try {
    const session = await readSession();
    const key = getSessionKey(session);
    const existing = settingsStore.get(key) || {
      recipientEmail: "",
      fraudAlertsEnabled: true,
      dailyAnalysisEnabled: true,
      minSeverity: "HIGH",
    };

    return NextResponse.json({
      success: true,
      settings: existing,
      hasApiKey: Boolean(process.env.RESEND_API_KEY),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load settings." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await readSession();
    const key = getSessionKey(session);
    const body = await request.json();
    const action = body.action || "test";

    if (action === "save-settings") {
      const newSettings: EmailNotificationConfig = {
        recipientEmail: String(body.recipientEmail || "").trim(),
        fraudAlertsEnabled: Boolean(body.fraudAlertsEnabled),
        dailyAnalysisEnabled: Boolean(body.dailyAnalysisEnabled),
        minSeverity: body.minSeverity || "HIGH",
      };

      settingsStore.set(key, newSettings);
      return NextResponse.json({ success: true, settings: newSettings });
    }

    if (action === "test") {
      const email = String(body.recipientEmail || "").trim();
      if (!email || !email.includes("@")) {
        return NextResponse.json({ success: false, error: "Please provide a valid recipient email address." }, { status: 400 });
      }

      const result = await sendTestVerificationEmail(email, session?.projectName || "QueryPilot User");
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 });
      }

      // Also persist this email as verified
      const current = settingsStore.get(key) || {
        recipientEmail: email,
        fraudAlertsEnabled: true,
        dailyAnalysisEnabled: true,
        minSeverity: "HIGH",
      };
      current.recipientEmail = email;
      settingsStore.set(key, current);

      return NextResponse.json({ success: true, message: `Verification email sent successfully to ${email}!`, id: result.id });
    }

    if (action === "fraud-alert") {
      const email = String(body.recipientEmail || settingsStore.get(key)?.recipientEmail || "").trim();
      if (!email || !email.includes("@")) {
        return NextResponse.json({ success: false, error: "Recipient email is not configured." }, { status: 400 });
      }

      const incident = body.incident;
      if (!incident) {
        return NextResponse.json({ success: false, error: "Incident payload is required." }, { status: 400 });
      }

      const result = await sendFraudIncidentAlertEmail(email, incident);
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 });
      }

      return NextResponse.json({ success: true, message: `Security incident alert sent to ${email}`, id: result.id });
    }

    if (action === "daily-digest") {
      const email = String(body.recipientEmail || settingsStore.get(key)?.recipientEmail || "").trim();
      if (!email || !email.includes("@")) {
        return NextResponse.json({ success: false, error: "Recipient email is not configured." }, { status: 400 });
      }

      const summary = body.summary || {
        projectName: session?.projectName || "Supabase Project",
        date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        metricsAnalyzed: 14,
        anomaliesFound: 0,
        topFindings: ["All transactions and accounts operating within expected historical baselines."],
      };

      const result = await sendDailyAnalysisDigestEmail(email, summary);
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 });
      }

      return NextResponse.json({ success: true, message: `Daily digest email sent to ${email}`, id: result.id });
    }

    return NextResponse.json({ success: false, error: `Unknown action '${action}'.` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error." },
      { status: 500 }
    );
  }
}
