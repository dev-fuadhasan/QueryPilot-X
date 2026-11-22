import type { BusinessDomainId, DataFreshness } from "../profiler/types";
import type {
  ComparisonPreset,
  ComparisonWindow,
  DynamicAnalysisResult,
  MetricFormat,
  MetricPolarity,
  MetricUnit,
  PeriodWindow,
  TrendDirection
} from "../metrics/types";
import type { DailyReportAlert } from "../notifications";

/* ============================================================================
 * 1. DAILY INTELLIGENCE BRIEF
 * ============================================================================ */

export type BriefFindingCategory =
  | "positive"
  | "negative"
  | "unusual"
  | "domain_event"
  | "data_gap";

export type BriefCertainty = "confirmed" | "possible_explanation";

export type BriefFinding = {
  id: string;
  category: BriefFindingCategory;
  certainty: BriefCertainty;
  headline: string;
  whatHappened: string;
  whatChanged: string | null;
  affectedArea: string;
  whyItMatters: string;
  investigateNext: string;
  metricId: string | null;
  metricValue: string | null;
  changePercent: number | null;
};

export type DailyIntelligenceBrief = {
  domainId: BusinessDomainId;
  domainName: string;
  tableName: string;
  reportingPeriod: PeriodWindow;
  comparisonPeriod: ComparisonWindow | null;
  status: "ready" | "limited_data" | "insufficient_data";
  executiveSummary: string;
  findings: BriefFinding[];
  positiveHighlights: BriefFinding[];
  negativeHighlights: BriefFinding[];
  unusualActivities: BriefFinding[];
  dataCaveats: string[];
  generatedAt: string;
};

/* ============================================================================
 * 2. SMART DAY COMPARISON
 * ============================================================================ */

export type ComparisonOutcome = "improved" | "declined" | "flat" | "neutral" | "unavailable";

export type ComparisonBaselineStatus = "valid" | "zero_baseline" | "no_history" | "unavailable";

export type SmartComparisonMetricRow = {
  metricId: string;
  name: string;
  format: MetricFormat;
  unit: MetricUnit;
  polarity: MetricPolarity;
  currentValue: number | null;
  formattedCurrentValue: string | null;
  comparisonValue: number | null;
  formattedComparisonValue: string | null;
  absoluteChange: number | null;
  changePercent: number | null;
  trendDirection: TrendDirection;
  outcome: ComparisonOutcome;
  baselineStatus: ComparisonBaselineStatus;
  note: string | null;
};

export type SmartDayComparison = {
  domainId: BusinessDomainId;
  domainName: string;
  tableName: string;
  mode: ComparisonPreset;
  reportingPeriod: PeriodWindow;
  comparisonPeriod: ComparisonWindow | null;
  comparable: boolean;
  statusReason: string | null;
  metrics: SmartComparisonMetricRow[];
  summary: {
    improvedCount: number;
    declinedCount: number;
    flatCount: number;
    unavailableCount: number;
  };
  weekdayNote: string | null;
  generatedAt: string;
};

/* ============================================================================
 * 4. ROOT CAUSE ANALYSIS
 * ============================================================================ */

export type RootCauseContributor = {
  dimensionId: string;
  dimensionLabel: string;
  sourceColumn: string;
  groupLabel: string;
  currentValue: number;
  comparisonValue: number;
  absoluteDelta: number;
  contributionPercent: number | null;
  direction: "positive" | "negative" | "neutral";
  appearance: "both_periods" | "current_only" | "comparison_only";
  evidence: string;
};

export type RootCauseMetricAnalysis = {
  metricId: string;
  metricName: string;
  currentValue: number;
  comparisonValue: number;
  totalDelta: number;
  changePercent: number | null;
  investigatedDimensions: string[];
  positiveContributors: RootCauseContributor[];
  negativeContributors: RootCauseContributor[];
  summary: string;
  causalityDisclaimer: string;
  reliability: "reliable" | "limited" | "unavailable";
  unavailableReason: string | null;
};

export type RootCauseAnalysisResult = {
  domainId: BusinessDomainId;
  domainName: string;
  tableName: string;
  reportingPeriod: PeriodWindow;
  comparisonPeriod: ComparisonWindow | null;
  available: boolean;
  unavailableReason: string | null;
  analyses: RootCauseMetricAnalysis[];
  causalityDisclaimer: string;
  generatedAt: string;
};

/* ============================================================================
 * 5. ACTIONABLE RECOMMENDATIONS
 * ============================================================================ */

export type RecommendationPriority = "critical" | "high" | "medium" | "low";

export type ActionableRecommendation = {
  id: string;
  title: string;
  description: string;
  reason: string;
  sourceTool: "brief" | "comparison" | "alerts" | "root_cause" | "data_health";
  metricId: string | null;
  metricName: string | null;
  metricValue: string | null;
  affectedDimension: string | null;
  priority: RecommendationPriority;
  suggestedAction: string;
  evidenceLevel: "high" | "medium" | "low";
  reportingPeriodLabel: string;
  status: "open" | "reviewed" | "completed";
};

/* ============================================================================
 * 6. DATA HEALTH MONITOR
 * ============================================================================ */

export type DataHealthSeverity = "healthy" | "info" | "warning" | "critical";

export type ExpectedReportingCadence = "daily" | "weekdays" | "weekly" | "irregular";

export type DataHealthCheckCategory =
  | "freshness"
  | "completeness"
  | "schema"
  | "duplicates"
  | "validity"
  | "volume"
  | "coverage";

export type DataHealthCheck = {
  id: string;
  category: DataHealthCheckCategory;
  title: string;
  status: DataHealthSeverity;
  affectedFields: string[];
  metricValue: string | null;
  explanation: string;
  remediation: string;
};

export type DataHealthReport = {
  tableName: string;
  domainId: BusinessDomainId;
  sourceFreshness: DataFreshness;
  analysisGeneratedAt: string;
  expectedCadence: ExpectedReportingCadence;
  overallStatus: DataHealthSeverity;
  healthScore: number;
  historicalCoverage: {
    earliestDate: string | null;
    latestDate: string | null;
    coveredDays: number;
    expectedDatesMissing: string[];
  };
  checks: DataHealthCheck[];
  generatedAt: string;
};

/* ============================================================================
 * 7. REPORT ARCHIVE & COMPARISON SUPPORT
 * ============================================================================ */

export type ArchivedReportMetric = {
  metricId: string;
  name: string;
  value: number | null;
  formattedValue: string | null;
  format: MetricFormat;
  unit: MetricUnit;
  availability: "available" | "unavailable" | "insufficient_data";
};

export type ArchivedReportRecord = {
  id: string;
  reportingDate: string;
  periodStart: string;
  periodEnd: string;
  domainId: BusinessDomainId;
  domainName: string;
  tableName: string;
  generatedAt: string;
  storageSource: "durable_repository" | "runtime_snapshot";
  metrics: ArchivedReportMetric[];
  summary: string;
};

export type ArchivedReportSummary = Omit<ArchivedReportRecord, "metrics"> & {
  availableMetricCount: number;
  unavailableMetricCount: number;
};

export type ReportMetricComparison = {
  metricId: string;
  name: string;
  format: MetricFormat;
  unit: MetricUnit;
  leftValue: number | null;
  rightValue: number | null;
  formattedLeftValue: string | null;
  formattedRightValue: string | null;
  absoluteDelta: number | null;
  changePercent: number | null;
  status: "compared" | "newly_available" | "became_unavailable" | "both_unavailable" | "zero_baseline";
};

export type ReportArchiveComparisonResult = {
  compatible: boolean;
  compatibilityWarnings: string[];
  incompatibilityReason: string | null;
  leftReport: ArchivedReportSummary;
  rightReport: ArchivedReportSummary;
  periodDeltaDays: number | null;
  metrics: ReportMetricComparison[];
  newlyAvailableMetrics: string[];
  becameUnavailableMetrics: string[];
  summary: string;
  generatedAt: string;
};

/* ============================================================================
 * 8. UNIFIED DAILY ANALYSIS RESULT
 * ============================================================================ */

export type DailyAnalysisToolName =
  | "intelligenceBrief"
  | "smartComparison"
  | "alerts"
  | "rootCause"
  | "recommendations"
  | "dataHealth"
  | "reportArchive";

export type UnifiedDailyAnalysisResult = {
  domainId: BusinessDomainId;
  domainName: string;
  tableName: string;
  generatedAt: string;
  dataFreshnessTimestamp: string | null;
  reportingPeriod: PeriodWindow;
  comparisonPeriod: ComparisonWindow | null;
  analysis: DynamicAnalysisResult;
  tools: {
    intelligenceBrief: DailyIntelligenceBrief | null;
    smartComparison: SmartDayComparison | null;
    alerts: DailyReportAlert[];
    rootCause: RootCauseAnalysisResult | null;
    recommendations: ActionableRecommendation[];
    dataHealth: DataHealthReport | null;
    reportArchive: {
      currentArchivedSnapshot: ArchivedReportRecord;
      comparisonWithPrevious: ReportArchiveComparisonResult | null;
    } | null;
  };
  partialFailures: Array<{ tool: DailyAnalysisToolName; error: string }>;
};
