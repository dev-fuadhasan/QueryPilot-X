import { NextResponse } from "next/server";
import { readDailyAnalysisSession } from "@/../daily_data_analysis_and_notification/api-helpers";
import { queryPostgres } from "@/lib/database";
import { queryOAuth } from "@/lib/supabase";
import { detectSuspiciousChanges, type AuditChange } from "@/../fraud_detection_and_notification/fraudDetection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await readDailyAnalysisSession(request);
  if ("response" in access) return access.response;

  const sql = `
    SELECT id, sale_id, old_amount, new_amount, changed_at, changed_by
    FROM public.sales_audit_log
    WHERE action = 'AMOUNT_UPDATED'
    ORDER BY id DESC
    LIMIT 1000
  `;

  try {
    const session = access.session;
    const rows = session.mode === "oauth"
      ? await queryOAuth(session, sql)
      : await queryPostgres(session.dbUrl || "", sql);

    const changes: AuditChange[] = rows.map(row => ({
      id: String(row.id),
      tableName: "sales",
      recordId: String(row.sale_id),
      columnName: "amount",
      oldValue: row.old_amount,
      newValue: row.new_amount,
      changedBy: typeof row.changed_by === "string" ? row.changed_by : null,
      changedAt: String(row.changed_at)
    }));

    return access.applyCookie(NextResponse.json(
      { alerts: detectSuspiciousChanges(changes, { thresholdPercent: 50 }) },
      { headers: { "Cache-Control": "no-store" } }
    ));
  } catch (error) {
    const missingAuditTable = error instanceof Error && (
      /sales_audit_log/i.test(error.message) || /42P01/.test(error.message)
    );
    return NextResponse.json(
      { error: missingAuditTable ? "Fraud detection requires public.sales_audit_log in the connected database." : "Could not read fraud audit records from the connected database." },
      { status: 400 }
    );
  }
}
