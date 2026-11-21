import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { discoverDatabaseSchema } from "@/../fraud_detection_and_notification/universal-detector";
import { BUSINESS_PROFILES } from "@/../fraud_detection_and_notification/business-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  try {
    const session = access.session;
    const { tables, suggestedProfile, auditTables } =
      await discoverDatabaseSchema(session);

    return access.applyCookie(
      NextResponse.json(
        {
          success: true,
          tables,
          suggestedProfile,
          auditTables,
          hasAuditTable: auditTables.length > 0,
          availableProfiles: BUSINESS_PROFILES,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (error) {
    console.error("Schema discovery error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not discover database schema.",
      },
      { status: 500 }
    );
  }
}
