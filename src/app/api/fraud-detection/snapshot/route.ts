import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { executeFraudQuery } from "@/../fraud_detection_and_notification/fraud-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function quoteIdentifier(val: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) {
    throw new Error(`Invalid identifier: ${val}`);
  }
  return `"${val}"`;
}

export async function GET(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  const session = access.session;

  try {
    // 1. Discover all public tables
    const tableSql = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name
      LIMIT 50
    `;
    const tableRows = await executeFraudQuery(session, tableSql);
    const tableNames = tableRows.map((r) => String(r.table_name));

    const snapshot: Record<string, Record<string, unknown>[]> = {};
    const auditChanges: Array<{
      id: string;
      tableName: string;
      recordId: string;
      columnName: string;
      oldValue: unknown;
      newValue: unknown;
      changedBy: string | null;
      changedAt: string;
      eventType: string;
    }> = [];

    // 2. Fetch rows for business tables
    for (const name of tableNames) {
      const lower = name.toLowerCase();

      // Check if it's an audit log table
      if (lower === "querypilot_universal_audit_log") {
        try {
          const auditSql = `
            SELECT id, table_name, record_id, column_name, old_value, new_value, changed_by, changed_at, event_type
            FROM public.querypilot_universal_audit_log
            ORDER BY changed_at DESC
            LIMIT 200
          `;
          const rows = await executeFraudQuery(session, auditSql);
          for (const r of rows) {
            auditChanges.push({
              id: `univ-${r.id}`,
              tableName: String(r.table_name || "unknown"),
              recordId: String(r.record_id || "unknown"),
              columnName: String(r.column_name || "record"),
              oldValue: r.old_value,
              newValue: r.new_value,
              changedBy: typeof r.changed_by === "string" ? r.changed_by : null,
              changedAt: String(r.changed_at),
              eventType: typeof r.event_type === "string" ? r.event_type : "UPDATE",
            });
          }
        } catch {
          // Ignore
        }
        continue;
      }

      if (lower === "sales_audit_log") {
        try {
          const salesSql = `
            SELECT id, sale_id, old_amount, new_amount, changed_at, changed_by, action
            FROM public.sales_audit_log
            ORDER BY id DESC
            LIMIT 200
          `;
          const rows = await executeFraudQuery(session, salesSql);
          for (const r of rows) {
            auditChanges.push({
              id: `sale-audit-${r.id}`,
              tableName: "sales",
              recordId: String(r.sale_id || "unknown"),
              columnName: "amount",
              oldValue: r.old_amount,
              newValue: r.new_amount,
              changedBy: typeof r.changed_by === "string" ? r.changed_by : null,
              changedAt: String(r.changed_at),
              eventType: "UPDATE",
            });
          }
        } catch {
          // Ignore
        }
        continue;
      }

      // Fetch snapshot of normal table data
      try {
        const qTable = quoteIdentifier(name);
        const rowsSql = `SELECT * FROM public.${qTable} LIMIT 150`;
        const rows = await executeFraudQuery(session, rowsSql);
        snapshot[name] = rows;
      } catch (err) {
        console.warn(`Could not snapshot table ${name}:`, err);
      }
    }

    return access.applyCookie(
      NextResponse.json(
        {
          success: true,
          timestamp: new Date().toISOString(),
          tables: tableNames,
          snapshot,
          auditChanges,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (error) {
    console.error("Snapshot error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not fetch table snapshots.",
      },
      { status: 500 }
    );
  }
}
