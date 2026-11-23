import type { AnalysisReport } from "../types";
import type { BusinessDomainId } from "../profiler/types";
import { addDaysToDate, formatMetricValue, safeChangePercent, safeRound } from "../metrics/math-and-periods";
import type { DynamicAnalysisResult } from "../metrics/types";
import type {
  ArchivedReportMetric,
  ArchivedReportRecord,
  ArchivedReportSummary,
  ReportArchiveComparisonResult,
  ReportMetricComparison
} from "./types";

export function toArchivedReportFromDynamic(
  analysis: DynamicAnalysisResult,
  options: { id?: string; storageSource?: "durable_repository" | "runtime_snapshot" } = {}
): ArchivedReportRecord {
  const id = options.id || `${analysis.domainId}|${analysis.tableName}|${analysis.reportingPeriod.start}|${analysis.reportingPeriod.end}|${analysis.generatedAt}`;
  const topAvailable = analysis.availableMetrics.slice(0, 3).map(m => `${m.name}: ${m.formattedValue}`).join(" · ");

  return {
    id,
    reportingDate: analysis.reportingPeriod.end,
    periodStart: analysis.reportingPeriod.start,
    periodEnd: analysis.reportingPeriod.end,
    domainId: analysis.domainId,
    domainName: analysis.domainName,
    tableName: analysis.tableName,
    generatedAt: analysis.generatedAt,
    storageSource: options.storageSource || "runtime_snapshot",
    metrics: analysis.metrics.map(m => ({
      metricId: m.metricId,
      name: m.name,
      value: m.value,
      formattedValue: m.formattedValue,
      format: m.format,
      unit: m.unit,
      availability: m.availability
    })),
    summary: topAvailable || `${analysis.domainName} report for ${analysis.reportingPeriod.label}`
  };
}

export function toArchivedReportFromLegacySales(
  report: AnalysisReport,
  storageSource: "durable_repository" | "runtime_snapshot" = "runtime_snapshot"
): ArchivedReportRecord {
  const isAvail = (key: string) => !report.availableMetrics || report.availableMetrics.includes(key);
  const mk = (
    metricId: string,
    name: string,
    legacyKey: string,
    value: number | null,
    format: ArchivedReportMetric["format"],
    unit: ArchivedReportMetric["unit"]
  ): ArchivedReportMetric => {
    const available = isAvail(legacyKey) && value !== null;
    return {
      metricId,
      name,
      value: available ? value : null,
      formattedValue: available ? formatMetricValue(value, format, unit) : null,
      format,
      unit,
      availability: available ? "available" : "unavailable"
    };
  };

  const metrics: ArchivedReportMetric[] = [
    mk("totalRevenue", "Total Revenue", "totalRevenue", report.current.totalRevenue, "currency", "currency"),
    mk("totalOrders", "Total Orders", "totalOrders", report.current.totalOrders, "count", "count"),
    mk("unitsSold", "Units Sold", "totalUnitsSold", report.current.totalUnitsSold, "quantity", "units"),
    mk("grossProfit", "Gross Profit", "grossProfit", report.current.grossProfit, "currency", "currency"),
    mk("grossProfitMargin", "Gross Profit Margin", "grossProfitMargin", report.current.grossProfitMargin, "percentage", "percent"),
    mk("averageOrderValue", "Average Order Value", "averageOrderValue", report.current.averageOrderValue, "currency", "currency"),
    mk("totalDiscounts", "Discounts", "totalDiscounts", report.current.totalDiscounts, "currency", "currency")
  ];

  return {
    id: report.generationKey || String(report.id || `${report.reportKind}|${report.periodStart}|${report.periodEnd}`),
    reportingDate: report.reportingDate,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    domainId: "sales_ecommerce",
    domainName: "Sales & E-commerce",
    tableName: report.dataset?.table || "daily_sales_orders",
    generatedAt: report.generatedAt,
    storageSource,
    metrics,
    summary: `Sales report for ${report.periodStart} to ${report.periodEnd}`
  };
}

export function summarizeArchivedReport(report: ArchivedReportRecord): ArchivedReportSummary {
  const availableMetricCount = report.metrics.filter(m => m.availability === "available").length;
  return {
    id: report.id,
    reportingDate: report.reportingDate,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    domainId: report.domainId,
    domainName: report.domainName,
    tableName: report.tableName,
    generatedAt: report.generatedAt,
    storageSource: report.storageSource,
    summary: report.summary,
    availableMetricCount,
    unavailableMetricCount: report.metrics.length - availableMetricCount
  };
}

export type ArchiveFilterOptions = {
  domainId?: BusinessDomainId;
  tableName?: string;
  reportingDate?: string;
  startDate?: string;
  endDate?: string;
  /** Default 30-day archive window when no explicit date filters are provided. */
  defaultDays?: number;
  referenceDate?: string;
};

export function filterArchivedReports(
  reports: ArchivedReportRecord[],
  options: ArchiveFilterOptions = {}
): ArchivedReportRecord[] {
  const defaultDays = options.defaultDays ?? 30;
  const refDate = options.referenceDate || new Date().toISOString().slice(0, 10);
  const autoStart = !options.reportingDate && !options.startDate && !options.endDate && defaultDays > 0
    ? addDaysToDate(refDate, -(defaultDays - 1))
    : undefined;

  const effectiveStart = options.startDate || autoStart;
  const effectiveEnd = options.endDate;

  return reports
    .filter(item => {
      if (options.domainId && item.domainId !== options.domainId) return false;
      if (options.tableName && item.tableName !== options.tableName) return false;
      if (options.reportingDate && item.reportingDate !== options.reportingDate) return false;
      if (effectiveStart && item.reportingDate < effectiveStart) return false;
      if (effectiveEnd && item.reportingDate > effectiveEnd) return false;
      return true;
    })
    .sort((a, b) => b.reportingDate.localeCompare(a.reportingDate) || b.generatedAt.localeCompare(a.generatedAt));
}

/**
 * Compares two previously generated reports (left = baseline/earlier, right = target/later).
 * Rejects incompatible business domains cleanly and surfaces dataset mismatches,
 * newly available metrics, became-unavailable metrics, and zero-baseline safeguards.
 */
export function compareArchivedReports(
  leftReport: ArchivedReportRecord,
  rightReport: ArchivedReportRecord
): ReportArchiveComparisonResult {
  const leftSummary = summarizeArchivedReport(leftReport);
  const rightSummary = summarizeArchivedReport(rightReport);
  const compatibilityWarnings: string[] = [];

  if (leftReport.domainId !== rightReport.domainId) {
    return {
      compatible: false,
      compatibilityWarnings,
      incompatibilityReason: `Cannot compare reports from different business domains ("${leftReport.domainName}" vs "${rightReport.domainName}").`,
      leftReport: leftSummary,
      rightReport: rightSummary,
      periodDeltaDays: null,
      metrics: [],
      newlyAvailableMetrics: [],
      becameUnavailableMetrics: [],
      summary: `Reports are incompatible because they belong to different domains (${leftReport.domainName} vs ${rightReport.domainName}).`,
      generatedAt: new Date().toISOString()
    };
  }

  if (leftReport.tableName !== rightReport.tableName) {
    compatibilityWarnings.push(
      `Reports come from different source tables ("${leftReport.tableName}" vs "${rightReport.tableName}"); compare values with caution.`
    );
  }

  const leftDays = Math.max(1, Math.round((Date.parse(`${leftReport.periodEnd}T00:00:00Z`) - Date.parse(`${leftReport.periodStart}T00:00:00Z`)) / 86_400_000) + 1);
  const rightDays = Math.max(1, Math.round((Date.parse(`${rightReport.periodEnd}T00:00:00Z`) - Date.parse(`${rightReport.periodStart}T00:00:00Z`)) / 86_400_000) + 1);
  if (leftDays !== rightDays) {
    compatibilityWarnings.push(`Reporting period lengths differ (${leftDays} day(s) vs ${rightDays} day(s)).`);
  }

  const periodDeltaDays = Math.round(
    (Date.parse(`${rightReport.reportingDate}T00:00:00Z`) - Date.parse(`${leftReport.reportingDate}T00:00:00Z`)) / 86_400_000
  );

  const leftMap = new Map(leftReport.metrics.map(m => [m.metricId, m]));
  const rightMap = new Map(rightReport.metrics.map(m => [m.metricId, m]));
  const allIds = [...new Set([...leftMap.keys(), ...rightMap.keys()])];

  const metrics: ReportMetricComparison[] = [];
  const newlyAvailableMetrics: string[] = [];
  const becameUnavailableMetrics: string[] = [];

  for (const metricId of allIds) {
    const left = leftMap.get(metricId);
    const right = rightMap.get(metricId);
    const meta = right || left!;

    const leftAvail = Boolean(left && left.availability === "available" && left.value !== null);
    const rightAvail = Boolean(right && right.availability === "available" && right.value !== null);

    let status: ReportMetricComparison["status"];
    let absoluteDelta: number | null = null;
    let changePercent: number | null = null;

    if (leftAvail && rightAvail) {
      absoluteDelta = safeRound(right!.value! - left!.value!, 2);
      if (left!.value === 0) {
        status = "zero_baseline";
      } else {
        status = "compared";
        changePercent = safeChangePercent(right!.value!, left!.value!);
      }
    } else if (!leftAvail && rightAvail) {
      status = "newly_available";
      newlyAvailableMetrics.push(meta.name);
    } else if (leftAvail && !rightAvail) {
      status = "became_unavailable";
      becameUnavailableMetrics.push(meta.name);
    } else {
      status = "both_unavailable";
    }

    metrics.push({
      metricId,
      name: meta.name,
      format: meta.format,
      unit: meta.unit,
      leftValue: leftAvail ? left!.value : null,
      rightValue: rightAvail ? right!.value : null,
      formattedLeftValue: leftAvail ? left!.formattedValue : null,
      formattedRightValue: rightAvail ? right!.formattedValue : null,
      absoluteDelta,
      changePercent,
      status
    });
  }

  const comparedCount = metrics.filter(m => m.status === "compared" || m.status === "zero_baseline").length;
  const summary = `Compared ${comparedCount} metric(s) between ${leftReport.reportingDate} and ${rightReport.reportingDate}${newlyAvailableMetrics.length ? ` (${newlyAvailableMetrics.length} newly available)` : ""}${becameUnavailableMetrics.length ? ` (${becameUnavailableMetrics.length} no longer available)` : ""}.`;

  return {
    compatible: true,
    compatibilityWarnings,
    incompatibilityReason: null,
    leftReport: leftSummary,
    rightReport: rightSummary,
    periodDeltaDays: Number.isFinite(periodDeltaDays) ? periodDeltaDays : null,
    metrics,
    newlyAvailableMetrics,
    becameUnavailableMetrics,
    summary,
    generatedAt: new Date().toISOString()
  };
}
