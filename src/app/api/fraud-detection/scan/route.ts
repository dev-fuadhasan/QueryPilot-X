import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { runUniversalScan } from "@/../fraud_detection_and_notification/universal-detector";
import { calculateSummary } from "@/../fraud_detection_and_notification/notification-service";
import type { ScanOptions } from "@/../fraud_detection_and_notification/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  try {
    const body = (await request.json().catch(() => ({}))) as ScanOptions;
    const session = access.session;

    const { alerts, scannedTables, totalRecordsAnalyzed, profile } =
      await runUniversalScan(session, {
        profile: body.profile,
        tableNames: body.tableNames,
        sensitivity: body.sensitivity || "medium",
        thresholdPercent: body.thresholdPercent,
      });

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
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (error) {
    console.error("Fraud scan error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not execute customized fraud scan.",
      },
      { status: 500 }
    );
  }
}
