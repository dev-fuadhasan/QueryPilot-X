import type { BusinessDomainId, ConfidenceLevel, RoleAssignment } from "../profiler/types";

export type MetricFormat = "currency" | "count" | "percentage" | "duration" | "quantity" | "ratio";

export type MetricUnit = "currency" | "count" | "percent" | "hours" | "days" | "seconds" | "units" | "ratio";

export type MetricPolarity = "higher_is_better" | "lower_is_better" | "neutral";

export type TrendDirection = "up" | "down" | "flat" | "unavailable";

export type MetricAvailabilityStatus = "available" | "unavailable" | "insufficient_data";

export type MetricAggregationMethod =
  | "sum"
  | "count"
  | "distinct_count"
  | "avg"
  | "rate"
  | "ratio"
  | "snapshot"
  | "derived";

export type ComparisonPreset =
  | "previous_day"
  | "previous_week"
  | "previous_month"
  | "previous_7_days"
  | "previous_30_days"
  | "previous_90_days"
  | "previous_365_days"
  | "same_weekday_previous_weeks"
  | "custom"
  | "none";

export type PeriodWindow = {
  start: string;
  end: string;
  timezone: string;
  dayCount: number;
  label: string;
};

export type ComparisonWindow = {
  preset: ComparisonPreset;
  start: string;
  end: string;
  timezone: string;
  dayCount: number;
  label: string;
  /** Used when comparing against discrete dates such as same weekday in previous weeks. */
  matchingDates?: string[];
};

export type MetricDefinition = {
  id: string;
  domainId: BusinessDomainId;
  name: string;
  description: string;
  format: MetricFormat;
  unit: MetricUnit;
  polarity: MetricPolarity;
  aggregation: MetricAggregationMethod;
  requiredRoles: string[];
  anyOfRoleGroups?: string[][];
  optionalRoles?: string[];
  /** True for volume metrics (revenue, orders, clicks) that should normalize per-day if period lengths differ. */
  normalizeComparisonByDay?: boolean;
};

export type MetricSourceField = {
  role: string;
  columnName: string;
  confidence: ConfidenceLevel;
};

export type MetricResult = {
  metricId: string;
  name: string;
  description: string;
  value: number | null;
  formattedValue: string | null;
  format: MetricFormat;
  unit: MetricUnit;
  polarity: MetricPolarity;
  reportingPeriod: PeriodWindow;
  comparisonValue: number | null;
  formattedComparisonValue: string | null;
  comparisonPeriod: ComparisonWindow | null;
  changePercent: number | null;
  trendDirection: TrendDirection;
  availability: MetricAvailabilityStatus;
  confidence: ConfidenceLevel | "unavailable";
  missingRequiredFields: string[];
  unavailableReason: string | null;
  sourceFields: MetricSourceField[];
  warnings: string[];
};

export type DimensionBreakdownItem = {
  label: string;
  primaryValue: number;
  primaryMetricId: string;
  recordCount: number;
  metrics: Record<string, number | null>;
  sharePercent: number | null;
};

export type DimensionBreakdown = {
  dimensionId: string;
  label: string;
  sourceColumn: string;
  primaryMetricId: string;
  items: DimensionBreakdownItem[];
  totalItems: number;
};

export type TimeSeriesPoint = {
  date: string;
  recordCount: number;
  metrics: Record<string, number | null>;
};

export type ComparisonSummary = {
  available: boolean;
  reason: string | null;
  improvedCount: number;
  declinedCount: number;
  flatCount: number;
};

export type AnalysisSourceMetadata = {
  tableName: string;
  rowCountInPeriod: number;
  rowCountInComparison: number;
  totalRowsEvaluated: number;
  executionMode: "database_aggregate" | "scoped_records" | "in_memory";
  roleAssignments: Record<string, RoleAssignment>;
  missingRequiredRoles: string[];
  domainFitScore: number;
};

export type DynamicAnalysisResult = {
  domainId: BusinessDomainId;
  domainName: string;
  tableName: string;
  generatedAt: string;
  timezone: string;
  reportingPeriod: PeriodWindow;
  comparisonPeriod: ComparisonWindow | null;
  metrics: MetricResult[];
  availableMetrics: MetricResult[];
  unavailableMetrics: MetricResult[];
  timeSeries: TimeSeriesPoint[];
  breakdowns: DimensionBreakdown[];
  comparisonSummary: ComparisonSummary;
  dataQualityWarnings: string[];
  source: AnalysisSourceMetadata;
  domainSpecificData?: Record<string, unknown>;
};

export type DynamicAnalysisOptions = {
  domainId?: BusinessDomainId;
  periodStart: string;
  periodEnd: string;
  timezone?: string;
  comparisonPreset?: ComparisonPreset;
  comparisonStart?: string;
  comparisonEnd?: string;
  /** Optional explicit role-to-column overrides confirmed by the organisation. */
  overrides?: Record<string, string>;
  /** Whether medium-confidence non-ambiguous fields may be used with a data-quality warning. Defaults to true. */
  allowMediumConfidence?: boolean;
  /** Explicit activation event name for Product Usage Activation Rate (required unless an activationFlag column exists). */
  activationEventName?: string;
  /** Reference timestamp for overdue / freshness calculations. */
  now?: Date;
};
