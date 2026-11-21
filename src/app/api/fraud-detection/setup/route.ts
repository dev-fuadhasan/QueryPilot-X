import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { discoverDatabaseSchema } from "@/../fraud_detection_and_notification/universal-detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  try {
    const session = access.session;
    const { tables } = await discoverDatabaseSchema(session);

    const candidates = tables.map((t) => ({
      tableName: t.name,
      columns: t.columns.map((c) => c.name),
      suggestedIdColumn: t.idColumn,
      suggestedAmountColumn: t.amountColumn,
      readyForConfiguration: Boolean(t.idColumn && t.columns.length > 1),
    }));

    return access.applyCookie(
      NextResponse.json(
        {
          connected: true,
          tables: candidates,
          message: "Database schema discovery completed.",
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch {
    return NextResponse.json(
      { error: "Could not scan the connected database schema." },
      { status: 400 }
    );
  }
}
