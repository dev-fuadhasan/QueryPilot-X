import type { UniversalAlert, Severity, ScanSummary } from "./types";

export function calculateSummary(
  alerts: UniversalAlert[],
  scannedTables: string[],
  totalRecordsAnalyzed: number,
  hasAuditTable = false,
  auditTableName?: string
): ScanSummary {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const alert of alerts) {
    counts[alert.severity] = (counts[alert.severity] || 0) + 1;
  }

  return {
    totalAlerts: alerts.length,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    scannedTables,
    totalRecordsAnalyzed,
    detectedAt: new Date().toISOString(),
    hasAuditTable,
    auditTableName,
  };
}

export function exportAlertsToCSV(alerts: UniversalAlert[]): string {
  const headers = [
    "Alert ID",
    "Severity",
    "Rule Category",
    "Table",
    "Record ID",
    "Field",
    "Old Value",
    "New Value",
    "Actor",
    "Timestamp",
    "Reason",
    "Recommendation",
  ];

  const escapeCSV = (val: unknown): string => {
    if (val === null || val === undefined) return '""';
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const rows = alerts.map((a) =>
    [
      a.id,
      a.severity.toUpperCase(),
      a.ruleCategory,
      a.tableName,
      a.recordId,
      a.columnName || "",
      a.oldValue ?? "",
      a.newValue ?? "",
      a.actor || "Unknown",
      a.timestamp,
      a.reason,
      a.recommendation,
    ]
      .map(escapeCSV)
      .join(",")
  );

  return [headers.join(","), ...rows].join("\r\n");
}

export function exportAlertsToJSON(alerts: UniversalAlert[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      totalAlerts: alerts.length,
      alerts,
    },
    null,
    2
  );
}
