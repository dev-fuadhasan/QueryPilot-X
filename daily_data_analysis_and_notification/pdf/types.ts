import type { BusinessDomainId } from "../profiler/types";
import type { DimensionBreakdown, MetricResult, TimeSeriesPoint } from "../metrics/types";
import type { ReportArchiveComparisonResult, UnifiedDailyAnalysisResult } from "../intelligence/types";
import type { ReportFrequencyOrManual, ReportGenerationType } from "../storage/types";

export type PdfReportMetadata = {
  reportId: string;
  organizationLabel: string;
  domainId: BusinessDomainId;
  domainName: string;
  datasetTable: string;
  generationType: ReportGenerationType;
  frequency: ReportFrequencyOrManual;
  quickRangeLabel?: string | null;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  comparisonStart: string | null;
  comparisonEnd: string | null;
  comparisonLabel: string | null;
  timezone: string;
  generatedAt: string;
};

export type HistoricalContextBundle = {
  label: string;
  periodStart: string;
  periodEnd: string;
  dayCount: number;
  rowCount: number;
  metrics: MetricResult[];
  timeSeries: TimeSeriesPoint[];
  breakdowns: DimensionBreakdown[];
  sourceNote: string;
};

export type DynamicPdfReportInput = {
  metadata: PdfReportMetadata;
  unified: UnifiedDailyAnalysisResult;
  historicalContext?: HistoricalContextBundle | null;
  archivedComparison?: ReportArchiveComparisonResult | null;
};
