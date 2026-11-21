import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { runUniversalScan } from "@/../fraud_detection_and_notification/universal-detector";
import { calculateSummary } from "@/../fraud_detection_and_notification/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  try {
    const session = access.session;
    const { alerts, scannedTables, totalRecordsAnalyzed, profile } =
      await runUniversalScan(session, { sensitivity: "medium" });

    const summary = calculateSummary(
      alerts,
      scannedTables,
      totalRecordsAnalyzed
    );

    return access.applyCookie(
      NextResponse.json(
        {
          success: true,
          profile,
          scannedTables,
          totalRecordsAnalyzed,
          summary,
          alerts,
          // Legacy backward compatibility properties
          fraudAlerts: alerts,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (error) {
    console.error("Fraud detection scan error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not scan the connected database for fraud anomalies.",
      },
      { status: 500 }
    );
  }
}
