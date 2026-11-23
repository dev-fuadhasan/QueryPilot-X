import type { UniversalAlert, Severity, ScanSummary } from "./types";

/**
 * Pure JavaScript deterministic hash function (works identically in Node.js and Browser environments).
 * Eliminates 'node:crypto' dependency for client-side Webpack compatibility.
 */
export function generateStableChangeHash(
  tableName: string,
  recordId: string,
  columnName: string,
  oldVal: unknown,
  newVal: unknown
): string {
  const strOld = oldVal === null || oldVal === undefined ? "NULL" : String(oldVal);
  const strNew = newVal === null || newVal === undefined ? "NULL" : String(newVal);
  const sig = `${tableName}:${recordId}:${columnName}:${strOld}->${strNew}`;

  let h1 = 0xdeadbeef;
  let h2 = 0x41c64e6d;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hashHex = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  return hashHex.slice(0, 16);
}

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

export function exportChangeNotificationsToCSV(
  changes: Array<{
    id: string;
    tableName: string;
    recordId: string;
    columnName: string;
    oldValue: unknown;
    newValue: unknown;
    timestamp: string;
    changeType?: string;
    changedBy?: string | null;
  }>
): string {
  const headers = [
    "Date & Time",
    "Dataset / Table",
    "Record ID",
    "Field",
    "Old Value",
    "New Value",
    "Type",
    "Changed By",
  ];

  const escapeCSV = (val: unknown): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = changes.map((c) => [
    escapeCSV(c.timestamp),
    escapeCSV(c.tableName),
    escapeCSV(c.recordId),
    escapeCSV(c.columnName),
    escapeCSV(c.oldValue),
    escapeCSV(c.newValue),
    escapeCSV(c.changeType || "UPDATE"),
    escapeCSV(c.changedBy || "Database Editor"),
  ]);

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export function exportAlertsToCSV(alerts: UniversalAlert[]): string {
  const headers = [
    "Alert ID",
    "Rule Category",
    "Severity",
    "Dataset / Table",
    "Record ID",
    "Field",
    "Old Value",
    "New Value",
    "Timestamp",
    "Reason",
    "Recommendation",
  ];

  const escapeCSV = (val: unknown): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = alerts.map((a) => [
    escapeCSV(a.id),
    escapeCSV(a.ruleCategory),
    escapeCSV(String(a.severity).toUpperCase()),
    escapeCSV(a.tableName),
    escapeCSV(a.recordId),
    escapeCSV(a.columnName ?? ""),
    escapeCSV(a.oldValue ?? ""),
    escapeCSV(a.newValue ?? ""),
    escapeCSV(a.timestamp),
    escapeCSV(a.reason),
    escapeCSV(a.recommendation),
  ]);

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export function exportAlertsToJSON(alerts: UniversalAlert[]): string {
  return JSON.stringify(
    {
      totalAlerts: alerts.length,
      alerts,
    },
    null,
    2
  );
}
