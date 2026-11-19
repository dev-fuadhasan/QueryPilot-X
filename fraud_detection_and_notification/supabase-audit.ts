
import { queryFraudDatabase } from "./fraud-db";
import {
  detectSuspiciousChanges,
  type AuditChange,
} from "./fraudDetection";

export async function getSuspiciousSalesAlerts(
  connectionString: string
) {
  // Read audit records from Supabase using the fraud-specific connection.
  const rows = await queryFraudDatabase(
    connectionString,
    `
      SELECT
        id,
        sale_id,
        action,
        old_amount,
        new_amount,
        changed_at,
        changed_by
      FROM public.sales_audit_log
      WHERE action = 'AMOUNT_UPDATED'
      ORDER BY id DESC
      LIMIT 1000
    `
  );

  // Convert database records into our detection format.
  const changes: AuditChange[] = rows.map((row) => ({
    id: String(row.id),
    tableName: "sales",
    recordId: String(row.sale_id),
    columnName: "amount",
    oldValue: row.old_amount,
    newValue: row.new_amount,
    changedBy:
      typeof row.changed_by === "string"
        ? row.changed_by
        : null,
    changedAt: String(row.changed_at),
  }));

  // Detect suspicious decreases of 50% or more.
  return detectSuspiciousChanges(changes, {
    thresholdPercent: 50,
  });
}
