import { NextResponse } from "next/server";
import { readFraudSession } from "@/../fraud_detection_and_notification/fraud-session";
import { executeFraudQuery } from "@/../fraud_detection_and_notification/fraud-db";
import {
  detectSuspiciousChanges,
  type AuditChange,
} from "@/../fraud_detection_and_notification/fraudDetection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await readFraudSession(request);
  if ("response" in access) return access.response;

  const { searchParams } = new URL(request.url);
  const requestedThreshold = Number(searchParams.get("threshold") ?? 50);

  if (
    !Number.isFinite(requestedThreshold) ||
    requestedThreshold <= 0 ||
    requestedThreshold > 100
  ) {
    return NextResponse.json(
      { error: "Threshold must be between 0 and 100." },
      { status: 400 }
    );
  }

  const session = access.session;

  // Try reading querypilot_universal_audit_log first
  try {
    const universalSql = `
      SELECT
        id,
        table_name,
        record_id,
        column_name,
        old_value,
        new_value,
        changed_by,
        changed_at,
        event_type
      FROM public.querypilot_universal_audit_log
      ORDER BY changed_at DESC
      LIMIT 1000
    `;

    const rows = await executeFraudQuery(session, universalSql);

    const changes: AuditChange[] = rows.map((row) => ({
      id: String(row.id),
      tableName: String(row.table_name),
      recordId: String(row.record_id),
      columnName: String(row.column_name),
      oldValue: row.old_value,
      newValue: row.new_value,
      changedBy:
        typeof row.changed_by === "string" ? row.changed_by : null,
      changedAt: String(row.changed_at),
      eventType:
        typeof row.event_type === "string" ? row.event_type : "UPDATE",
    }));

    const alerts = detectSuspiciousChanges(changes, {
      thresholdPercent: requestedThreshold,
      checkDecreases: true,
      checkIncreases: true,
      checkDeletions: true,
      checkSensitiveFields: true,
    });

    const eventCounts = {
      insert: changes.filter((c) => c.eventType === "INSERT").length,
      update: changes.filter((c) => c.eventType === "UPDATE").length,
      delete: changes.filter((c) => c.eventType === "DELETE").length,
    };

    return access.applyCookie(
      NextResponse.json(
        {
          connected: true,
          mode: "universal",
          totalAuditRecords: changes.length,
          totalAlerts: alerts.length,
          thresholdPercent: requestedThreshold,
          eventCounts,
          changes,
          alerts,
          message: "Universal audit records loaded successfully.",
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch {
    // Fallback to legacy sales_audit_log if querypilot_universal_audit_log does not exist
    try {
      const salesSql = `
        SELECT id, sale_id, old_amount, new_amount, changed_at, changed_by, action
        FROM public.sales_audit_log
        ORDER BY id DESC
        LIMIT 1000
      `;

      const rows = await executeFraudQuery(session, salesSql);

      const changes: AuditChange[] = rows.map((row) => ({
        id: String(row.id),
        tableName: "sales",
        recordId: String(row.sale_id),
        columnName: "amount",
        oldValue: row.old_amount,
        newValue: row.new_amount,
        changedBy:
          typeof row.changed_by === "string" ? row.changed_by : null,
        changedAt: String(row.changed_at),
        eventType: "UPDATE",
      }));

      const alerts = detectSuspiciousChanges(changes, {
        thresholdPercent: requestedThreshold,
      });

      return access.applyCookie(
        NextResponse.json(
          {
            connected: true,
            mode: "legacy_sales",
            totalAuditRecords: changes.length,
            totalAlerts: alerts.length,
            thresholdPercent: requestedThreshold,
            eventCounts: { insert: 0, update: changes.length, delete: 0 },
            changes,
            alerts,
            message: "Sales audit records loaded successfully.",
          },
          { headers: { "Cache-Control": "no-store" } }
        )
      );
    } catch {
      return NextResponse.json(
        {
          connected: true,
          mode: "none",
          totalAuditRecords: 0,
          totalAlerts: 0,
          changes: [],
          alerts: [],
          message: "No audit table found yet. Create one via Audit Setup.",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
  }
}
