import { safeRound } from "../metrics/math-and-periods";
import type { DynamicAnalysisResult, MetricResult } from "../metrics/types";
import type {
  ComparisonBaselineStatus,
  ComparisonOutcome,
  SmartComparisonMetricRow,
  SmartDayComparison
} from "./types";

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

function weekdayLabel(isoDate: string): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOfWeek(isoDate)] || "Day";
}

function buildWeekdayNote(analysis: DynamicAnalysisResult): string | null {
  const comp = analysis.comparisonPeriod;
  if (!comp) return null;

  if (comp.preset === "same_weekday_previous_weeks" && analysis.reportingPeriod.dayCount === 1) {
    return `Aligned by weekday: comparing ${weekdayLabel(analysis.reportingPeriod.start)} (${analysis.reportingPeriod.start}) against the previous ${comp.matchingDates?.length || 4} matching ${weekdayLabel(analysis.reportingPeriod.start)}s.`;
  }

  if (analysis.reportingPeriod.dayCount !== comp.dayCount && comp.preset !== "same_weekday_previous_weeks") {
    return `Period duration difference (${analysis.reportingPeriod.dayCount}d vs ${comp.dayCount}d): volume metrics are normalized per day before calculating percentage change.`;
  }

  return null;
}

function determineOutcome(metric: MetricResult): ComparisonOutcome {
  if (metric.availability !== "available" || metric.changePercent === null) return "unavailable";
  if (metric.trendDirection === "flat") return "flat";
  if (metric.polarity === "neutral") return "neutral";
  if (metric.polarity === "higher_is_better") {
    return metric.trendDirection === "up" ? "improved" : "declined";
  }
  return metric.trendDirection === "down" ? "improved" : "declined";
}

function determineBaselineStatus(metric: MetricResult, hasComparisonHistory: boolean): ComparisonBaselineStatus {
  if (metric.availability !== "available") return "unavailable";
  if (!hasComparisonHistory || metric.comparisonValue === null) return "no_history";
  if (metric.comparisonValue === 0 && metric.changePercent === null) return "zero_baseline";
  return "valid";
}

export function buildSmartDayComparison(analysis: DynamicAnalysisResult): SmartDayComparison {
  const comp = analysis.comparisonPeriod;
  const hasHistory = Boolean(comp && analysis.source.rowCountInComparison > 0);
  const mode = comp?.preset || "none";

  let statusReason: string | null = null;
  if (!comp) {
    statusReason = "No comparison period was selected.";
  } else if (analysis.source.rowCountInPeriod === 0) {
    statusReason = `No records exist in the reporting period (${analysis.reportingPeriod.label}).`;
  } else if (!hasHistory) {
    statusReason = `Insufficient historical data in the comparison window (${comp.label}).`;
  } else if (!analysis.comparisonSummary.available) {
    statusReason = analysis.comparisonSummary.reason;
  }

  const rows: SmartComparisonMetricRow[] = analysis.metrics.map(metric => {
    const baselineStatus = determineBaselineStatus(metric, hasHistory);
    const absoluteChange = metric.value !== null && metric.comparisonValue !== null && hasHistory
      ? safeRound(metric.value - metric.comparisonValue, 2)
      : null;

    let note: string | null = null;
    if (metric.availability !== "available") {
      note = metric.unavailableReason || "Metric unavailable for this dataset.";
    } else if (baselineStatus === "no_history") {
      note = "No valid historical comparison value available.";
    } else if (baselineStatus === "zero_baseline") {
      note = "Comparison baseline is zero; percentage change omitted to prevent infinite growth.";
    }

    return {
      metricId: metric.metricId,
      name: metric.name,
      format: metric.format,
      unit: metric.unit,
      polarity: metric.polarity,
      currentValue: metric.value,
      formattedCurrentValue: metric.formattedValue,
      comparisonValue: hasHistory ? metric.comparisonValue : null,
      formattedComparisonValue: hasHistory ? metric.formattedComparisonValue : null,
      absoluteChange,
      changePercent: hasHistory ? metric.changePercent : null,
      trendDirection: hasHistory ? metric.trendDirection : "unavailable",
      outcome: hasHistory ? determineOutcome(metric) : "unavailable",
      baselineStatus,
      note
    };
  });

  const improvedCount = rows.filter(r => r.outcome === "improved").length;
  const declinedCount = rows.filter(r => r.outcome === "declined").length;
  const flatCount = rows.filter(r => r.outcome === "flat").length;
  const unavailableCount = rows.filter(r => r.outcome === "unavailable").length;

  return {
    domainId: analysis.domainId,
    domainName: analysis.domainName,
    tableName: analysis.tableName,
    mode,
    reportingPeriod: analysis.reportingPeriod,
    comparisonPeriod: comp,
    comparable: Boolean(hasHistory && analysis.comparisonSummary.available),
    statusReason,
    metrics: rows,
    summary: {
      improvedCount,
      declinedCount,
      flatCount,
      unavailableCount
    },
    weekdayNote: buildWeekdayNote(analysis),
    generatedAt: analysis.generatedAt
  };
}
