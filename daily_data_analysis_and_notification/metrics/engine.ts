import type { Session } from "../../src/lib/session";
import {
  createSessionQueryExecutor,
  getDomainProfile,
  profileDatabaseWithExecutor,
  quoteIdentifier,
  quoteQualifiedTable,
  understandTableForDomain
} from "../profiler";
import type {
  BusinessDomainId,
  ConfidenceLevel,
  DomainTableUnderstanding,
  ReadOnlyQueryExecutor,
  TableProfile
} from "../profiler/types";
import { createRoleAccessor, runDomainCalculator } from "./domain-calculators";
import { getMetricDefinitions } from "./metric-definitions";
import {
  addDaysToDate,
  assertValidTimezone,
  buildPeriodWindow,
  determineTrendDirection,
  formatMetricValue,
  resolveComparisonWindow,
  safeChangePercent,
  safeRound,
  toDateKeyInTimezone
} from "./math-and-periods";
import type {
  ComparisonSummary,
  ComparisonWindow,
  DimensionBreakdown,
  DynamicAnalysisOptions,
  DynamicAnalysisResult,
  MetricDefinition,
  MetricResult,
  MetricSourceField,
  PeriodWindow,
  TimeSeriesPoint
} from "./types";

const DEFAULT_TIMEZONE = "Asia/Dhaka";
const MAX_SCOPED_ROWS = 25_000;

export const PRIMARY_DATE_ROLE_BY_DOMAIN: Record<BusinessDomainId, string> = {
  sales_ecommerce: "transactionDate",
  inventory_supply_chain: "recordedDate",
  marketing_campaigns: "campaignDate",
  finance_expenses: "transactionDate",
  customers_crm: "activityDate",
  operations_fulfillment: "eventDate",
  product_usage_saas: "eventTimestamp"
};

function isDateInComparisonWindow(dateKey: string, comparison: ComparisonWindow): boolean {
  if (comparison.matchingDates) {
    return comparison.matchingDates.includes(dateKey);
  }
  return dateKey >= comparison.start && dateKey <= comparison.end;
}

function checkDefinitionAvailability(
  definition: MetricDefinition,
  understanding: DomainTableUnderstanding,
  allowMediumConfidence: boolean
): {
  available: boolean;
  confidence: ConfidenceLevel | "unavailable";
  missingRoles: string[];
  sourceFields: MetricSourceField[];
  warnings: string[];
  reason: string | null;
} {
  const missingRoles: string[] = [];
  const sourceFields: MetricSourceField[] = [];
  const warnings: string[] = [];
  let minConfidence: ConfidenceLevel = "high";

  const evaluateRole = (role: string): boolean => {
    const assigned = understanding.roleAssignments[role];
    if (!assigned || assigned.confidence === "low") {
      missingRoles.push(role);
      return false;
    }
    if (assigned.ambiguous) {
      missingRoles.push(role);
      warnings.push(`Field "${assigned.columnName}" for role "${role}" is ambiguous and requires confirmation.`);
      return false;
    }
    if (assigned.confidence === "medium" && !allowMediumConfidence) {
      missingRoles.push(role);
      return false;
    }
    if (assigned.confidence === "medium") {
      minConfidence = "medium";
      warnings.push(`Field "${assigned.columnName}" (${role}) was detected with medium confidence; confirm mapping for full accuracy.`);
    }
    sourceFields.push({ role, columnName: assigned.columnName, confidence: assigned.confidence });
    return true;
  };

  let requiredOk = true;
  for (const role of definition.requiredRoles) {
    if (!evaluateRole(role)) requiredOk = false;
  }

  let groupOk = true;
  if (definition.anyOfRoleGroups && definition.anyOfRoleGroups.length > 0) {
    groupOk = false;
    let bestMissing: string[] = definition.anyOfRoleGroups[0];
    let bestFields: MetricSourceField[] = [];
    let bestWarnings: string[] = [];
    let bestConf: ConfidenceLevel = "high";

    for (const group of definition.anyOfRoleGroups) {
      const gMissing: string[] = [];
      const gFields: MetricSourceField[] = [];
      const gWarnings: string[] = [];
      let gConf: ConfidenceLevel = "high";

      for (const role of group) {
        const assigned = understanding.roleAssignments[role];
        if (!assigned || assigned.confidence === "low" || assigned.ambiguous || (assigned.confidence === "medium" && !allowMediumConfidence)) {
          gMissing.push(role);
        } else {
          if (assigned.confidence === "medium") {
            gConf = "medium";
            gWarnings.push(`Field "${assigned.columnName}" (${role}) was detected with medium confidence.`);
          }
          gFields.push({ role, columnName: assigned.columnName, confidence: assigned.confidence });
        }
      }

      if (gMissing.length === 0) {
        groupOk = true;
        bestFields = gFields;
        bestWarnings = gWarnings;
        bestConf = gConf;
        if (gConf === "high") break;
      } else if (gMissing.length < bestMissing.length) {
        bestMissing = gMissing;
      }
    }

    if (groupOk) {
      sourceFields.push(...bestFields);
      warnings.push(...bestWarnings);
      if (bestConf === "medium") minConfidence = "medium";
    } else {
      missingRoles.push(...bestMissing);
    }
  }

  // Record any optional source fields that are present
  for (const optRole of definition.optionalRoles || []) {
    const assigned = understanding.roleAssignments[optRole];
    if (assigned && (assigned.confidence === "high" || (allowMediumConfidence && assigned.confidence === "medium" && !assigned.ambiguous))) {
      sourceFields.push({ role: optRole, columnName: assigned.columnName, confidence: assigned.confidence });
    }
  }

  const dedupMissing = [...new Set(missingRoles)];
  const dedupSourceFields = [...new Map(sourceFields.map(f => [f.role, f])).values()];
  const available = requiredOk && groupOk;

  return {
    available,
    confidence: available ? minConfidence : "unavailable",
    missingRoles: dedupMissing,
    sourceFields: dedupSourceFields,
    warnings: [...new Set(warnings)],
    reason: available ? null : `Missing or unconfirmed required semantic field(s): ${dedupMissing.join(", ")}.`
  };
}

function buildComparisonSummary(metrics: MetricResult[], comparison: ComparisonWindow | null, comparisonRowCount: number): ComparisonSummary {
  if (!comparison) {
    return { available: false, reason: "No comparison period selected.", improvedCount: 0, declinedCount: 0, flatCount: 0 };
  }
  if (comparisonRowCount === 0) {
    return { available: false, reason: `No historical records found in comparison period (${comparison.label}).`, improvedCount: 0, declinedCount: 0, flatCount: 0 };
  }

  let improvedCount = 0;
  let declinedCount = 0;
  let flatCount = 0;
  let comparedAny = false;

  for (const metric of metrics) {
    if (metric.availability !== "available" || metric.changePercent === null) continue;
    comparedAny = true;
    if (metric.trendDirection === "flat") {
      flatCount += 1;
    } else if (metric.polarity === "higher_is_better") {
      if (metric.trendDirection === "up") improvedCount += 1;
      else if (metric.trendDirection === "down") declinedCount += 1;
    } else if (metric.polarity === "lower_is_better") {
      if (metric.trendDirection === "down") improvedCount += 1;
      else if (metric.trendDirection === "up") declinedCount += 1;
    }
  }

  return {
    available: comparedAny,
    reason: comparedAny ? null : "Historical records exist, but no metrics had a valid non-zero comparison baseline.",
    improvedCount,
    declinedCount,
    flatCount
  };
}

function humanizeColumnName(columnName: string): string {
  return columnName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function isNonMeasureIdentifierColumn(columnName: string, isPrimaryKey: boolean): boolean {
  if (isPrimaryKey) return true;
  const norm = columnName.toLowerCase();
  if (/^(?:id|row_?id|record_?id|seq|index)$/.test(norm)) return true;
  if (/(?:_id|id$|uuid|guid|zip|postal|phone|mobile|ssn|latitude|longitude|lat$|lng$|lon$|year$)/.test(norm)) return true;
  return false;
}

function shouldAverageDirectColumn(columnName: string): boolean {
  const norm = columnName.toLowerCase();
  return /(rate|ratio|percent|pct|margin|avg|average|mean|score|rating|price|cost|temp|temperature|age|duration|latency|bmi|gpa|discount)/.test(norm);
}

function parseFiniteNum(value: unknown): number | null {
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

function aggregateColumnValues(rows: Array<Record<string, unknown>>, colName: string, useAvg: boolean): number | null {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const num = parseFiniteNum(row[colName]);
    if (num !== null) {
      sum += num;
      count += 1;
    }
  }
  if (count === 0) return null;
  return safeRound(useAvg ? sum / count : sum, 2);
}

function buildDirectColumnExtras(input: {
  tableProfile: TableProfile;
  existingMetrics: MetricResult[];
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  period: PeriodWindow;
  comparison: ComparisonWindow | null;
  dateColumn: string | null;
  timezone: string;
  existingBreakdowns: DimensionBreakdown[];
  existingTimeSeries: TimeSeriesPoint[];
}): {
  extraMetrics: MetricResult[];
  breakdowns: DimensionBreakdown[];
  timeSeries: TimeSeriesPoint[];
} {
  const coveredColumns = new Set<string>();
  for (const m of input.existingMetrics) {
    if (m.availability === "available") {
      for (const sf of m.sourceFields) {
        coveredColumns.add(sf.columnName.toLowerCase());
      }
    }
  }

  const numericCols = input.tableProfile.columns.filter(
    col => col.category === "numeric" && !col.isSensitive && col.supported && !isNonMeasureIdentifierColumn(col.name, col.isPrimaryKey)
  );

  const extraMetrics: MetricResult[] = [];
  const primaryNumericCols: Array<{ name: string; metricId: string; useAvg: boolean }> = [];

  for (const col of numericCols.slice(0, 14)) {
    const metricId = `col_${col.name.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    const useAvg = shouldAverageDirectColumn(col.name);
    primaryNumericCols.push({ name: col.name, metricId, useAvg });
    if (coveredColumns.has(col.name.toLowerCase())) continue;

    const value = aggregateColumnValues(input.periodRows, col.name, useAvg);
    if (value === null) continue;
    const comparisonValue = input.comparison && input.comparisonRows.length > 0
      ? aggregateColumnValues(input.comparisonRows, col.name, useAvg)
      : null;
    const changePercent = comparisonValue !== null ? safeChangePercent(value, comparisonValue) : null;
    const label = humanizeColumnName(col.name);

    extraMetrics.push({
      metricId,
      name: useAvg ? `Avg ${label}` : label,
      description: `${useAvg ? "Average" : "Total"} of column "${col.name}" across active dataset records.`,
      value,
      formattedValue: formatMetricValue(value, "quantity", "units"),
      format: "quantity",
      unit: "units",
      polarity: "higher_is_better",
      reportingPeriod: input.period,
      comparisonValue,
      formattedComparisonValue: formatMetricValue(comparisonValue, "quantity", "units"),
      comparisonPeriod: input.comparison,
      changePercent,
      trendDirection: determineTrendDirection(changePercent),
      availability: "available",
      confidence: "high",
      missingRequiredFields: [],
      unavailableReason: null,
      sourceFields: [{ role: col.name, columnName: col.name, confidence: "high" }],
      warnings: []
    });
  }

  // Always include Total Records if no available metric already represents row/order count
  const hasCountMetric = input.existingMetrics.some(
    m => m.availability === "available" && m.format === "count"
  );
  if (!hasCountMetric && input.periodRows.length > 0) {
    const currCount = input.periodRows.length;
    const compCount = input.comparison && input.comparisonRows.length > 0 ? input.comparisonRows.length : null;
    const changePercent = compCount !== null ? safeChangePercent(currCount, compCount) : null;
    extraMetrics.unshift({
      metricId: "col_record_count",
      name: "Total Records",
      description: `Total records in "${input.tableProfile.name}" for the active reporting window.`,
      value: currCount,
      formattedValue: formatMetricValue(currCount, "count", "count"),
      format: "count",
      unit: "count",
      polarity: "higher_is_better",
      reportingPeriod: input.period,
      comparisonValue: compCount,
      formattedComparisonValue: formatMetricValue(compCount, "count", "count"),
      comparisonPeriod: input.comparison,
      changePercent,
      trendDirection: determineTrendDirection(changePercent),
      availability: "available",
      confidence: "high",
      missingRequiredFields: [],
      unavailableReason: null,
      sourceFields: [],
      warnings: []
    });
  }

  // Build direct categorical breakdowns if none were produced by domain calculator
  let breakdowns = input.existingBreakdowns;
  if (breakdowns.length === 0 && input.periodRows.length > 0) {
    const primaryMeasure = primaryNumericCols[0] || null;
    const catCols = input.tableProfile.columns.filter(
      col =>
        col.category === "categorical"
        && !col.isSensitive
        && !col.isPrimaryKey
        && col.supported
        && col.distinctCount !== null
        && col.distinctCount >= 2
        && col.distinctCount <= 60
    ).slice(0, 3);

    breakdowns = catCols.map(catCol => {
      const grouped = new Map<string, { value: number; count: number }>();
      for (const row of input.periodRows) {
        const raw = row[catCol.name];
        const label = raw === null || raw === undefined || String(raw).trim() === "" ? "Unspecified" : String(raw).trim();
        const entry = grouped.get(label) || { value: 0, count: 0 };
        entry.count += 1;
        if (primaryMeasure) {
          const num = parseFiniteNum(row[primaryMeasure.name]);
          if (num !== null) entry.value += num;
        } else {
          entry.value += 1;
        }
        grouped.set(label, entry);
      }

      const itemsRaw = [...grouped.entries()].map(([label, entry]) => {
        const primaryValue = primaryMeasure?.useAvg && entry.count > 0
          ? safeRound(entry.value / entry.count, 2)
          : safeRound(entry.value, 2);
        return {
          label,
          primaryValue,
          primaryMetricId: primaryMeasure ? primaryMeasure.metricId : "col_record_count",
          recordCount: entry.count,
          metrics: { [primaryMeasure ? primaryMeasure.metricId : "col_record_count"]: primaryValue },
          sharePercent: null as number | null
        };
      }).sort((a, b) => b.primaryValue - a.primaryValue);

      const totalVal = itemsRaw.reduce((acc, item) => acc + Math.max(0, item.primaryValue), 0);
      const items = itemsRaw.slice(0, 10).map(item => ({
        ...item,
        sharePercent: totalVal > 0 ? safeRound((Math.max(0, item.primaryValue) / totalVal) * 100, 1) : null
      }));

      return {
        dimensionId: `col_${catCol.name.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        label: humanizeColumnName(catCol.name),
        sourceColumn: catCol.name,
        primaryMetricId: primaryMeasure ? primaryMeasure.metricId : "col_record_count",
        items,
        totalItems: itemsRaw.length
      };
    });
  }

  // Build direct daily time series if none were produced by domain calculator
  let timeSeries = input.existingTimeSeries;
  if (timeSeries.length === 0 && input.dateColumn && input.periodRows.length > 0) {
    const byDate = new Map<string, Array<Record<string, unknown>>>();
    for (const row of input.periodRows) {
      const dateKey = toDateKeyInTimezone(row[input.dateColumn], input.timezone);
      if (!dateKey) continue;
      const list = byDate.get(dateKey) || [];
      list.push(row);
      byDate.set(dateKey, list);
    }
    const trackedCols = primaryNumericCols.slice(0, 4);
    timeSeries = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayRows]) => {
        const metricsMap: Record<string, number | null> = { col_record_count: dayRows.length };
        for (const tc of trackedCols) {
          metricsMap[tc.metricId] = aggregateColumnValues(dayRows, tc.name, tc.useAvg);
        }
        return { date, recordCount: dayRows.length, metrics: metricsMap };
      });
  }

  return { extraMetrics, breakdowns, timeSeries };
}

function assembleAnalysisResult(
  tableProfile: TableProfile,
  understanding: DomainTableUnderstanding,
  rows: Array<Record<string, unknown>>,
  options: DynamicAnalysisOptions,
  executionMode: "database_aggregate" | "scoped_records" | "in_memory",
  extraWarnings: string[] = []
): DynamicAnalysisResult {
  const timezone = assertValidTimezone(options.timezone || DEFAULT_TIMEZONE);
  const period = buildPeriodWindow(options.periodStart, options.periodEnd, timezone);
  const comparison = resolveComparisonWindow(
    period,
    options.comparisonPreset ?? "previous_30_days",
    options.comparisonStart,
    options.comparisonEnd
  );
  const allowMedium = options.allowMediumConfidence ?? true;
  const domainProfile = getDomainProfile(understanding.domainId);
  const accessor = createRoleAccessor(understanding, timezone, allowMedium);
  const primaryDateRole = PRIMARY_DATE_ROLE_BY_DOMAIN[understanding.domainId];

  const dataQualityWarnings: string[] = [...extraWarnings, ...tableProfile.warnings];
  if (tableProfile.isEmpty || rows.length === 0) {
    dataQualityWarnings.push("Dataset contains no records for the inspected window.");
  }
  if (!options.includeAllDatasetColumns && understanding.ambiguousColumns.length > 0) {
    dataQualityWarnings.push(`Ambiguous column(s) requiring confirmation: ${understanding.ambiguousColumns.join(", ")}.`);
  }

  let invalidDateRows = 0;
  const periodRows: Array<Record<string, unknown>> = [];
  const comparisonRows: Array<Record<string, unknown>> = [];
  const fallbackTemporalCol = tableProfile.columns.find(c => c.category === "temporal" && !c.isSensitive)?.name || null;
  const activeDateColumn = accessor.column(primaryDateRole) || (options.includeAllDatasetColumns ? fallbackTemporalCol : null);

  if (activeDateColumn) {
    for (const row of rows) {
      const rawDate = row[activeDateColumn];
      const dateKey = toDateKeyInTimezone(rawDate, timezone);
      if (!dateKey) {
        if (rawDate !== null && rawDate !== undefined && String(rawDate).trim() !== "") {
          invalidDateRows += 1;
        }
        continue;
      }
      if (dateKey >= period.start && dateKey <= period.end) {
        periodRows.push(row);
      }
      if (comparison && isDateInComparisonWindow(dateKey, comparison)) {
        comparisonRows.push(row);
      }
    }
  } else if (options.includeAllDatasetColumns) {
    // Table has no date column: evaluate all rows directly across the dataset's actual columns
    periodRows.push(...rows);
  } else {
    dataQualityWarnings.push(`Primary date role "${primaryDateRole}" is unavailable for ${domainProfile.name}; period filtering cannot be applied.`);
  }

  if (invalidDateRows > 0) {
    dataQualityWarnings.push(`Skipped ${invalidDateRows} record(s) with unparseable or invalid dates.`);
  }

  const calcOutput = accessor.has(primaryDateRole)
    ? runDomainCalculator(understanding.domainId, {
        understanding,
        allRows: rows,
        periodRows,
        comparisonRows,
        period,
        comparison,
        options,
        accessor
      })
    : {
        values: {},
        comparisonValues: {},
        metricWarnings: {},
        unavailableOverrides: {},
        timeSeries: [],
        breakdowns: [],
        domainWarnings: []
      };

  dataQualityWarnings.push(...calcOutput.domainWarnings);

  const definitions = getMetricDefinitions(understanding.domainId);
  const metrics: MetricResult[] = definitions.map(definition => {
    const check = checkDefinitionAvailability(definition, understanding, allowMedium);
    const warnings = [...check.warnings, ...(calcOutput.metricWarnings[definition.id] || [])];
    const override = calcOutput.unavailableOverrides[definition.id];

    if (!check.available) {
      return {
        metricId: definition.id,
        name: definition.name,
        description: definition.description,
        value: null,
        formattedValue: null,
        format: definition.format,
        unit: definition.unit,
        polarity: definition.polarity,
        reportingPeriod: period,
        comparisonValue: null,
        formattedComparisonValue: null,
        comparisonPeriod: comparison,
        changePercent: null,
        trendDirection: "unavailable",
        availability: "unavailable",
        confidence: "unavailable",
        missingRequiredFields: check.missingRoles,
        unavailableReason: check.reason,
        sourceFields: check.sourceFields,
        warnings
      };
    }

    if (override) {
      return {
        metricId: definition.id,
        name: definition.name,
        description: definition.description,
        value: null,
        formattedValue: null,
        format: definition.format,
        unit: definition.unit,
        polarity: definition.polarity,
        reportingPeriod: period,
        comparisonValue: null,
        formattedComparisonValue: null,
        comparisonPeriod: comparison,
        changePercent: null,
        trendDirection: "unavailable",
        availability: override.status,
        confidence: "unavailable",
        missingRequiredFields: override.missingRoles || [],
        unavailableReason: override.reason,
        sourceFields: check.sourceFields,
        warnings
      };
    }

    const rawValue = calcOutput.values[definition.id];
    const value = rawValue !== undefined && rawValue !== null && Number.isFinite(rawValue) ? rawValue : null;

    if (value === null) {
      return {
        metricId: definition.id,
        name: definition.name,
        description: definition.description,
        value: null,
        formattedValue: null,
        format: definition.format,
        unit: definition.unit,
        polarity: definition.polarity,
        reportingPeriod: period,
        comparisonValue: null,
        formattedComparisonValue: null,
        comparisonPeriod: comparison,
        changePercent: null,
        trendDirection: "unavailable",
        availability: "insufficient_data",
        confidence: "unavailable",
        missingRequiredFields: [],
        unavailableReason: "Insufficient non-null or non-zero records to compute this metric without division by zero.",
        sourceFields: check.sourceFields,
        warnings
      };
    }

    const rawComp = comparison && comparisonRows.length > 0 ? calcOutput.comparisonValues[definition.id] : null;
    let comparisonValue = rawComp !== undefined && rawComp !== null && Number.isFinite(rawComp) ? rawComp : null;
    let changePercent: number | null = null;

    if (comparison && comparisonValue !== null) {
      if (definition.normalizeComparisonByDay && period.dayCount !== comparison.dayCount) {
        const normalizedCurr = value / period.dayCount;
        const normalizedComp = comparisonValue / comparison.dayCount;
        comparisonValue = safeRound(normalizedComp * period.dayCount, 2);
        changePercent = safeChangePercent(normalizedCurr, normalizedComp);
      } else {
        changePercent = safeChangePercent(value, comparisonValue);
      }
      if (comparisonValue === 0 && changePercent === null) {
        warnings.push("Comparison baseline is zero; percentage change omitted to avoid invalid or infinite growth rates.");
      }
    }

    return {
      metricId: definition.id,
      name: definition.name,
      description: definition.description,
      value,
      formattedValue: formatMetricValue(value, definition.format, definition.unit),
      format: definition.format,
      unit: definition.unit,
      polarity: definition.polarity,
      reportingPeriod: period,
      comparisonValue,
      formattedComparisonValue: formatMetricValue(comparisonValue, definition.format, definition.unit),
      comparisonPeriod: comparison,
      changePercent,
      trendDirection: determineTrendDirection(changePercent),
      availability: "available",
      confidence: check.confidence,
      missingRequiredFields: [],
      unavailableReason: null,
      sourceFields: check.sourceFields,
      warnings: [...new Set(warnings)]
    };
  });

  let finalMetrics = metrics;
  let finalBreakdowns = calcOutput.breakdowns;
  let finalTimeSeries = calcOutput.timeSeries;

  if (options.includeAllDatasetColumns) {
    const directExtras = buildDirectColumnExtras({
      tableProfile,
      existingMetrics: metrics,
      periodRows,
      comparisonRows,
      period,
      comparison,
      dateColumn: activeDateColumn,
      timezone,
      existingBreakdowns: calcOutput.breakdowns,
      existingTimeSeries: calcOutput.timeSeries
    });
    finalMetrics = [...metrics.filter(m => m.availability === "available"), ...directExtras.extraMetrics];
    finalBreakdowns = directExtras.breakdowns;
    finalTimeSeries = directExtras.timeSeries;
  }

  const availableMetrics = finalMetrics.filter(m => m.availability === "available");
  const unavailableMetrics = finalMetrics.filter(m => m.availability !== "available");

  return {
    domainId: understanding.domainId,
    domainName: domainProfile.name,
    tableName: tableProfile.name,
    generatedAt: (options.now || new Date()).toISOString(),
    timezone,
    reportingPeriod: period,
    comparisonPeriod: comparison,
    metrics: finalMetrics,
    availableMetrics,
    unavailableMetrics,
    timeSeries: finalTimeSeries,
    breakdowns: finalBreakdowns,
    comparisonSummary: buildComparisonSummary(finalMetrics, comparison, comparisonRows.length),
    dataQualityWarnings: [...new Set(dataQualityWarnings)],
    source: {
      tableName: tableProfile.name,
      rowCountInPeriod: periodRows.length,
      rowCountInComparison: comparisonRows.length,
      totalRowsEvaluated: rows.length,
      executionMode,
      roleAssignments: understanding.roleAssignments,
      missingRequiredRoles: understanding.missingRequiredRoles,
      domainFitScore: understanding.domainFitScore
    },
    domainSpecificData: calcOutput.domainSpecificData
  };
}

/**
 * Pure reusable entry point for running the Dynamic Metrics Engine on an in-memory row set
 * with an existing Stage 1 TableProfile (supports unit tests, local SQLite, and previews).
 */
export function runDynamicAnalysisFromRows(
  tableProfile: TableProfile,
  rows: Array<Record<string, unknown>>,
  options: DynamicAnalysisOptions
): DynamicAnalysisResult {
  const domainId = options.domainId || "sales_ecommerce";
  const understanding = understandTableForDomain(tableProfile, domainId, {
    isSelectedDomain: Boolean(options.domainId),
    overrides: options.overrides
  });
  return assembleAnalysisResult(tableProfile, understanding, rows, options, "in_memory");
}

function getSafeDatasetColumns(tableProfile: TableProfile): string[] {
  return tableProfile.columns
    .filter(c => !c.isSensitive && c.supported)
    .map(c => c.name);
}

function getSafeMappedColumns(tableProfile: TableProfile, understanding: DomainTableUnderstanding): string[] {
  const sensitiveSet = new Set(tableProfile.columns.filter(c => c.isSensitive).map(c => c.name));
  const supportedSet = new Set(tableProfile.columns.filter(c => c.supported).map(c => c.name));
  const cols = new Set<string>();

  for (const assignment of Object.values(understanding.roleAssignments)) {
    if (assignment.confidence === "low") continue;
    if (sensitiveSet.has(assignment.columnName)) continue;
    if (!supportedSet.has(assignment.columnName)) continue;
    cols.add(assignment.columnName);
  }
  return [...cols];
}

function computeHistoryStart(
  domainId: BusinessDomainId,
  period: PeriodWindow,
  comparison: ComparisonWindow | null
): string {
  const candidates: string[] = [period.start];
  if (comparison) candidates.push(comparison.start);
  if (domainId === "product_usage_saas") {
    candidates.push(addDaysToDate(period.end, -29)); // Ensure 30-day window for MAU
  }
  if (domainId === "customers_crm" || domainId === "inventory_supply_chain" || domainId === "sales_ecommerce") {
    candidates.push(addDaysToDate(period.end, -90));
  }
  return candidates.sort()[0];
}

function isTextStoredDateColumn(tableProfile: TableProfile, dateColumn: string): boolean {
  const meta = tableProfile.columns.find(c => c.name === dateColumn);
  if (!meta) return false;
  const dt = meta.rawDataType.toLowerCase();
  return Boolean(meta.temporalStats?.inferredFromText || dt.includes("text") || dt.includes("char"));
}

function buildSafeDateRangePredicate(
  tableProfile: TableProfile,
  dateColumn: string,
  qDate: string,
  windowStart: string,
  windowEnd: string
): { predicate: string; dateGroupExpr: string } {
  if (isTextStoredDateColumn(tableProfile, dateColumn)) {
    const normDateText = `REPLACE(SUBSTRING(TRIM(CAST(${qDate} AS TEXT)) FROM 1 FOR 10), '/', '-')`;
    const validGuard = `TRIM(CAST(${qDate} AS TEXT)) ~ '^[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}'`;
    return {
      predicate: `${validGuard} AND ${normDateText} >= '${windowStart}' AND ${normDateText} <= '${windowEnd}'`,
      dateGroupExpr: normDateText
    };
  }
  return {
    predicate: `${qDate} >= '${windowStart}' AND ${qDate} <= '${windowEnd} 23:59:59'`,
    dateGroupExpr: `CAST(${qDate} AS DATE)`
  };
}

export function buildWindowCountSql(
  tableProfile: TableProfile,
  dateColumn: string,
  windowStart: string,
  windowEnd: string
): string {
  const allowedTables = new Set([tableProfile.name]);
  const allowedCols = new Set(tableProfile.columns.map(c => c.name));
  const qualified = quoteQualifiedTable(tableProfile.schema, tableProfile.name, allowedTables);
  const qDate = quoteIdentifier(dateColumn, allowedCols);
  const { predicate } = buildSafeDateRangePredicate(tableProfile, dateColumn, qDate, windowStart, windowEnd);
  return `SELECT COUNT(*) AS row_count FROM ${qualified} WHERE ${predicate}`;
}

export function buildScopedColumnsQuerySql(
  tableProfile: TableProfile,
  columns: string[],
  dateColumn: string,
  windowStart: string,
  windowEnd: string,
  limit = MAX_SCOPED_ROWS
): string {
  const allowedTables = new Set([tableProfile.name]);
  const allowedCols = new Set(tableProfile.columns.filter(c => !c.isSensitive && c.supported).map(c => c.name));
  const qualified = quoteQualifiedTable(tableProfile.schema, tableProfile.name, allowedTables);
  const quotedCols = columns.map(col => quoteIdentifier(col, allowedCols));
  const qDate = quoteIdentifier(dateColumn, allowedCols);
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_SCOPED_ROWS));
  const { predicate } = buildSafeDateRangePredicate(tableProfile, dateColumn, qDate, windowStart, windowEnd);
  return `SELECT ${quotedCols.join(", ")} FROM ${qualified} WHERE ${predicate} ORDER BY ${qDate} ASC LIMIT ${safeLimit}`;
}

export function buildDatabaseAggregateFallbackSql(
  tableProfile: TableProfile,
  understanding: DomainTableUnderstanding,
  dateColumn: string,
  windowStart: string,
  windowEnd: string
): string {
  const allowedTables = new Set([tableProfile.name]);
  const allowedCols = new Set(tableProfile.columns.filter(c => !c.isSensitive && c.supported).map(c => c.name));
  const colMetaByName = new Map(tableProfile.columns.map(c => [c.name, c]));
  const qualified = quoteQualifiedTable(tableProfile.schema, tableProfile.name, allowedTables);
  const qDate = quoteIdentifier(dateColumn, allowedCols);
  const { predicate, dateGroupExpr } = buildSafeDateRangePredicate(tableProfile, dateColumn, qDate, windowStart, windowEnd);

  const selectParts: string[] = [`${dateGroupExpr} AS ${qDate}`, `COUNT(*) AS _agg_row_count`];

  // Include distinct count of the domain's primary entity identifier when mapped
  const entityRoleCandidates = ["orderId", "skuId", "campaignId", "transactionId", "customerId", "shipmentId", "userId"];
  for (const role of entityRoleCandidates) {
    const colName = understanding.roleAssignments[role]?.columnName;
    if (colName && allowedCols.has(colName)) {
      const qEntity = quoteIdentifier(colName, allowedCols);
      selectParts.push(`COUNT(DISTINCT ${qEntity}) AS _agg_distinct_entities`);
      break;
    }
  }

  for (const assignment of Object.values(understanding.roleAssignments)) {
    if (assignment.columnName === dateColumn) continue;
    if (!allowedCols.has(assignment.columnName)) continue;
    const meta = colMetaByName.get(assignment.columnName);
    if (!meta || meta.category !== "numeric") continue;
    const qCol = quoteIdentifier(assignment.columnName, allowedCols);
    selectParts.push(`COALESCE(SUM(${qCol}::double precision), 0) AS ${qCol}`);
  }

  const whereParts = [predicate];
  if (understanding.domainId === "sales_ecommerce") {
    const statusCol = understanding.roleAssignments.status?.columnName;
    if (statusCol && allowedCols.has(statusCol)) {
      const qStatus = quoteIdentifier(statusCol, allowedCols);
      whereParts.push(`LOWER(COALESCE(TRIM(CAST(${qStatus} AS TEXT)), '')) NOT IN ('cancelled','canceled','void','voided','failed','rejected','returned','refunded','chargeback')`);
    }
  }

  return `SELECT ${selectParts.join(", ")} FROM ${qualified} WHERE ${whereParts.join(" AND ")} GROUP BY ${dateGroupExpr} ORDER BY ${dateGroupExpr} ASC LIMIT 1000`;
}

/**
 * Database-side read-only entry point: profiles the table via Stage 1 (or reuses an existing TableProfile),
 * builds safe read-only scoped queries without SELECT * or sensitive PII columns, and falls back to
 * database-side daily aggregation if a table exceeds MAX_SCOPED_ROWS.
 */
export async function runDynamicAnalysisWithExecutor(
  executor: ReadOnlyQueryExecutor,
  tableName: string,
  options: DynamicAnalysisOptions,
  precomputedTableProfile?: TableProfile
): Promise<{
  analysis: DynamicAnalysisResult;
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  scopedRows: Array<Record<string, unknown>>;
}> {
  const timezone = assertValidTimezone(options.timezone || DEFAULT_TIMEZONE);
  const period = buildPeriodWindow(options.periodStart, options.periodEnd, timezone);
  const comparison = resolveComparisonWindow(
    period,
    options.comparisonPreset ?? "previous_30_days",
    options.comparisonStart,
    options.comparisonEnd
  );

  let tableProfile = precomputedTableProfile;
  let detectedDomain: BusinessDomainId | null = options.domainId || null;

  if (!tableProfile) {
    const dbProfile = await profileDatabaseWithExecutor(executor, {
      selectedDomain: options.domainId || null,
      tableNames: [tableName],
      now: options.now,
      tableOverrides: options.overrides ? { [tableName]: options.overrides } : undefined
    });
    tableProfile = dbProfile.tables.find(t => t.name === tableName);
    if (!tableProfile) {
      throw new Error(`Table "${tableName}" was not found in the connected database.`);
    }
    if (!detectedDomain) {
      detectedDomain = dbProfile.tableUnderstandings[tableName]?.domainId || dbProfile.suggestedDomain?.domainId || "sales_ecommerce";
    }
  }

  const domainId = detectedDomain || "sales_ecommerce";
  const understanding = understandTableForDomain(tableProfile, domainId, {
    isSelectedDomain: Boolean(options.domainId),
    overrides: options.overrides
  });

  const primaryDateRole = PRIMARY_DATE_ROLE_BY_DOMAIN[domainId];
  const fallbackTemporalCol = tableProfile.columns.find(c => c.category === "temporal" && !c.isSensitive)?.name;
  const dateColumn = understanding.roleAssignments[primaryDateRole]?.columnName
    || (options.includeAllDatasetColumns ? fallbackTemporalCol : undefined);
  const safeColumns = options.includeAllDatasetColumns
    ? getSafeDatasetColumns(tableProfile)
    : getSafeMappedColumns(tableProfile, understanding);

  if (tableProfile.isEmpty || safeColumns.length === 0 || (!dateColumn && !options.includeAllDatasetColumns)) {
    const analysis = assembleAnalysisResult(tableProfile, understanding, [], options, "scoped_records");
    return { analysis, tableProfile, understanding, scopedRows: [] };
  }

  if (!dateColumn && options.includeAllDatasetColumns) {
    // Table has no date column: fetch bounded read-only rows across all safe columns directly
    const allowedTables = new Set([tableProfile.name]);
    const allowedCols = new Set(safeColumns);
    const qualified = quoteQualifiedTable(tableProfile.schema, tableProfile.name, allowedTables);
    const quotedCols = safeColumns.map(col => quoteIdentifier(col, allowedCols));
    const boundedSql = `SELECT ${quotedCols.join(", ")} FROM ${qualified} LIMIT ${MAX_SCOPED_ROWS}`;
    const rows = await executor(boundedSql);
    const analysis = assembleAnalysisResult(tableProfile, understanding, rows, options, "scoped_records");
    return { analysis, tableProfile, understanding, scopedRows: rows };
  }

  if (!dateColumn) {
    const analysis = assembleAnalysisResult(tableProfile, understanding, [], options, "scoped_records");
    return { analysis, tableProfile, understanding, scopedRows: [] };
  }

  const windowStart = computeHistoryStart(domainId, period, comparison);
  const windowEnd = period.end;
  const extraWarnings: string[] = [];

  // Check scoped row count first to avoid loading huge tables into memory
  let windowRowCount = tableProfile.rowCount;
  try {
    const countSql = buildWindowCountSql(tableProfile, dateColumn, windowStart, windowEnd);
    const countRows = await executor(countSql);
    const parsedCount = Number(countRows[0]?.row_count);
    if (Number.isFinite(parsedCount) && parsedCount >= 0) {
      windowRowCount = parsedCount;
    }
  } catch {
    extraWarnings.push("Window row-count precheck could not be executed; applying bounded read-only limit.");
  }

  let rows: Array<Record<string, unknown>> = [];
  let executionMode: "database_aggregate" | "scoped_records" = "scoped_records";

  if (windowRowCount > MAX_SCOPED_ROWS) {
    executionMode = "database_aggregate";
    extraWarnings.push(`Window contains ${windowRowCount.toLocaleString("en-US")} rows (above ${MAX_SCOPED_ROWS.toLocaleString("en-US")} detail cap); used database-side daily aggregation for safety and performance.`);
    const aggSql = buildDatabaseAggregateFallbackSql(tableProfile, understanding, dateColumn, windowStart, windowEnd);
    rows = await executor(aggSql);
  } else if (windowRowCount > 0) {
    const scopedSql = buildScopedColumnsQuerySql(tableProfile, safeColumns, dateColumn, windowStart, windowEnd, MAX_SCOPED_ROWS);
    rows = await executor(scopedSql);
  }

  const analysis = assembleAnalysisResult(tableProfile, understanding, rows, options, executionMode, extraWarnings);
  return { analysis, tableProfile, understanding, scopedRows: rows };
}

export async function runDynamicAnalysisForSession(
  session: Session,
  tableName: string,
  options: DynamicAnalysisOptions
) {
  const executor = createSessionQueryExecutor(session);
  return runDynamicAnalysisWithExecutor(executor, tableName, options);
}
