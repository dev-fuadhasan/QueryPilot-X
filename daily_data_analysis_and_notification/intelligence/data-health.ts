import type { DomainTableUnderstanding, TableProfile } from "../profiler/types";
import { enumerateDates, safeChangePercent, safeRound } from "../metrics/math-and-periods";
import type { DynamicAnalysisResult } from "../metrics/types";
import type {
  DataHealthCheck,
  DataHealthReport,
  DataHealthSeverity,
  ExpectedReportingCadence
} from "./types";

function isWeekday(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

function worstSeverity(severities: DataHealthSeverity[]): DataHealthSeverity {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warning")) return "warning";
  if (severities.includes("info")) return "info";
  return "healthy";
}

export function buildDataHealthReport(input: {
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  analysis: DynamicAnalysisResult;
  expectedCadence?: ExpectedReportingCadence;
}): DataHealthReport {
  const { tableProfile, understanding, analysis } = input;
  const expectedCadence = input.expectedCadence || "irregular";
  const checks: DataHealthCheck[] = [];
  let score = 100;

  const penalize = (severity: DataHealthSeverity) => {
    if (severity === "critical") score -= 25;
    else if (severity === "warning") score -= 12;
    else if (severity === "info") score -= 3;
  };

  // 1. Empty table check
  if (tableProfile.isEmpty) {
    checks.push({
      id: "empty_table",
      category: "completeness",
      title: "Source table is empty",
      status: "critical",
      affectedFields: [tableProfile.name],
      metricValue: "0 rows",
      explanation: `Table "${tableProfile.name}" currently contains 0 rows; no live metrics can be calculated.`,
      remediation: "Verify that source data pipelines or operational writes are populating this table."
    });
    penalize("critical");
  }

  // 2. Source-data freshness (explicitly distinct from analysis generation timestamp)
  const freshness = tableProfile.freshness;
  if (!tableProfile.isEmpty) {
    if (freshness.status === "stale") {
      const sev: DataHealthSeverity = expectedCadence === "daily" || expectedCadence === "weekdays" ? "warning" : "info";
      checks.push({
        id: "source_freshness",
        category: "freshness",
        title: "Source data appears stale",
        status: sev,
        affectedFields: freshness.primaryDateColumn ? [freshness.primaryDateColumn] : [],
        metricValue: freshness.latestDate ? `Latest: ${freshness.latestDate.slice(0, 10)} (${freshness.ageHours ?? "?"}h old)` : "Unknown",
        explanation: `Latest source record timestamp is ${freshness.latestDate || "unknown"} (distinct from analysis run at ${analysis.generatedAt}). Expected cadence is "${expectedCadence}".`,
        remediation: "Check whether upstream data sync is delayed or if this dataset intentionally updates less frequently."
      });
      penalize(sev);
    } else if (freshness.status === "unknown") {
      checks.push({
        id: "source_freshness",
        category: "freshness",
        title: "No populated temporal column for freshness tracking",
        status: "warning",
        affectedFields: [],
        metricValue: "Unknown",
        explanation: "Could not determine when source records were last updated because no populated date/timestamp column was found.",
        remediation: "Ensure the table includes a populated date or timestamp column mapped to the domain's primary date role."
      });
      penalize("warning");
    } else {
      checks.push({
        id: "source_freshness",
        category: "freshness",
        title: "Source data freshness healthy",
        status: "healthy",
        affectedFields: freshness.primaryDateColumn ? [freshness.primaryDateColumn] : [],
        metricValue: freshness.latestDate ? `${freshness.latestDate.slice(0, 10)} (${freshness.ageHours ?? 0}h ago)` : "Fresh",
        explanation: `Latest source record in "${freshness.primaryDateColumn}" is ${freshness.latestDate} (analysis generated at ${analysis.generatedAt}).`,
        remediation: "No action required."
      });
    }
  }

  // 3. Missing required semantic fields & ambiguous columns (domain-specific)
  if (understanding.missingRequiredRoles.length > 0) {
    checks.push({
      id: "missing_required_fields",
      category: "schema",
      title: "Missing required domain fields",
      status: "critical",
      affectedFields: understanding.missingRequiredRoles,
      metricValue: `${understanding.missingRequiredRoles.length} missing`,
      explanation: `${understanding.domainName} requires semantic field(s): ${understanding.missingRequiredRoles.join(", ")}.`,
      remediation: "Confirm column mappings or select a table/view that includes the required fields."
    });
    penalize("critical");
  } else if (understanding.ambiguousColumns.length > 0) {
    checks.push({
      id: "ambiguous_columns",
      category: "schema",
      title: "Ambiguous column mappings detected",
      status: "warning",
      affectedFields: understanding.ambiguousColumns,
      metricValue: `${understanding.ambiguousColumns.length} ambiguous`,
      explanation: `Column(s) ${understanding.ambiguousColumns.join(", ")} matched multiple roles or lacked high-confidence certainty.`,
      remediation: "Confirm explicit column mappings in dataset configuration so dependent metrics can be enabled safely."
    });
    penalize("warning");
  }

  // 4. Null percentage check across mapped semantic columns (excluding sensitive PII exposure)
  const mappedColumnNames = new Set(Object.values(understanding.roleAssignments).map(r => r.columnName));
  const highNullCols = tableProfile.columns.filter(c =>
    (mappedColumnNames.size === 0 || mappedColumnNames.has(c.name)) && c.nullPercent >= 15
  );
  if (highNullCols.length > 0) {
    const maxNull = Math.max(...highNullCols.map(c => c.nullPercent));
    const sev: DataHealthSeverity = maxNull >= 50 ? "critical" : "warning";
    checks.push({
      id: "null_values",
      category: "completeness",
      title: "Elevated null values in analytical columns",
      status: sev,
      affectedFields: highNullCols.map(c => c.name),
      metricValue: `Up to ${maxNull.toFixed(1)}% null`,
      explanation: `Column(s) with >= 15% missing values: ${highNullCols.map(c => `${c.name} (${c.nullPercent.toFixed(1)}%)`).join(", ")}.`,
      remediation: "Backfill missing values at the source or confirm whether nulls are expected for optional attributes."
    });
    penalize(sev);
  }

  // 5. Duplicate key indicators
  if (tableProfile.duplicates.hasDuplicates === true && (tableProfile.duplicates.duplicateRowCount || 0) > 0) {
    const dupCount = tableProfile.duplicates.duplicateRowCount || 0;
    const dupPct = tableProfile.rowCount > 0 ? safeRound((dupCount / tableProfile.rowCount) * 100, 1) : 0;
    const sev: DataHealthSeverity = dupPct >= 5 ? "critical" : "warning";
    checks.push({
      id: "duplicate_records",
      category: "duplicates",
      title: "Duplicate key records detected",
      status: sev,
      affectedFields: tableProfile.duplicates.keyColumns,
      metricValue: `${dupCount} duplicate row(s) (${dupPct}%)`,
      explanation: `Found ${dupCount} duplicate row(s) across ${tableProfile.duplicates.duplicateGroupCount} group(s) on key (${tableProfile.duplicates.keyColumns.join(", ")}).`,
      remediation: "Deduplicate records in an upstream view or verify whether multiple line items share the same key intentionally."
    });
    penalize(sev);
  }

  // 6. Invalid dates / timestamp sequences / data quality warnings from Stage 2
  const validityWarnings = analysis.dataQualityWarnings.filter(w =>
    /invalid|negative|unparseable|non-recurring/i.test(w)
  );
  if (validityWarnings.length > 0) {
    checks.push({
      id: "invalid_values",
      category: "validity",
      title: "Invalid dates, timestamps, or inconsistent values detected",
      status: "warning",
      affectedFields: [],
      metricValue: `${validityWarnings.length} issue(s)`,
      explanation: validityWarnings.join(" "),
      remediation: "Clean malformed dates or out-of-order timestamps in source records; invalid rows were safely excluded from averages."
    });
    penalize("warning");
  }

  // 7. Unexpected volume changes vs comparison period
  if (analysis.comparisonPeriod && analysis.source.rowCountInComparison > 0) {
    const currDailyRows = analysis.source.rowCountInPeriod / analysis.reportingPeriod.dayCount;
    const compDailyRows = analysis.source.rowCountInComparison / analysis.comparisonPeriod.dayCount;
    const volChange = safeChangePercent(currDailyRows, compDailyRows);
    if (volChange !== null && (volChange <= -60 || volChange >= 200)) {
      checks.push({
        id: "volume_anomaly",
        category: "volume",
        title: volChange < 0 ? "Sharp drop in record volume" : "Unusual surge in record volume",
        status: "warning",
        affectedFields: [tableProfile.name],
        metricValue: `${volChange >= 0 ? "+" : ""}${volChange.toFixed(1)}% daily rows`,
        explanation: `Daily record volume changed from ${compDailyRows.toFixed(1)}/day in comparison to ${currDailyRows.toFixed(1)}/day in ${analysis.reportingPeriod.label}.`,
        remediation: "Confirm whether this reflects a real business event, duplicate ingestion, or partial data load."
      });
      penalize("warning");
    }
  }

  // 8. Missing expected reporting dates (ONLY checked when expectedCadence is daily or weekdays!)
  const expectedDatesMissing: string[] = [];
  if (expectedCadence === "daily" || expectedCadence === "weekdays") {
    const datesWithData = new Set(
      analysis.timeSeries.filter(pt => pt.recordCount > 0).map(pt => pt.date)
    );
    for (const d of enumerateDates(analysis.reportingPeriod.start, analysis.reportingPeriod.end)) {
      if (expectedCadence === "weekdays" && !isWeekday(d)) continue;
      if (!datesWithData.has(d)) expectedDatesMissing.push(d);
    }
    if (expectedDatesMissing.length > 0) {
      checks.push({
        id: "missing_expected_dates",
        category: "coverage",
        title: "Missing expected reporting dates",
        status: expectedDatesMissing.length >= 3 ? "warning" : "info",
        affectedFields: freshness.primaryDateColumn ? [freshness.primaryDateColumn] : [],
        metricValue: `${expectedDatesMissing.length} missing day(s)`,
        explanation: `Under "${expectedCadence}" cadence, no records were observed on: ${expectedDatesMissing.slice(0, 7).join(", ")}${expectedDatesMissing.length > 7 ? "…" : ""}.`,
        remediation: "Confirm whether the organisation was closed on those dates or if data ingestion missed those days."
      });
      penalize(expectedDatesMissing.length >= 3 ? "warning" : "info");
    }
  }

  const earliestDate = freshness.earliestDate ? freshness.earliestDate.slice(0, 10) : null;
  const latestDate = freshness.latestDate ? freshness.latestDate.slice(0, 10) : null;
  const coveredDays = earliestDate && latestDate
    ? Math.max(1, Math.round((Date.parse(`${latestDate}T00:00:00Z`) - Date.parse(`${earliestDate}T00:00:00Z`)) / 86_400_000) + 1)
    : 0;

  if (checks.length === 0) {
    checks.push({
      id: "overall_healthy",
      category: "completeness",
      title: "All automated data health checks passed",
      status: "healthy",
      affectedFields: [],
      metricValue: "100 / 100",
      explanation: "No schema gaps, excessive nulls, duplicates, or invalid timestamp anomalies were detected.",
      remediation: "No action required."
    });
  }

  return {
    tableName: tableProfile.name,
    domainId: understanding.domainId,
    sourceFreshness: freshness,
    analysisGeneratedAt: analysis.generatedAt,
    expectedCadence,
    overallStatus: worstSeverity(checks.map(c => c.status)),
    healthScore: Math.max(0, Math.min(100, score)),
    historicalCoverage: {
      earliestDate,
      latestDate,
      coveredDays,
      expectedDatesMissing
    },
    checks,
    generatedAt: new Date().toISOString()
  };
}
