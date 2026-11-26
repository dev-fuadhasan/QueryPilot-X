import type { Session } from "../../src/lib/session";
import { createSessionQueryExecutor, detectNumericDateOrder, understandTableForDomain } from "../profiler";
import type { DomainTableUnderstanding, ReadOnlyQueryExecutor, TableProfile } from "../profiler/types";
import {
  PRIMARY_DATE_ROLE_BY_DOMAIN,
  runDynamicAnalysisFromRows,
  runDynamicAnalysisWithExecutor,
  toDateKeyInTimezone
} from "../metrics";
import type { ComparisonWindow, DynamicAnalysisOptions, DynamicAnalysisResult } from "../metrics/types";
import { evaluateDynamicAnalysisAlerts, type AlertRules, type DailyReportAlert } from "../notifications";
import { buildDataHealthReport } from "./data-health";
import { runAutomatedFindingInvestigations } from "./finding-investigation";
import { buildDailyIntelligenceBrief } from "./intelligence-brief";
import { buildActionableRecommendations } from "./recommendations";
import { compareArchivedReports, toArchivedReportFromDynamic } from "./report-archive";
import { buildRootCauseAnalysis, fetchHighVolumeDimensionRollups, type PrecomputedDimensionRollup } from "./root-cause";
import { buildSmartDayComparison } from "./smart-comparison";
import type {
  ActionableRecommendation,
  ArchivedReportRecord,
  DailyAnalysisToolName,
  DailyIntelligenceBrief,
  DataHealthReport,
  ExpectedReportingCadence,
  RootCauseAnalysisResult,
  SmartDayComparison,
  UnifiedDailyAnalysisResult
} from "./types";

export type UnifiedDailyAnalysisOptions = DynamicAnalysisOptions & {
  alertRules?: Partial<AlertRules> | null;
  expectedCadence?: ExpectedReportingCadence;
  /** Optional subset of tools to compute; defaults to all 7 tools. */
  enabledTools?: DailyAnalysisToolName[];
  /** Optional archived baseline report to compare against the current report. */
  previousArchivedReport?: ArchivedReportRecord | null;
  /** Optional test/fault-injection hooks (strictly for fault-isolation verification). */
  toolOverrides?: Partial<Record<DailyAnalysisToolName, () => never>>;
  /** Optional per-finding fault-injection hooks (strictly for investigation fault-isolation tests). */
  investigationOverrides?: Record<string, () => never>;
  /** Toggle cross-call investigation caching (defaults to true). */
  useInvestigationCache?: boolean;
};

function isDateInComparison(dateKey: string, comparison: ComparisonWindow): boolean {
  if (comparison.matchingDates) return comparison.matchingDates.includes(dateKey);
  return dateKey >= comparison.start && dateKey <= comparison.end;
}

function splitRowsByWindow(
  rows: Array<Record<string, unknown>>,
  tableProfile: TableProfile,
  understanding: DomainTableUnderstanding,
  analysis: DynamicAnalysisResult,
  includeAllDatasetColumns?: boolean
) {
  const primaryDateRole = PRIMARY_DATE_ROLE_BY_DOMAIN[analysis.domainId];
  const fallbackTemporalCol = includeAllDatasetColumns
    ? tableProfile.columns.find(c => c.category === "temporal" && !c.isSensitive)?.name
    : undefined;
  const dateColumn = understanding.roleAssignments[primaryDateRole]?.columnName || fallbackTemporalCol;
  const periodRows: Array<Record<string, unknown>> = [];
  const comparisonRows: Array<Record<string, unknown>> = [];

  if (!dateColumn) {
    if (includeAllDatasetColumns) periodRows.push(...rows);
    return { periodRows, comparisonRows };
  }

  const colMeta = tableProfile.columns.find(c => c.name === dateColumn);
  const fmt = colMeta?.temporalStats?.detectedFormat;
  const dateOrder = fmt === "dmy" || fmt === "mdy"
    ? fmt
    : (detectNumericDateOrder(rows.map(r => r[dateColumn])) ?? undefined);

  for (const row of rows) {
    const key = toDateKeyInTimezone(row[dateColumn], analysis.timezone, dateOrder);
    if (!key) continue;
    if (key >= analysis.reportingPeriod.start && key <= analysis.reportingPeriod.end) {
      periodRows.push(row);
    }
    if (analysis.comparisonPeriod && isDateInComparison(key, analysis.comparisonPeriod)) {
      comparisonRows.push(row);
    }
  }
  if (includeAllDatasetColumns && periodRows.length === 0 && comparisonRows.length === 0 && rows.length > 0) {
    periodRows.push(...rows);
  }
  return { periodRows, comparisonRows };
}

function runSafely<T>(
  toolName: DailyAnalysisToolName,
  enabledSet: Set<DailyAnalysisToolName>,
  partialFailures: UnifiedDailyAnalysisResult["partialFailures"],
  fallback: T,
  fn: () => T,
  override?: () => never
): T {
  if (!enabledSet.has(toolName)) return fallback;
  try {
    if (override) override();
    return fn();
  } catch (error) {
    partialFailures.push({
      tool: toolName,
      error: error instanceof Error ? error.message : `${toolName} failed.`
    });
    return fallback;
  }
}

function assembleUnifiedResult(
  tableProfile: TableProfile,
  understanding: DomainTableUnderstanding,
  analysis: DynamicAnalysisResult,
  rows: Array<Record<string, unknown>>,
  options: UnifiedDailyAnalysisOptions,
  precomputedRollups?: PrecomputedDimensionRollup[]
): UnifiedDailyAnalysisResult {
  const allTools: DailyAnalysisToolName[] = [
    "intelligenceBrief",
    "smartComparison",
    "alerts",
    "rootCause",
    "recommendations",
    "dataHealth",
    "reportArchive"
  ];
  const enabledSet = new Set<DailyAnalysisToolName>(
    options.enabledTools && options.enabledTools.length > 0 ? options.enabledTools : allTools
  );
  const partialFailures: UnifiedDailyAnalysisResult["partialFailures"] = [];
  const overrides = options.toolOverrides || {};
  const { periodRows, comparisonRows } = splitRowsByWindow(
    rows,
    tableProfile,
    understanding,
    analysis,
    options.includeAllDatasetColumns
  );

  // Order matters so downstream tools (Brief & Recommendations) reuse upstream evidence without re-computing
  const smartComparison: SmartDayComparison | null = runSafely(
    "smartComparison",
    enabledSet,
    partialFailures,
    null,
    () => buildSmartDayComparison(analysis),
    overrides.smartComparison
  );

  const alerts: DailyReportAlert[] = runSafely(
    "alerts",
    enabledSet,
    partialFailures,
    [],
    () => evaluateDynamicAnalysisAlerts(analysis, options.alertRules),
    overrides.alerts
  );

  const dataHealth: DataHealthReport | null = runSafely(
    "dataHealth",
    enabledSet,
    partialFailures,
    null,
    () => buildDataHealthReport({
      tableProfile,
      understanding,
      analysis,
      expectedCadence: options.expectedCadence
    }),
    overrides.dataHealth
  );

  const rootCause: RootCauseAnalysisResult | null = runSafely(
    "rootCause",
    enabledSet,
    partialFailures,
    null,
    () => buildRootCauseAnalysis({
      analysis,
      understanding,
      tableProfile,
      periodRows,
      comparisonRows,
      period: analysis.reportingPeriod,
      comparison: analysis.comparisonPeriod,
      allowMediumConfidence: options.allowMediumConfidence,
      precomputedRollups
    }),
    overrides.rootCause
  );

  const intelligenceBrief: DailyIntelligenceBrief | null = runSafely(
    "intelligenceBrief",
    enabledSet,
    partialFailures,
    null,
    () => {
      const brief = buildDailyIntelligenceBrief(analysis, { rootCause, dataHealth });
      const investigations = runAutomatedFindingInvestigations({
        findings: brief.findings,
        tableProfile,
        understanding,
        analysis,
        periodRows,
        comparisonRows,
        rootCause,
        dataHealth,
        allowMediumConfidence: options.allowMediumConfidence,
        investigationOverrides: options.investigationOverrides,
        useCache: options.useInvestigationCache ?? true
      });
      const investigationByFindingId = new Map(investigations.map(inv => [inv.findingId, inv]));
      const enrichedFindings = brief.findings.map(finding => ({
        ...finding,
        investigation: investigationByFindingId.get(finding.id) ?? null
      }));
      return {
        ...brief,
        findings: enrichedFindings,
        positiveHighlights: enrichedFindings.filter(f => f.category === "positive"),
        negativeHighlights: enrichedFindings.filter(f => f.category === "negative"),
        unusualActivities: enrichedFindings.filter(f => f.category === "unusual"),
        investigations
      };
    },
    overrides.intelligenceBrief
  );

  const recommendations: ActionableRecommendation[] = runSafely(
    "recommendations",
    enabledSet,
    partialFailures,
    [],
    () => buildActionableRecommendations({
      analysis,
      brief: intelligenceBrief,
      comparison: smartComparison,
      alerts,
      rootCause,
      dataHealth
    }),
    overrides.recommendations
  );

  const reportArchive = runSafely(
    "reportArchive",
    enabledSet,
    partialFailures,
    null,
    () => {
      const currentArchivedSnapshot = toArchivedReportFromDynamic(analysis);
      const comparisonWithPrevious = options.previousArchivedReport
        ? compareArchivedReports(options.previousArchivedReport, currentArchivedSnapshot)
        : null;
      return { currentArchivedSnapshot, comparisonWithPrevious };
    },
    overrides.reportArchive
  );

  return {
    domainId: analysis.domainId,
    domainName: analysis.domainName,
    tableName: analysis.tableName,
    generatedAt: analysis.generatedAt,
    dataFreshnessTimestamp: tableProfile.freshness.latestDate,
    reportingPeriod: analysis.reportingPeriod,
    comparisonPeriod: analysis.comparisonPeriod,
    analysis,
    tools: {
      intelligenceBrief,
      smartComparison,
      alerts,
      rootCause,
      recommendations,
      dataHealth,
      reportArchive
    },
    partialFailures
  };
}

/**
 * Pure deterministic unified service for local fixtures, tests, and previews.
 */
export function runUnifiedDailyAnalysisFromRows(
  tableProfile: TableProfile,
  rows: Array<Record<string, unknown>>,
  options: UnifiedDailyAnalysisOptions
): UnifiedDailyAnalysisResult {
  const domainId = options.domainId || "sales_ecommerce";
  const understanding = understandTableForDomain(tableProfile, domainId, {
    isSelectedDomain: Boolean(options.domainId),
    overrides: options.overrides
  });
  const analysis = runDynamicAnalysisFromRows(tableProfile, rows, options);
  return assembleUnifiedResult(tableProfile, understanding, analysis, rows, options);
}

/**
 * Single-pass database-backed unified service using read-only executor.
 */
export async function runUnifiedDailyAnalysisWithExecutor(
  executor: ReadOnlyQueryExecutor,
  tableName: string,
  options: UnifiedDailyAnalysisOptions,
  precomputedTableProfile?: TableProfile
): Promise<UnifiedDailyAnalysisResult> {
  const { analysis, tableProfile, understanding, scopedRows } = await runDynamicAnalysisWithExecutor(
    executor,
    tableName,
    options,
    precomputedTableProfile
  );

  let precomputedRollups: PrecomputedDimensionRollup[] | undefined;
  const rootCauseEnabled = !options.enabledTools || options.enabledTools.includes("rootCause");
  if (rootCauseEnabled && analysis.source.executionMode === "database_aggregate") {
    precomputedRollups = await fetchHighVolumeDimensionRollups({
      executor,
      tableProfile,
      understanding,
      analysis,
      allowMediumConfidence: options.allowMediumConfidence
    });
  }

  return assembleUnifiedResult(tableProfile, understanding, analysis, scopedRows, options, precomputedRollups);
}

/**
 * High-level authenticated Supabase session entry point for API routes.
 */
export async function runUnifiedDailyAnalysisForSession(
  session: Session,
  tableName: string,
  options: UnifiedDailyAnalysisOptions
): Promise<UnifiedDailyAnalysisResult> {
  const executor = createSessionQueryExecutor(session);
  return runUnifiedDailyAnalysisWithExecutor(executor, tableName, options);
}
