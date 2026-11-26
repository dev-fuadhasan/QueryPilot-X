import { createHash } from "node:crypto";
import type { BusinessDomainId, DomainTableUnderstanding, TableProfile } from "../profiler/types";
import {
  detectNumericDateOrder,
  isSensitiveColumnName,
  isValidIdentifier,
  tokenizeName,
  type NumericDateOrder
} from "../profiler/sql-safety";
import { createRoleAccessor, runDomainCalculator, type RoleAccessor } from "../metrics/domain-calculators";
import { PRIMARY_DATE_ROLE_BY_DOMAIN } from "../metrics/engine";
import { DOMAIN_METRIC_DEFINITIONS } from "../metrics/metric-definitions";
import {
  formatMetricValue,
  safeChangePercent,
  safeRound,
  toDateKeyInTimezone
} from "../metrics/math-and-periods";
import type {
  ComparisonWindow,
  DynamicAnalysisResult,
  MetricResult,
  PeriodWindow
} from "../metrics/types";
import { DOMAIN_DIMENSIONS } from "./root-cause";
import type {
  BriefFinding,
  ComponentMetricDriver,
  DailyTrendPoint,
  DailyTrendSummary,
  DataHealthReport,
  DimensionBreakdownInvestigation,
  DuplicateInvestigationDetail,
  FindingInvestigationResult,
  FindingInvestigationStatus,
  FindingInvestigationType,
  InvestigationSegmentRow,
  MissingDataInvestigationDetail,
  RootCauseAnalysisResult
} from "./types";

const MAX_INVESTIGATION_DIMENSIONS = 6;
const MAX_SEGMENTS_PER_DIMENSION = 10;
const MAX_DIMENSION_CARDINALITY = 35;
const MIN_DIMENSION_CARDINALITY = 2;
const MAX_CACHED_INVESTIGATIONS = 128;

/**
 * Bounded in-memory LRU cache preventing redundant recomputation when the exact same
 * finding + dataset snapshot + reporting/reference window is investigated repeatedly.
 */
const investigationResultCache = new Map<string, FindingInvestigationResult>();

export function clearFindingInvestigationCache(): void {
  investigationResultCache.clear();
}

export function getFindingInvestigationCacheSize(): number {
  return investigationResultCache.size;
}

function humanizeColumnLabel(colName: string): string {
  return colName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,%\s,]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildRowsFingerprint(
  tableProfile: TableProfile,
  analysis: DynamicAnalysisResult,
  periodRows: Array<Record<string, unknown>>,
  comparisonRows: Array<Record<string, unknown>>
): string {
  const hash = createHash("sha256");
  hash.update([
    tableProfile.schema,
    tableProfile.name,
    String(tableProfile.rowCount),
    analysis.domainId,
    analysis.reportingPeriod.start,
    analysis.reportingPeriod.end,
    analysis.comparisonPeriod?.start || "none",
    analysis.comparisonPeriod?.end || "none",
    String(periodRows.length),
    String(comparisonRows.length),
    analysis.availableMetrics.map(m => `${m.metricId}:${m.value ?? "n"}:${m.comparisonValue ?? "n"}`).join("|")
  ].join("::"));
  if (periodRows.length > 0) {
    hash.update(JSON.stringify(periodRows[0]));
    hash.update(JSON.stringify(periodRows[periodRows.length - 1]));
  }
  if (comparisonRows.length > 0) {
    hash.update(JSON.stringify(comparisonRows[0]));
  }
  return hash.digest("hex").slice(0, 20);
}

function putInCache(key: string, result: FindingInvestigationResult): void {
  if (investigationResultCache.size >= MAX_CACHED_INVESTIGATIONS) {
    const firstKey = investigationResultCache.keys().next().value;
    if (firstKey) investigationResultCache.delete(firstKey);
  }
  investigationResultCache.set(key, result);
}

/* ============================================================================
 * 1. CLASSIFICATION & PLANNING
 * ============================================================================ */

function classifyInvestigationType(finding: BriefFinding): FindingInvestigationType {
  const idLower = finding.id.toLowerCase();
  const headlineLower = finding.headline.toLowerCase();

  if (finding.category === "data_gap") {
    if (idLower.includes("duplicate") || headlineLower.includes("duplicate")) {
      return "duplicate_data";
    }
    if (
      idLower.includes("insufficient")
      || idLower.includes("missing")
      || idLower.includes("null")
      || headlineLower.includes("missing")
      || headlineLower.includes("null")
      || headlineLower.includes("insufficient")
    ) {
      return "missing_data";
    }
    return "data_quality";
  }

  if (finding.category === "negative") return "metric_deterioration";
  if (finding.category === "positive") return "metric_improvement";
  if (finding.category === "unusual") return "unusual_activity";
  return "domain_event";
}

function resolveDateColumnForInvestigation(
  tableProfile: TableProfile,
  understanding: DomainTableUnderstanding,
  domainId: BusinessDomainId
): string | null {
  const primaryDateRole = PRIMARY_DATE_ROLE_BY_DOMAIN[domainId];
  const mapped = understanding.roleAssignments[primaryDateRole]?.columnName;
  if (mapped && isValidIdentifier(mapped) && !isSensitiveColumnName(mapped)) {
    const meta = tableProfile.columns.find(c => c.name === mapped);
    if (meta && meta.supported) return mapped;
  }
  if (tableProfile.freshness.primaryDateColumn && isValidIdentifier(tableProfile.freshness.primaryDateColumn)) {
    return tableProfile.freshness.primaryDateColumn;
  }
  const fallback = tableProfile.columns.find(
    c => c.category === "temporal" && c.supported && !c.isSensitive && isValidIdentifier(c.name)
  );
  return fallback?.name ?? null;
}

function resolveDateOrder(
  tableProfile: TableProfile,
  dateColumn: string | null,
  rows: Array<Record<string, unknown>>
): NumericDateOrder | undefined {
  if (!dateColumn) return undefined;
  const colMeta = tableProfile.columns.find(c => c.name === dateColumn);
  const fmt = colMeta?.temporalStats?.detectedFormat;
  if (fmt === "dmy" || fmt === "mdy") return fmt;
  if (rows.length > 0) {
    return detectNumericDateOrder(rows.map(r => r[dateColumn])) ?? undefined;
  }
  return undefined;
}

/* ============================================================================
 * 2. EXACT METRIC EVALUATION FOR SUBSETS (DAILY & SEGMENT-LEVEL)
 *    Reuses existing domain calculators so ratio/margin/ASP/AOV metrics ALWAYS
 *    compute from aggregated numerator / denominator (never averaging row %).
 * ============================================================================ */

function evaluateMetricOnSubset(input: {
  metric: MetricResult;
  rows: Array<Record<string, unknown>>;
  domainId: BusinessDomainId;
  understanding: DomainTableUnderstanding;
  period: PeriodWindow;
  accessor: RoleAccessor;
}): number | null {
  const { metric, rows, domainId, understanding, period, accessor } = input;
  if (rows.length === 0) return null;

  // Direct dataset-column metric (`col_*`)
  if (metric.metricId === "col_record_count") {
    return rows.length;
  }
  if (metric.metricId.startsWith("col_")) {
    const colName = metric.sourceFields[0]?.columnName;
    if (!colName) return null;
    const isAvg = metric.name.startsWith("Avg ");
    let sum = 0;
    let count = 0;
    for (const row of rows) {
      const n = parseNumeric(row[colName]);
      if (n !== null) {
        sum += n;
        count += 1;
      }
    }
    if (count === 0) return null;
    return safeRound(isAvg ? sum / count : sum, 2);
  }

  // Domain metric: delegate directly to existing domain calculator so all domain rules,
  // zero-denominator guards, order deduplication, and numerator/denominator ratios stay identical!
  const calc = runDomainCalculator(domainId, {
    understanding,
    allRows: rows,
    periodRows: rows,
    comparisonRows: [],
    period,
    comparison: null,
    options: {
      domainId,
      periodStart: period.start,
      periodEnd: period.end,
      timezone: period.timezone,
      comparisonPreset: "none"
    },
    accessor
  });

  if (calc.unavailableOverrides[metric.metricId]) {
    return null;
  }
  const value = calc.values[metric.metricId];
  return value !== undefined && value !== null && Number.isFinite(value) ? value : null;
}

/* ============================================================================
 * 3. AUTOMATIC DAILY TIME-SERIES INVESTIGATION
 * ============================================================================ */

function runDailyTimeSeriesInvestigation(input: {
  metric: MetricResult;
  dateColumn: string | null;
  dateOrder: NumericDateOrder | undefined;
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  domainId: BusinessDomainId;
  understanding: DomainTableUnderstanding;
  period: PeriodWindow;
  comparison: ComparisonWindow | null;
  accessor: RoleAccessor;
}): DailyTrendSummary {
  const {
    metric,
    dateColumn,
    dateOrder,
    periodRows,
    comparisonRows,
    domainId,
    understanding,
    period,
    comparison,
    accessor
  } = input;

  if (!dateColumn) {
    return {
      available: false,
      dateColumn: null,
      points: [],
      largestDeteriorationDate: null,
      largestDeteriorationValue: null,
      largestImprovementDate: null,
      largestImprovementValue: null,
      largestDayOverDayChange: null,
      unusualDates: [],
      trendPattern: "unavailable",
      summary: "Daily time-series investigation unavailable because no valid date column was detected in the dataset."
    };
  }

  const byDate = new Map<string, Array<Record<string, unknown>>>();
  for (const row of periodRows) {
    const dateKey = toDateKeyInTimezone(row[dateColumn], period.timezone, dateOrder);
    if (!dateKey) continue;
    const list = byDate.get(dateKey) || [];
    list.push(row);
    byDate.set(dateKey, list);
  }

  // If the current reporting period has only 1 day but reference rows exist, include reference dates
  // in chronological context for richer day-over-day comparison without altering current-period scope.
  const referenceByDate = new Map<string, Array<Record<string, unknown>>>();
  if (comparison && comparisonRows.length > 0) {
    for (const row of comparisonRows) {
      const dateKey = toDateKeyInTimezone(row[dateColumn], period.timezone, dateOrder);
      if (!dateKey) continue;
      const list = referenceByDate.get(dateKey) || [];
      list.push(row);
      referenceByDate.set(dateKey, list);
    }
  }

  const sortedCurrentDates = [...byDate.keys()].sort();
  if (sortedCurrentDates.length === 0) {
    return {
      available: false,
      dateColumn,
      points: [],
      largestDeteriorationDate: null,
      largestDeteriorationValue: null,
      largestImprovementDate: null,
      largestImprovementValue: null,
      largestDayOverDayChange: null,
      unusualDates: [],
      trendPattern: "unavailable",
      summary: `No dated records found in "${dateColumn}" for ${period.label}.`
    };
  }

  // Build daily metric values strictly using the metric's existing definition
  const rawPoints: Array<{ date: string; value: number | null; recordCount: number }> = [];
  for (const date of sortedCurrentDates) {
    const dayRows = byDate.get(date) || [];
    const dayPeriod: PeriodWindow = {
      start: date,
      end: date,
      timezone: period.timezone,
      dayCount: 1,
      label: date
    };
    const val = evaluateMetricOnSubset({
      metric,
      rows: dayRows,
      domainId,
      understanding,
      period: dayPeriod,
      accessor
    });
    rawPoints.push({ date, value: val, recordCount: dayRows.length });
  }

  const numericValues = rawPoints.map(p => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (numericValues.length === 0) {
    return {
      available: false,
      dateColumn,
      points: rawPoints.map(p => ({
        date: p.date,
        value: null,
        formattedValue: null,
        recordCount: p.recordCount,
        dayOverDayDelta: null,
        dayOverDayChangePercent: null,
        anomaly: null
      })),
      largestDeteriorationDate: null,
      largestDeteriorationValue: null,
      largestImprovementDate: null,
      largestImprovementValue: null,
      largestDayOverDayChange: null,
      unusualDates: [],
      trendPattern: "unavailable",
      summary: `${metric.name} could not be computed per day (zero denominator or missing values across daily slices).`
    };
  }

  const mean = numericValues.reduce((acc, v) => acc + v, 0) / numericValues.length;
  const variance = numericValues.length >= 3
    ? numericValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / numericValues.length
    : 0;
  const stdDev = Math.sqrt(variance);

  const points: DailyTrendPoint[] = [];
  let largestDod: DailyTrendSummary["largestDayOverDayChange"] = null;
  let largestDet: { date: string; score: number; value: number } | null = null;
  let largestImp: { date: string; score: number; value: number } | null = null;
  const unusualDates: DailyTrendSummary["unusualDates"] = [];

  let consecutiveUp = 0;
  let consecutiveDown = 0;
  let maxConsecutiveUp = 0;
  let maxConsecutiveDown = 0;
  let validTransitions = 0;

  for (let i = 0; i < rawPoints.length; i += 1) {
    const curr = rawPoints[i];
    const prev = i > 0 ? rawPoints[i - 1] : null;
    let dodDelta: number | null = null;
    let dodPct: number | null = null;

    if (curr.value !== null && prev && prev.value !== null) {
      dodDelta = safeRound(curr.value - prev.value, 2);
      dodPct = safeChangePercent(curr.value, prev.value);
      validTransitions += 1;

      if (dodDelta > 0) {
        consecutiveUp += 1;
        consecutiveDown = 0;
        if (consecutiveUp > maxConsecutiveUp) maxConsecutiveUp = consecutiveUp;
      } else if (dodDelta < 0) {
        consecutiveDown += 1;
        consecutiveUp = 0;
        if (consecutiveDown > maxConsecutiveDown) maxConsecutiveDown = consecutiveDown;
      } else {
        consecutiveUp = 0;
        consecutiveDown = 0;
      }

      const magnitude = Math.abs(dodDelta);
      if (!largestDod || magnitude > Math.abs(largestDod.delta)) {
        largestDod = {
          date: curr.date,
          previousDate: prev.date,
          delta: dodDelta,
          changePercent: dodPct,
          formattedCurrent: formatMetricValue(curr.value, metric.format, metric.unit),
          formattedPrevious: formatMetricValue(prev.value, metric.format, metric.unit)
        };
      }

      // Polarity-aware deterioration & improvement tracking
      const favorableDelta = metric.polarity === "lower_is_better" ? -dodDelta : dodDelta;
      if (favorableDelta < 0 && (!largestDet || favorableDelta < largestDet.score)) {
        largestDet = { date: curr.date, score: favorableDelta, value: curr.value };
      }
      if (favorableDelta > 0 && (!largestImp || favorableDelta > largestImp.score)) {
        largestImp = { date: curr.date, score: favorableDelta, value: curr.value };
      }
    }

    let anomaly: "spike" | "drop" | null = null;
    if (curr.value !== null && numericValues.length >= 4 && stdDev > 0) {
      const z = (curr.value - mean) / stdDev;
      if (z >= 1.5) anomaly = "spike";
      else if (z <= -1.5) anomaly = "drop";
    }
    if (!anomaly && dodPct !== null && Math.abs(dodPct) >= 35) {
      anomaly = dodPct > 0 ? "spike" : "drop";
    }

    const formattedValue = formatMetricValue(curr.value, metric.format, metric.unit);
    if (anomaly && curr.value !== null) {
      unusualDates.push({
        date: curr.date,
        kind: anomaly,
        formattedValue,
        note: `${metric.name} recorded an unusual ${anomaly} (${formattedValue}) on ${curr.date}${dodPct !== null ? ` (${dodPct >= 0 ? "+" : ""}${dodPct.toFixed(1)}% vs prior day)` : ""}.`
      });
    }

    points.push({
      date: curr.date,
      value: curr.value,
      formattedValue,
      recordCount: curr.recordCount,
      dayOverDayDelta: dodDelta,
      dayOverDayChangePercent: dodPct,
      anomaly
    });
  }

  // Fallback for single-day periods or monotonic periods without intra-period deterioration
  if (!largestDet && numericValues.length > 0) {
    const worstPoint = rawPoints
      .filter((p): p is { date: string; value: number; recordCount: number } => p.value !== null)
      .sort((a, b) => (metric.polarity === "lower_is_better" ? b.value - a.value : a.value - b.value))[0];
    if (worstPoint && (rawPoints.length === 1 || (metric.changePercent !== null && metric.changePercent < 0))) {
      largestDet = { date: worstPoint.date, score: 0, value: worstPoint.value };
    }
  }
  if (!largestImp && numericValues.length > 0) {
    const bestPoint = rawPoints
      .filter((p): p is { date: string; value: number; recordCount: number } => p.value !== null)
      .sort((a, b) => (metric.polarity === "lower_is_better" ? a.value - b.value : b.value - a.value))[0];
    if (bestPoint && (rawPoints.length === 1 || (metric.changePercent !== null && metric.changePercent > 0))) {
      largestImp = { date: bestPoint.date, score: 0, value: bestPoint.value };
    }
  }

  let trendPattern: DailyTrendSummary["trendPattern"];
  if (rawPoints.length === 1) {
    trendPattern = "single_day";
  } else if (validTransitions >= 2 && maxConsecutiveDown >= Math.max(2, Math.ceil(validTransitions * 0.65))) {
    trendPattern = "continuous_downward";
  } else if (validTransitions >= 2 && maxConsecutiveUp >= Math.max(2, Math.ceil(validTransitions * 0.65))) {
    trendPattern = "continuous_upward";
  } else if (unusualDates.length === 1 && validTransitions >= 2) {
    trendPattern = "isolated_shift";
  } else if (unusualDates.length >= 2) {
    trendPattern = "volatile";
  } else {
    trendPattern = "stable";
  }

  const refDailyNote = referenceByDate.size > 0 && metric.formattedComparisonValue
    ? ` Compared against ${comparison?.label || "reference period"} (${metric.formattedComparisonValue}).`
    : "";

  let summary: string;
  if (trendPattern === "single_day") {
    summary = `${metric.name} was ${points[0].formattedValue} on ${points[0].date} across ${points[0].recordCount} record(s).${refDailyNote}`;
  } else if (trendPattern === "continuous_downward") {
    summary = `Persistent downward trajectory detected across ${rawPoints.length} day(s); largest decline occurred on ${largestDet?.date || sortedCurrentDates[sortedCurrentDates.length - 1]}.${refDailyNote}`;
  } else if (trendPattern === "continuous_upward") {
    summary = `Persistent upward trajectory detected across ${rawPoints.length} day(s); strongest daily gain occurred on ${largestImp?.date || sortedCurrentDates[sortedCurrentDates.length - 1]}.${refDailyNote}`;
  } else if (trendPattern === "isolated_shift" && unusualDates[0]) {
    summary = `Change appears isolated primarily to ${unusualDates[0].date} (${unusualDates[0].kind}: ${unusualDates[0].formattedValue}) across ${rawPoints.length} observed day(s).${refDailyNote}`;
  } else if (largestDod) {
    summary = `Observed across ${rawPoints.length} day(s); largest day-over-day shift occurred on ${largestDod.date} (${largestDod.delta >= 0 ? "+" : ""}${largestDod.delta}${largestDod.changePercent !== null ? `, ${largestDod.changePercent >= 0 ? "+" : ""}${largestDod.changePercent.toFixed(1)}%` : ""}).${refDailyNote}`;
  } else {
    summary = `${metric.name} remained relatively stable across ${rawPoints.length} observed day(s).${refDailyNote}`;
  }

  return {
    available: true,
    dateColumn,
    points,
    largestDeteriorationDate: largestDet?.date ?? null,
    largestDeteriorationValue: largestDet ? formatMetricValue(largestDet.value, metric.format, metric.unit) : null,
    largestImprovementDate: largestImp?.date ?? null,
    largestImprovementValue: largestImp ? formatMetricValue(largestImp.value, metric.format, metric.unit) : null,
    largestDayOverDayChange: largestDod,
    unusualDates,
    trendPattern,
    summary
  };
}

/* ============================================================================
 * 4. AUTOMATIC SEGMENT BREAKDOWN INVESTIGATION
 * ============================================================================ */

type CandidateDimension = {
  dimensionId: string;
  label: string;
  sourceColumn: string;
  priority: number;
};

const UNSUITABLE_DIMENSION_TOKENS = new Set([
  "id",
  "uuid",
  "guid",
  "email",
  "phone",
  "mobile",
  "address",
  "street",
  "zip",
  "postal",
  "url",
  "link",
  "note",
  "notes",
  "comment",
  "comments",
  "description",
  "desc",
  "timestamp",
  "date",
  "datetime",
  "password",
  "token",
  "secret"
]);

const PREFERRED_SEGMENT_TOKENS = new Set([
  "category",
  "region",
  "channel",
  "segment",
  "country",
  "city",
  "state",
  "device",
  "platform",
  "campaign",
  "department",
  "warehouse",
  "supplier",
  "vendor",
  "carrier",
  "payment",
  "method",
  "type",
  "tier",
  "plan",
  "rep",
  "brand",
  "product",
  "status",
  "stage",
  "gender",
  "source",
  "medium"
]);

function selectSafeInvestigationDimensions(
  tableProfile: TableProfile,
  understanding: DomainTableUnderstanding,
  domainId: BusinessDomainId,
  dateColumn: string | null,
  periodRows: Array<Record<string, unknown>>
): CandidateDimension[] {
  const seenColumns = new Set<string>();
  const results: CandidateDimension[] = [];
  const colByName = new Map(tableProfile.columns.map(c => [c.name, c]));

  const isSafeDimensionColumn = (colName: string): boolean => {
    if (!isValidIdentifier(colName)) return false;
    if (dateColumn && colName === dateColumn) return false;
    if (isSensitiveColumnName(colName)) return false;
    const meta = colByName.get(colName);
    if (!meta || !meta.supported || meta.isSensitive || meta.isPrimaryKey || meta.isForeignKey) return false;
    if (meta.category === "temporal" || meta.category === "numeric" || meta.category === "identifier" || meta.category === "unsupported") {
      return false;
    }
    const tokens = tokenizeName(colName);
    if (tokens.some(t => UNSUITABLE_DIMENSION_TOKENS.has(t))) return false;

    // Check actual cardinality either from profiler stats or active rows
    let distinct = meta.distinctCount;
    if (distinct === null && periodRows.length > 0) {
      const vals = new Set<string>();
      for (const row of periodRows) {
        const v = row[colName];
        if (v !== null && v !== undefined && String(v).trim() !== "") {
          vals.add(String(v).trim());
        }
      }
      distinct = vals.size;
    }
    if (distinct !== null && (distinct < MIN_DIMENSION_CARDINALITY || distinct > MAX_DIMENSION_CARDINALITY)) {
      return false;
    }
    if (meta.cardinalityRatio !== null && meta.cardinalityRatio > 0.6 && tableProfile.rowCount >= 20) {
      return false;
    }
    return true;
  };

  // 1. Domain-profile mapped dimensions first (highest semantic priority)
  const domainSpecs = DOMAIN_DIMENSIONS[domainId] || [];
  for (const spec of domainSpecs) {
    const assigned = understanding.roleAssignments[spec.role];
    if (assigned && assigned.confidence !== "low" && !seenColumns.has(assigned.columnName) && isSafeDimensionColumn(assigned.columnName)) {
      seenColumns.add(assigned.columnName);
      results.push({
        dimensionId: spec.dimensionId,
        label: spec.label,
        sourceColumn: assigned.columnName,
        priority: 100
      });
    }
  }

  // 2. Additional semantic roles & high-signal categorical columns (e.g. Sales_Rep, Customer_Type, Payment_Method, Device_Type, Country)
  for (const col of tableProfile.columns) {
    if (seenColumns.has(col.name)) continue;
    if (!isSafeDimensionColumn(col.name)) continue;
    const tokens = tokenizeName(col.name);
    const hasPreferredToken = tokens.some(t => PREFERRED_SEGMENT_TOKENS.has(t));
    seenColumns.add(col.name);
    results.push({
      dimensionId: `col_${col.name.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      label: humanizeColumnLabel(col.name),
      sourceColumn: col.name,
      priority: hasPreferredToken ? 70 : 40
    });
  }

  return results
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_INVESTIGATION_DIMENSIONS);
}

function classifySegmentDirection(
  metric: MetricResult,
  currentValue: number | null,
  referenceValue: number | null,
  absoluteDelta: number | null
): InvestigationSegmentRow["direction"] {
  if (currentValue !== null && referenceValue === null) return "new";
  if (currentValue === null && referenceValue !== null) return "disappeared";
  if (absoluteDelta === null) return "unknown";
  if (Math.abs(absoluteDelta) < 0.005) return "stable";
  if (metric.polarity === "lower_is_better") {
    return absoluteDelta < 0 ? "improved" : "deteriorated";
  }
  if (metric.polarity === "neutral") {
    return absoluteDelta > 0 ? "improved" : "deteriorated";
  }
  return absoluteDelta > 0 ? "improved" : "deteriorated";
}

function runSegmentBreakdownInvestigation(input: {
  metric: MetricResult;
  findingType: FindingInvestigationType;
  dimensions: CandidateDimension[];
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  domainId: BusinessDomainId;
  understanding: DomainTableUnderstanding;
  period: PeriodWindow;
  comparison: ComparisonWindow | null;
  accessor: RoleAccessor;
}): {
  breakdowns: DimensionBreakdownInvestigation[];
  topSegments: InvestigationSegmentRow[];
} {
  const {
    metric,
    findingType,
    dimensions,
    periodRows,
    comparisonRows,
    domainId,
    understanding,
    period,
    comparison,
    accessor
  } = input;

  const metricDef = (DOMAIN_METRIC_DEFINITIONS[domainId] || []).find(d => d.id === metric.metricId);
  const isAdditiveVolume = metric.format !== "percentage" &&
    metric.format !== "ratio" &&
    (metricDef ? metricDef.aggregation === "sum" : metric.format === "currency" || metric.format === "count" || metric.format === "quantity");
  const normalizeScale = isAdditiveVolume && comparison && period.dayCount !== comparison.dayCount
    ? period.dayCount / comparison.dayCount
    : 1;
  const totalDelta = metric.value !== null && metric.comparisonValue !== null
    ? safeRound(metric.value - metric.comparisonValue, 2)
    : null;

  const breakdowns: DimensionBreakdownInvestigation[] = [];
  const allRankedSegments: InvestigationSegmentRow[] = [];

  for (const dim of dimensions) {
    const currGroups = new Map<string, Array<Record<string, unknown>>>();
    const compGroups = new Map<string, Array<Record<string, unknown>>>();

    for (const row of periodRows) {
      const raw = row[dim.sourceColumn];
      const label = raw === null || raw === undefined || String(raw).trim() === "" ? "Unspecified" : String(raw).trim();
      const list = currGroups.get(label) || [];
      list.push(row);
      currGroups.set(label, list);
    }
    for (const row of comparisonRows) {
      const raw = row[dim.sourceColumn];
      const label = raw === null || raw === undefined || String(raw).trim() === "" ? "Unspecified" : String(raw).trim();
      const list = compGroups.get(label) || [];
      list.push(row);
      compGroups.set(label, list);
    }

    const labels = new Set<string>([...currGroups.keys(), ...compGroups.keys()]);
    if (labels.size === 0) continue;

    const segments: InvestigationSegmentRow[] = [];
    for (const label of labels) {
      const cRows = currGroups.get(label) || [];
      const rRows = compGroups.get(label) || [];
      const currVal = cRows.length > 0
        ? evaluateMetricOnSubset({ metric, rows: cRows, domainId, understanding, period, accessor })
        : null;
      const rawRefVal = rRows.length > 0 && comparison
        ? evaluateMetricOnSubset({
            metric,
            rows: rRows,
            domainId,
            understanding,
            period: {
              start: comparison.start,
              end: comparison.end,
              timezone: comparison.timezone,
              dayCount: comparison.dayCount,
              label: comparison.label
            },
            accessor
          })
        : null;
      const refVal = rawRefVal !== null ? safeRound(rawRefVal * normalizeScale, 2) : null;

      if (currVal === null && refVal === null) continue;

      const delta = currVal !== null && refVal !== null ? safeRound(currVal - refVal, 2) : null;
      const changePercent = currVal !== null && refVal !== null ? safeChangePercent(currVal, refVal) : null;
      const contributionPercent = isAdditiveVolume && delta !== null && totalDelta !== null && Math.abs(totalDelta) > 0.0001
        ? safeRound((Math.abs(delta) / Math.abs(totalDelta)) * 100, 1)
        : null;

      const direction = classifySegmentDirection(metric, currVal, refVal, delta);
      const formattedCurrent = formatMetricValue(currVal, metric.format, metric.unit);
      const formattedRef = formatMetricValue(refVal, metric.format, metric.unit);

      const evidence = delta !== null
        ? `${dim.label} "${label}": ${formattedCurrent ?? "N/A"} vs ${formattedRef ?? "N/A"} (${delta >= 0 ? "+" : ""}${delta}${changePercent !== null ? `, ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}%` : ""}${contributionPercent !== null ? `, ~${contributionPercent.toFixed(1)}% share of total change` : ""})`
        : `${dim.label} "${label}": ${formattedCurrent ?? "N/A"} (${cRows.length} record(s))`;

      segments.push({
        dimensionId: dim.dimensionId,
        dimensionLabel: dim.label,
        sourceColumn: dim.sourceColumn,
        groupLabel: label,
        currentValue: currVal,
        formattedCurrentValue: formattedCurrent,
        referenceValue: refVal,
        formattedReferenceValue: formattedRef,
        absoluteDelta: delta,
        changePercent,
        contributionPercent,
        recordCount: cRows.length,
        referenceRecordCount: rRows.length,
        direction,
        evidence
      });
    }

    if (segments.length === 0) continue;

    // Rank segments according to finding direction (deterioration -> worst declines first; improvement -> best gains first)
    segments.sort((a, b) => {
      if (a.absoluteDelta !== null && b.absoluteDelta !== null) {
        if (findingType === "metric_deterioration") {
          const aBad = a.direction === "deteriorated" ? 1 : 0;
          const bBad = b.direction === "deteriorated" ? 1 : 0;
          if (aBad !== bBad) return bBad - aBad;
        } else if (findingType === "metric_improvement") {
          const aGood = a.direction === "improved" ? 1 : 0;
          const bGood = b.direction === "improved" ? 1 : 0;
          if (aGood !== bGood) return bGood - aGood;
        }
        return Math.abs(b.absoluteDelta) - Math.abs(a.absoluteDelta);
      }
      return Math.abs(b.currentValue ?? 0) - Math.abs(a.currentValue ?? 0);
    });

    const trimmed = segments.slice(0, MAX_SEGMENTS_PER_DIMENSION);
    const topAffectedSegment = trimmed[0] || null;
    if (topAffectedSegment) allRankedSegments.push(topAffectedSegment);

    breakdowns.push({
      dimensionId: dim.dimensionId,
      dimensionLabel: dim.label,
      sourceColumn: dim.sourceColumn,
      segments: trimmed,
      topAffectedSegment,
      improvedCount: segments.filter(s => s.direction === "improved").length,
      deterioratedCount: segments.filter(s => s.direction === "deteriorated").length,
      stableCount: segments.filter(s => s.direction === "stable").length
    });
  }

  allRankedSegments.sort((a, b) => {
    if (a.absoluteDelta !== null && b.absoluteDelta !== null) {
      return Math.abs(b.absoluteDelta) - Math.abs(a.absoluteDelta);
    }
    return Math.abs(b.currentValue ?? 0) - Math.abs(a.currentValue ?? 0);
  });

  return {
    breakdowns,
    topSegments: allRankedSegments.slice(0, 6)
  };
}

/* ============================================================================
 * 5. METRIC-SPECIFIC RELATED DRIVER INSPECTION
 * ============================================================================ */

const RELATED_DRIVER_MAP: Record<string, string[]> = {
  grossProfitMargin: ["grossProfit", "totalRevenue", "totalDiscounts", "averageSellingPrice", "unitsSold"],
  grossProfit: ["totalRevenue", "unitsSold", "averageSellingPrice", "totalDiscounts", "grossProfitMargin"],
  totalRevenue: ["totalOrders", "unitsSold", "averageOrderValue", "averageSellingPrice", "totalDiscounts"],
  averageSellingPrice: ["totalRevenue", "unitsSold", "totalDiscounts", "grossProfitMargin"],
  averageOrderValue: ["totalRevenue", "totalOrders", "unitsSold", "totalDiscounts"],
  totalDiscounts: ["grossProfit", "grossProfitMargin", "totalRevenue", "unitsSold"],
  cancellationRate: ["totalOrders", "totalRevenue", "returnRate"],
  returnRate: ["totalOrders", "totalRevenue", "cancellationRate"],
  roas: ["attributedRevenue", "campaignSpend", "conversions", "conversionRate"],
  cpa: ["campaignSpend", "conversions", "clicks", "cpc"],
  cpc: ["campaignSpend", "clicks", "impressions", "ctr"],
  ctr: ["clicks", "impressions", "conversions"],
  netCashFlow: ["totalIncome", "totalExpenses", "totalTax", "budgetVariance"],
  budgetVariance: ["totalExpenses", "totalIncome", "netCashFlow"],
  onTimeDeliveryRate: ["delayedDeliveries", "totalShipments", "averageProcessingTime"],
  delayedDeliveries: ["totalShipments", "onTimeDeliveryRate", "averageProcessingTime"],
  stockTurnover: ["availableStock", "stockMovement", "reorderAlerts"],
  reorderAlerts: ["availableStock", "stockMovement", "stockTurnover"]
};

function collectRelatedMetricDrivers(
  metric: MetricResult,
  analysis: DynamicAnalysisResult
): ComponentMetricDriver[] {
  const byId = new Map(analysis.availableMetrics.map(m => [m.metricId, m]));
  const preferredIds = RELATED_DRIVER_MAP[metric.metricId] || [];
  const drivers: ComponentMetricDriver[] = [];
  const seen = new Set<string>([metric.metricId]);

  for (const relId of preferredIds) {
    const rel = byId.get(relId);
    if (!rel || seen.has(rel.metricId)) continue;
    seen.add(rel.metricId);
    const note = rel.changePercent !== null
      ? `${rel.name} moved ${rel.changePercent >= 0 ? "+" : ""}${rel.changePercent.toFixed(1)}% (${rel.formattedValue} vs ${rel.formattedComparisonValue}).`
      : `${rel.name} stood at ${rel.formattedValue}.`;
    drivers.push({
      metricId: rel.metricId,
      metricName: rel.name,
      currentValue: rel.formattedValue,
      referenceValue: rel.formattedComparisonValue,
      changePercent: rel.changePercent,
      note
    });
  }

  // Dynamic fallback: include sibling domain metrics that also shifted significantly
  if (drivers.length === 0) {
    for (const m of analysis.availableMetrics) {
      if (seen.has(m.metricId) || drivers.length >= 4) break;
      if (m.changePercent !== null && Math.abs(m.changePercent) >= 5) {
        seen.add(m.metricId);
        drivers.push({
          metricId: m.metricId,
          metricName: m.name,
          currentValue: m.formattedValue,
          referenceValue: m.formattedComparisonValue,
          changePercent: m.changePercent,
          note: `${m.name} changed ${m.changePercent >= 0 ? "+" : ""}${m.changePercent.toFixed(1)}% (${m.formattedValue} vs ${m.formattedComparisonValue}).`
        });
      }
    }
  }

  return drivers;
}

/* ============================================================================
 * 6. DUPLICATE & MISSING DATA INVESTIGATIONS
 * ============================================================================ */

const NON_TRANSACTIONAL_ENTITY_RE = /^(?:product|item|sku|customer|client|user|member|account|store|warehouse|region|category|campaign|vendor|supplier)(?:_?id|_?code|_?no)?$/i;

function runDuplicateFindingInvestigation(input: {
  finding: BriefFinding;
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  analysis: DynamicAnalysisResult;
  allRows: Array<Record<string, unknown>>;
  cacheKey: string;
}): FindingInvestigationResult {
  const { finding, tableProfile, understanding, analysis, allRows, cacheKey } = input;
  const dup = tableProfile.duplicates;
  const findingText = `${finding.headline} ${finding.whatHappened}`.toLowerCase();
  const mentionedCols = tableProfile.columns
    .filter(c => !c.isSensitive && findingText.includes(c.name.toLowerCase()))
    .map(c => c.name);
  const keyColumns = mentionedCols.length > 0
    ? mentionedCols
    : dup.keyColumns.length > 0
      ? dup.keyColumns
      : tableProfile.primaryKeys;
  const dupRowCount = dup.duplicateRowCount ?? 0;
  const dupGroupCount = dup.duplicateGroupCount ?? 0;

  const isSingleNonTransactionalId =
    keyColumns.length === 1 && NON_TRANSACTIONAL_ENTITY_RE.test(keyColumns[0]);

  // Suggest safe composite keys from available schema columns (e.g. Date + Order/Customer + Product)
  const candidateCompositeKeys: string[][] = [];
  const dateCol = tableProfile.freshness.primaryDateColumn || tableProfile.dateColumns[0];
  const orderCol = understanding.roleAssignments.orderId?.columnName || understanding.roleAssignments.transactionId?.columnName;
  const productCol = understanding.roleAssignments.product?.columnName || understanding.roleAssignments.skuId?.columnName;
  const customerCol = understanding.roleAssignments.customerId?.columnName;

  if (orderCol && productCol && orderCol !== productCol) candidateCompositeKeys.push([orderCol, productCol]);
  if (dateCol && customerCol && productCol) candidateCompositeKeys.push([dateCol, customerCol, productCol]);
  if (dateCol && keyColumns.length > 0 && !keyColumns.includes(dateCol)) {
    candidateCompositeKeys.push([...keyColumns, dateCol]);
  }

  // Inspect actual rows in memory (read-only) to distinguish legitimate repeated IDs from true duplicates
  const topRepeatedGroups: DuplicateInvestigationDetail["topRepeatedGroups"] = [];
  let legitimateCount = 0;
  let possibleDupCount = 0;

  if (keyColumns.length > 0 && allRows.length > 0) {
    const contextCols = tableProfile.columns
      .filter(c => !keyColumns.includes(c.name) && !c.isSensitive && c.supported)
      .slice(0, 5)
      .map(c => c.name);

    const grouped = new Map<string, { count: number; signatures: Set<string> }>();
    for (const row of allRows) {
      const keyVal = keyColumns.map(k => String(row[k] ?? "")).join(" | ").trim();
      if (!keyVal) continue;
      const sig = contextCols.map(c => String(row[c] ?? "")).join("||");
      const entry = grouped.get(keyVal) || { count: 0, signatures: new Set<string>() };
      entry.count += 1;
      entry.signatures.add(sig);
      grouped.set(keyVal, entry);
    }

    const repeated = [...grouped.entries()]
      .filter(([, info]) => info.count > 1)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6);

    for (const [keyLabel, info] of repeated) {
      const hasDistinctTransactions = info.signatures.size === info.count && isSingleNonTransactionalId;
      const assessment: "likely_legitimate_transactions" | "possible_duplicate_records" = hasDistinctTransactions
        ? "likely_legitimate_transactions"
        : "possible_duplicate_records";
      if (assessment === "likely_legitimate_transactions") legitimateCount += 1;
      else possibleDupCount += 1;
      topRepeatedGroups.push({
        keyLabel,
        count: info.count,
        distinctContextCount: info.signatures.size,
        assessment
      });
    }
  }

  const repeatedIdentifierAssessment: DuplicateInvestigationDetail["repeatedIdentifierAssessment"] =
    isSingleNonTransactionalId && possibleDupCount === 0 && (legitimateCount > 0 || allRows.length === 0)
      ? "likely_legitimate_transactions"
      : legitimateCount > 0 && possibleDupCount > 0
        ? "mixed"
        : "possible_duplicate_records";

  const assessmentNote = repeatedIdentifierAssessment === "likely_legitimate_transactions"
    ? `Repeated "${keyColumns.join(", ")}" values appear across distinct transaction contexts (dates, customers, or amounts). A repeated ${keyColumns[0]} normally represents multiple legitimate transactions rather than duplicate records.`
    : repeatedIdentifierAssessment === "mixed"
      ? `Some repeated "${keyColumns.join(", ")}" groups have distinct transaction attributes while others share identical signatures and warrant upstream deduplication review.`
      : `Identical records were detected across ${dupGroupCount || topRepeatedGroups.length} repeated key group(s) on (${keyColumns.join(", ") || "unknown key"}). Verify upstream ingestion idempotency.`;

  const duplicateDetails: DuplicateInvestigationDetail = {
    keyColumns,
    duplicateRowCount: dupRowCount,
    duplicateGroupCount: dupGroupCount,
    candidateCompositeKeys,
    repeatedIdentifierAssessment,
    assessmentNote,
    topRepeatedGroups
  };

  const evidence: string[] = [
    `Checked key column(s): ${keyColumns.join(", ") || "none detected"}.`,
    assessmentNote
  ];
  if (candidateCompositeKeys.length > 0) {
    evidence.push(`Candidate composite transaction keys available: ${candidateCompositeKeys.map(k => `(${k.join(" + ")})`).join(", ")}.`);
  }

  const limitations: string[] = [];
  if (allRows.length === 0) {
    limitations.push("Row-level inspection was limited because no scoped rows were loaded; assessment relies on schema profile metadata.");
  }

  return {
    findingId: finding.id,
    findingHeadline: finding.headline,
    findingCategory: finding.category,
    investigationType: "duplicate_data",
    status: keyColumns.length > 0 ? "completed" : "insufficient_data",
    statusReason: keyColumns.length > 0 ? null : "No candidate key columns were identified in the dataset schema.",
    investigatedMetric: null,
    reportingPeriod: analysis.reportingPeriod,
    referencePeriod: analysis.comparisonPeriod,
    summary: assessmentNote,
    dailyTrend: null,
    largestChangeDate: null,
    relevantDimensions: [],
    dimensionBreakdowns: [],
    topAssociatedSegments: [],
    mostRelevantSegment: null,
    relatedMetricDrivers: [],
    duplicateDetails,
    missingDataDetails: null,
    supportingEvidence: evidence,
    dataLimitations: limitations,
    suggestedNextSteps: [
      repeatedIdentifierAssessment === "likely_legitimate_transactions"
        ? `Do not delete rows by "${keyColumns[0]}" alone; confirm a true transaction key such as ${candidateCompositeKeys[0]?.join(" + ") || "Order_ID + Line_Number"}.`
        : `Inspect upstream ingestion jobs for repeated (${keyColumns.join(", ")}) records before deduplicating in a staging view.`,
      "QueryPilot-X operates strictly read-only and never deletes or modifies source records."
    ],
    cacheKey,
    reusedFromCache: false,
    generatedAt: analysis.generatedAt
  };
}

function runMissingDataFindingInvestigation(input: {
  finding: BriefFinding;
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  analysis: DynamicAnalysisResult;
  dataHealth: DataHealthReport | null;
  cacheKey: string;
}): FindingInvestigationResult {
  const { finding, tableProfile, understanding, analysis, dataHealth, cacheKey } = input;
  const highNullColumns = tableProfile.columns
    .filter(c => !c.isSensitive && c.nullPercent >= 10)
    .sort((a, b) => b.nullPercent - a.nullPercent)
    .slice(0, 8)
    .map(c => ({ columnName: c.name, nullPercent: c.nullPercent, nullCount: c.nullCount }));

  const unavailableMetrics = analysis.unavailableMetrics.slice(0, 8).map(m => ({
    metricId: m.metricId,
    name: m.name,
    reason: m.unavailableReason || "Missing required columns or records."
  }));

  const invalidDateWarning = analysis.dataQualityWarnings.find(w => /invalid|unparseable|date/i.test(w)) || null;

  const missingDataDetails: MissingDataInvestigationDetail = {
    missingRequiredRoles: understanding.missingRequiredRoles,
    highNullColumns,
    unavailableMetrics,
    invalidDateWarning
  };

  const evidence: string[] = [];
  if (analysis.source.rowCountInPeriod === 0) {
    evidence.push(`0 source records matched reporting window ${analysis.reportingPeriod.label} in "${tableProfile.name}".`);
  }
  if (understanding.missingRequiredRoles.length > 0) {
    evidence.push(`Missing required semantic role(s): ${understanding.missingRequiredRoles.join(", ")}.`);
  }
  if (highNullColumns.length > 0) {
    evidence.push(`Columns with elevated nulls: ${highNullColumns.map(c => `${c.columnName} (${c.nullPercent.toFixed(1)}%)`).join(", ")}.`);
  }
  if (unavailableMetrics.length > 0) {
    evidence.push(`${unavailableMetrics.length} domain metric(s) currently unavailable due to schema or record gaps.`);
  }
  if (invalidDateWarning) {
    evidence.push(invalidDateWarning);
  }
  if (evidence.length === 0 && dataHealth) {
    evidence.push(`Data Health score is ${dataHealth.healthScore}/100 (${dataHealth.overallStatus}).`);
  }

  const summary = understanding.missingRequiredRoles.length > 0
    ? `Investigation identified ${understanding.missingRequiredRoles.length} missing required role(s) (${understanding.missingRequiredRoles.join(", ")}) affecting ${unavailableMetrics.length} metric(s).`
    : highNullColumns.length > 0
      ? `Investigation found ${highNullColumns.length} column(s) with >=10% missing values (highest: ${highNullColumns[0].columnName} at ${highNullColumns[0].nullPercent.toFixed(1)}%).`
      : analysis.source.rowCountInPeriod === 0
        ? `No source rows were present in "${tableProfile.name}" for ${analysis.reportingPeriod.label}; check data freshness (${tableProfile.freshness.latestDate?.slice(0, 10) || "unknown"}).`
        : finding.whatHappened;

  const isZeroPeriodRows = analysis.source.rowCountInPeriod === 0;
  return {
    findingId: finding.id,
    findingHeadline: finding.headline,
    findingCategory: finding.category,
    investigationType: classifyInvestigationType(finding),
    status: isZeroPeriodRows ? "insufficient_data" : (evidence.length > 0 ? "completed" : "insufficient_data"),
    statusReason: isZeroPeriodRows
      ? `No source rows matched ${analysis.reportingPeriod.label} in "${tableProfile.name}".`
      : (evidence.length > 0 ? null : "Insufficient metadata available to diagnose this data gap."),
    investigatedMetric: null,
    reportingPeriod: analysis.reportingPeriod,
    referencePeriod: analysis.comparisonPeriod,
    summary,
    dailyTrend: null,
    largestChangeDate: null,
    relevantDimensions: [],
    dimensionBreakdowns: [],
    topAssociatedSegments: [],
    mostRelevantSegment: null,
    relatedMetricDrivers: [],
    duplicateDetails: null,
    missingDataDetails,
    supportingEvidence: evidence,
    dataLimitations: analysis.source.rowCountInPeriod === 0
      ? ["Metric trend and segment breakdowns cannot be computed when the reporting period has 0 matching rows."]
      : [],
    suggestedNextSteps: [
      finding.investigateNext,
      ...(highNullColumns.length > 0 ? [`Inspect upstream null handling for "${highNullColumns[0].columnName}".`] : []),
      ...(tableProfile.freshness.latestDate ? [`Latest available record in "${tableProfile.name}" is dated ${tableProfile.freshness.latestDate.slice(0, 10)}.`] : [])
    ],
    cacheKey,
    reusedFromCache: false,
    generatedAt: analysis.generatedAt
  };
}

/* ============================================================================
 * 7. ORCHESTRATOR: AUTOMATICALLY INVESTIGATES EVERY BRIEF FINDING
 *    Flow: Finding Detection -> Planning -> Analysis -> Evidence -> Result
 * ============================================================================ */

export type InvestigateFindingsInput = {
  findings: BriefFinding[];
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  analysis: DynamicAnalysisResult;
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  rootCause?: RootCauseAnalysisResult | null;
  dataHealth?: DataHealthReport | null;
  allowMediumConfidence?: boolean;
  /** Optional fault-injection hooks (strictly for fault-isolation testing). */
  investigationOverrides?: Record<string, () => never>;
  /** Disable cross-call cache if desired (defaults to true). */
  useCache?: boolean;
};

type MetricComputationMemo = {
  dailyTrend: DailyTrendSummary;
  relevantDimensions: CandidateDimension[];
  breakdowns: DimensionBreakdownInvestigation[];
  topSegments: InvestigationSegmentRow[];
  relatedDrivers: ComponentMetricDriver[];
};

export function runAutomatedFindingInvestigations(input: InvestigateFindingsInput): FindingInvestigationResult[] {
  const {
    findings,
    tableProfile,
    understanding,
    analysis,
    periodRows,
    comparisonRows,
    rootCause = null,
    dataHealth = null,
    allowMediumConfidence = true,
    investigationOverrides = {},
    useCache = true
  } = input;

  if (!findings || findings.length === 0) return [];

  const dateColumn = resolveDateColumnForInvestigation(tableProfile, understanding, analysis.domainId);
  const allRows = [...periodRows, ...comparisonRows];
  const dateOrder = resolveDateOrder(tableProfile, dateColumn, allRows);
  const accessor = createRoleAccessor(understanding, analysis.timezone, allowMediumConfidence, dateOrder);
  const metricById = new Map(analysis.metrics.map(m => [m.metricId, m]));
  const rootCauseByMetric = new Map((rootCause?.analyses || []).map(a => [a.metricId, a]));
  const datasetFingerprint = buildRowsFingerprint(tableProfile, analysis, periodRows, comparisonRows);

  // Within-run memoization: if multiple findings reference the same metric (e.g. negative + unusual),
  // compute its daily trend and segment breakdowns only ONCE!
  const perMetricMemo = new Map<string, MetricComputationMemo>();
  const results: FindingInvestigationResult[] = [];

  for (const finding of findings) {
    const cacheKey = `${datasetFingerprint}::${finding.id}::${finding.metricId || "nom"}::${finding.category}`;

    if (useCache && !investigationOverrides[finding.id]) {
      const cached = investigationResultCache.get(cacheKey);
      if (cached) {
        results.push({ ...cached, reusedFromCache: true });
        continue;
      }
    }

    try {
      if (investigationOverrides[finding.id]) {
        investigationOverrides[finding.id]();
      }

      const investigationType = classifyInvestigationType(finding);

      // Route 1: Duplicate data findings
      if (investigationType === "duplicate_data") {
        const dupRes = runDuplicateFindingInvestigation({
          finding,
          tableProfile,
          understanding,
          analysis,
          allRows,
          cacheKey
        });
        if (useCache) putInCache(cacheKey, dupRes);
        results.push(dupRes);
        continue;
      }

      // Route 2: Missing data / data quality findings (no unnecessary metric trend analysis)
      if (investigationType === "missing_data" || investigationType === "data_quality") {
        const gapRes = runMissingDataFindingInvestigation({
          finding,
          tableProfile,
          understanding,
          analysis,
          dataHealth,
          cacheKey
        });
        if (useCache) putInCache(cacheKey, gapRes);
        results.push(gapRes);
        continue;
      }

      // Route 3: Metric-driven findings (negative, positive, unusual, domain_event)
      const metric = finding.metricId ? metricById.get(finding.metricId) || null : null;
      if (!metric) {
        const unsupportedRes: FindingInvestigationResult = {
          findingId: finding.id,
          findingHeadline: finding.headline,
          findingCategory: finding.category,
          investigationType,
          status: "unsupported",
          statusReason: "This finding is not linked to an investigable quantitative metric in the active schema.",
          investigatedMetric: null,
          reportingPeriod: analysis.reportingPeriod,
          referencePeriod: analysis.comparisonPeriod,
          summary: "Automated metric investigation is not applicable to this finding.",
          dailyTrend: null,
          largestChangeDate: null,
          relevantDimensions: [],
          dimensionBreakdowns: [],
          topAssociatedSegments: [],
          mostRelevantSegment: null,
          relatedMetricDrivers: [],
          duplicateDetails: null,
          missingDataDetails: null,
          supportingEvidence: [finding.whatHappened],
          dataLimitations: ["No quantitative metric identifier was associated with this finding."],
          suggestedNextSteps: [finding.investigateNext],
          cacheKey,
          reusedFromCache: false,
          generatedAt: analysis.generatedAt
        };
        if (useCache) putInCache(cacheKey, unsupportedRes);
        results.push(unsupportedRes);
        continue;
      }

      if (metric.availability !== "available" || analysis.source.rowCountInPeriod === 0) {
        const insuffRes: FindingInvestigationResult = {
          findingId: finding.id,
          findingHeadline: finding.headline,
          findingCategory: finding.category,
          investigationType,
          status: "insufficient_data",
          statusReason: metric.unavailableReason || `No source records available to investigate ${metric.name} in ${analysis.reportingPeriod.label}.`,
          investigatedMetric: {
            metricId: metric.metricId,
            name: metric.name,
            format: metric.format,
            unit: metric.unit,
            polarity: metric.polarity,
            currentValue: metric.value,
            formattedCurrentValue: metric.formattedValue,
            referenceValue: metric.comparisonValue,
            formattedReferenceValue: metric.formattedComparisonValue,
            changePercent: metric.changePercent
          },
          reportingPeriod: analysis.reportingPeriod,
          referencePeriod: analysis.comparisonPeriod,
          summary: `${metric.name} could not be investigated because ${metric.unavailableReason || "required records or columns were unavailable."}`,
          dailyTrend: null,
          largestChangeDate: null,
          relevantDimensions: [],
          dimensionBreakdowns: [],
          topAssociatedSegments: [],
          mostRelevantSegment: null,
          relatedMetricDrivers: collectRelatedMetricDrivers(metric, analysis),
          duplicateDetails: null,
          missingDataDetails: null,
          supportingEvidence: [finding.whatHappened],
          dataLimitations: [metric.unavailableReason || "Insufficient records in the active reporting period."],
          suggestedNextSteps: [finding.investigateNext],
          cacheKey,
          reusedFromCache: false,
          generatedAt: analysis.generatedAt
        };
        if (useCache) putInCache(cacheKey, insuffRes);
        results.push(insuffRes);
        continue;
      }

      // Compute or reuse within-run metric analysis
      const memoKey = `${metric.metricId}::${investigationType}`;
      let computed = perMetricMemo.get(memoKey);
      let reusedWithinRun = false;

      if (!computed) {
        const relevantDimensions = selectSafeInvestigationDimensions(
          tableProfile,
          understanding,
          analysis.domainId,
          dateColumn,
          periodRows
        );

        const dailyTrend = analysis.source.executionMode === "database_aggregate"
          ? {
              available: false,
              dateColumn,
              points: [],
              largestDeteriorationDate: null,
              largestDeteriorationValue: null,
              largestImprovementDate: null,
              largestImprovementValue: null,
              largestDayOverDayChange: null,
              unusualDates: [],
              trendPattern: "unavailable" as const,
              summary: "High-volume database aggregate mode limited row-level daily recomputation."
            }
          : runDailyTimeSeriesInvestigation({
              metric,
              dateColumn,
              dateOrder,
              periodRows,
              comparisonRows,
              domainId: analysis.domainId,
              understanding,
              period: analysis.reportingPeriod,
              comparison: analysis.comparisonPeriod,
              accessor
            });

        const segmentOutcome = analysis.source.executionMode === "database_aggregate"
          ? { breakdowns: [], topSegments: [] }
          : runSegmentBreakdownInvestigation({
              metric,
              findingType: investigationType,
              dimensions: relevantDimensions,
              periodRows,
              comparisonRows,
              domainId: analysis.domainId,
              understanding,
              period: analysis.reportingPeriod,
              comparison: analysis.comparisonPeriod,
              accessor
            });

        const relatedDrivers = collectRelatedMetricDrivers(metric, analysis);

        computed = {
          dailyTrend,
          relevantDimensions,
          breakdowns: segmentOutcome.breakdowns,
          topSegments: segmentOutcome.topSegments,
          relatedDrivers
        };
        perMetricMemo.set(memoKey, computed);
      } else {
        reusedWithinRun = true;
      }

      const { dailyTrend, relevantDimensions, breakdowns, topSegments, relatedDrivers } = computed;
      const mostRelevantSegment = topSegments[0] || null;
      const largestChangeDate = investigationType === "metric_deterioration"
        ? (dailyTrend.largestDeteriorationDate || dailyTrend.largestDayOverDayChange?.date || dailyTrend.points[0]?.date || null)
        : investigationType === "metric_improvement"
          ? (dailyTrend.largestImprovementDate || dailyTrend.largestDayOverDayChange?.date || dailyTrend.points[0]?.date || null)
          : (dailyTrend.largestDayOverDayChange?.date || dailyTrend.unusualDates[0]?.date || dailyTrend.points[0]?.date || null);

      const dataLimitations: string[] = [];
      if (!dateColumn) {
        dataLimitations.push("No date column detected in dataset; daily time-series breakdown could not be generated.");
      } else if (!dailyTrend.available) {
        dataLimitations.push(dailyTrend.summary);
      }
      if (relevantDimensions.length === 0) {
        dataLimitations.push("No suitable categorical segment columns were available for dimension breakdown.");
      }
      if (!analysis.comparisonPeriod || comparisonRows.length === 0) {
        dataLimitations.push("Reference-period records were unavailable; segment comparisons reflect current-period levels only.");
      }
      if (metric.warnings.length > 0) {
        dataLimitations.push(...metric.warnings.slice(0, 2));
      }

      const hasTrend = dailyTrend.available;
      const hasSegments = breakdowns.length > 0;
      let status: FindingInvestigationStatus;
      let statusReason: string | null = null;
      if (hasTrend && hasSegments && analysis.comparisonPeriod && comparisonRows.length > 0) {
        status = "completed";
      } else if (hasTrend || hasSegments || relatedDrivers.length > 0) {
        status = "partially_completed";
        statusReason = dataLimitations[0] || "Some supporting breakdowns were unavailable in the current dataset.";
      } else {
        status = "insufficient_data";
        statusReason = dataLimitations[0] || "Insufficient date and segment columns to investigate this finding.";
      }

      // Build evidence-backed summary & bullets (strictly using computed dataset values)
      const supportingEvidence: string[] = [];
      if (metric.formattedValue) {
        supportingEvidence.push(
          metric.formattedComparisonValue
            ? `${metric.name}: ${metric.formattedValue} vs ${metric.formattedComparisonValue}${metric.changePercent !== null ? ` (${metric.changePercent >= 0 ? "+" : ""}${metric.changePercent.toFixed(1)}%)` : ""}.`
            : `${metric.name}: ${metric.formattedValue} across ${analysis.source.rowCountInPeriod} record(s).`
        );
      }
      if (hasTrend) {
        supportingEvidence.push(dailyTrend.summary);
      }
      for (const seg of topSegments.slice(0, 3)) {
        supportingEvidence.push(seg.evidence);
      }
      const rcMatch = rootCauseByMetric.get(metric.metricId);
      if (rcMatch && rcMatch.summary && supportingEvidence.length < 6) {
        supportingEvidence.push(rcMatch.summary);
      }
      for (const drv of relatedDrivers.slice(0, 2)) {
        supportingEvidence.push(drv.note);
      }

      const summaryParts: string[] = [];
      if (largestChangeDate && hasTrend) {
        const verb = investigationType === "metric_deterioration"
          ? "Largest decline"
          : investigationType === "metric_improvement"
            ? "Strongest gain"
            : "Largest daily shift";
        summaryParts.push(`${verb} on ${largestChangeDate}.`);
      }
      if (mostRelevantSegment) {
        summaryParts.push(`Top associated segment: ${mostRelevantSegment.dimensionLabel} "${mostRelevantSegment.groupLabel}" (${mostRelevantSegment.formattedCurrentValue ?? "N/A"}${mostRelevantSegment.changePercent !== null ? `, ${mostRelevantSegment.changePercent >= 0 ? "+" : ""}${mostRelevantSegment.changePercent.toFixed(1)}%` : ""}).`);
      }
      if (relatedDrivers[0]) {
        summaryParts.push(relatedDrivers[0].note);
      }
      if (summaryParts.length === 0) {
        summaryParts.push(statusReason || `${metric.name} evaluated across ${analysis.source.rowCountInPeriod} record(s).`);
      }

      const suggestedNextSteps: string[] = [];
      if (mostRelevantSegment) {
        suggestedNextSteps.push(
          `Audit ${mostRelevantSegment.dimensionLabel.toLowerCase()} "${mostRelevantSegment.groupLabel}" records around ${largestChangeDate || analysis.reportingPeriod.label} to verify the underlying operational cause.`
        );
      }
      if (relatedDrivers[0]) {
        suggestedNextSteps.push(`Cross-check related driver "${relatedDrivers[0].metricName}" (${relatedDrivers[0].currentValue ?? "N/A"}) for joint movement with ${metric.name}.`);
      }
      if (suggestedNextSteps.length === 0) {
        suggestedNextSteps.push(finding.investigateNext);
      }

      const invResult: FindingInvestigationResult = {
        findingId: finding.id,
        findingHeadline: finding.headline,
        findingCategory: finding.category,
        investigationType,
        status,
        statusReason,
        investigatedMetric: {
          metricId: metric.metricId,
          name: metric.name,
          format: metric.format,
          unit: metric.unit,
          polarity: metric.polarity,
          currentValue: metric.value,
          formattedCurrentValue: metric.formattedValue,
          referenceValue: metric.comparisonValue,
          formattedReferenceValue: metric.formattedComparisonValue,
          changePercent: metric.changePercent
        },
        reportingPeriod: analysis.reportingPeriod,
        referencePeriod: analysis.comparisonPeriod,
        summary: summaryParts.join(" "),
        dailyTrend,
        largestChangeDate,
        relevantDimensions: relevantDimensions.map(d => ({
          dimensionId: d.dimensionId,
          label: d.label,
          sourceColumn: d.sourceColumn
        })),
        dimensionBreakdowns: breakdowns,
        topAssociatedSegments: topSegments,
        mostRelevantSegment,
        relatedMetricDrivers: relatedDrivers,
        duplicateDetails: null,
        missingDataDetails: null,
        supportingEvidence: [...new Set(supportingEvidence)],
        dataLimitations: [...new Set(dataLimitations)],
        suggestedNextSteps: [...new Set(suggestedNextSteps)],
        cacheKey,
        reusedFromCache: reusedWithinRun,
        generatedAt: analysis.generatedAt
      };

      if (useCache) putInCache(cacheKey, invResult);
      results.push(invResult);
    } catch (error) {
      // Fault isolation: one failed investigation NEVER blocks other findings!
      const errMsg = error instanceof Error ? error.message : "Automated investigation failed unexpectedly.";
      results.push({
        findingId: finding.id,
        findingHeadline: finding.headline,
        findingCategory: finding.category,
        investigationType: classifyInvestigationType(finding),
        status: "insufficient_data",
        statusReason: `Investigation could not complete due to an internal error: ${errMsg}`,
        investigatedMetric: null,
        reportingPeriod: analysis.reportingPeriod,
        referencePeriod: analysis.comparisonPeriod,
        summary: `Automated investigation encountered an error and was isolated so other findings remain available.`,
        dailyTrend: null,
        largestChangeDate: null,
        relevantDimensions: [],
        dimensionBreakdowns: [],
        topAssociatedSegments: [],
        mostRelevantSegment: null,
        relatedMetricDrivers: [],
        duplicateDetails: null,
        missingDataDetails: null,
        supportingEvidence: [],
        dataLimitations: [`Investigation error: ${errMsg}`],
        suggestedNextSteps: [finding.investigateNext],
        cacheKey,
        reusedFromCache: false,
        generatedAt: analysis.generatedAt
      });
    }
  }

  return results;
}
