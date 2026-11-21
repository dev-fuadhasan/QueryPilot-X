import type { AnalysisReport } from "./types";

export type AlertSeverity = "critical" | "warning" | "positive" | "info";

export type AlertCode =
  | "ZERO_REVENUE"
  | "REVENUE_DROP"
  | "REVENUE_GROWTH"
  | "LOW_MARGIN"
  | "NEGATIVE_PROFIT"
  | "HIGH_CANCELLATION"
  | "LOW_RATING"
  | "TOP_PERFORMER"
  | "HEALTHY_SUMMARY";

export type AlertRules = {
  enabled: boolean;
  revenueDropPercent: number;
  revenueGrowthPercent: number;
  minProfitMarginPercent: number;
  maxCancellationRatePercent: number;
  minCustomerRating: number;
  alertOnZeroRevenue: boolean;
  highlightTopPerformer: boolean;
};

export type DailyReportAlert = {
  id: string;
  reportKey: string;
  reportingDate: string;
  periodLabel: string;
  code: AlertCode;
  severity: AlertSeverity;
  title: string;
  message: string;
  metricLabel: string;
  metricValue: string;
  createdAt: string;
  isRead: boolean;
};

export const DEFAULT_ALERT_RULES: AlertRules = {
  enabled: true,
  revenueDropPercent: 15,
  revenueGrowthPercent: 20,
  minProfitMarginPercent: 15,
  maxCancellationRatePercent: 15,
  minCustomerRating: 3.8,
  alertOnZeroRevenue: true,
  highlightTopPerformer: true
};

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function sanitizeAlertRules(input?: Partial<AlertRules> | null): AlertRules {
  if (!input || typeof input !== "object") return { ...DEFAULT_ALERT_RULES };
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_ALERT_RULES.enabled,
    revenueDropPercent: clampNumber(input.revenueDropPercent, DEFAULT_ALERT_RULES.revenueDropPercent, 1, 100),
    revenueGrowthPercent: clampNumber(input.revenueGrowthPercent, DEFAULT_ALERT_RULES.revenueGrowthPercent, 1, 500),
    minProfitMarginPercent: clampNumber(input.minProfitMarginPercent, DEFAULT_ALERT_RULES.minProfitMarginPercent, 0, 100),
    maxCancellationRatePercent: clampNumber(input.maxCancellationRatePercent, DEFAULT_ALERT_RULES.maxCancellationRatePercent, 1, 100),
    minCustomerRating: clampNumber(input.minCustomerRating, DEFAULT_ALERT_RULES.minCustomerRating, 1, 5),
    alertOnZeroRevenue: typeof input.alertOnZeroRevenue === "boolean" ? input.alertOnZeroRevenue : DEFAULT_ALERT_RULES.alertOnZeroRevenue,
    highlightTopPerformer: typeof input.highlightTopPerformer === "boolean" ? input.highlightTopPerformer : DEFAULT_ALERT_RULES.highlightTopPerformer
  };
}

function isMetricAvailable(report: AnalysisReport, key: string) {
  return !report.availableMetrics || report.availableMetrics.includes(key);
}

function periodDayCount(start: string, end: string) {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 1;
  return Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
}

function formatMoney(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

export function evaluateReportAlerts(report: AnalysisReport, rawRules?: Partial<AlertRules> | null): DailyReportAlert[] {
  const rules = sanitizeAlertRules(rawRules);
  if (!rules.enabled) return [];

  const reportKey = report.generationKey || `${report.reportKind}|${report.periodStart}|${report.periodEnd}`;
  const periodLabel = report.periodStart === report.periodEnd
    ? report.periodStart
    : `${report.periodStart} to ${report.periodEnd}`;
  const createdAt = report.generatedAt || new Date().toISOString();
  const alerts: DailyReportAlert[] = [];

  const pushAlert = (
    code: AlertCode,
    severity: AlertSeverity,
    title: string,
    message: string,
    metricLabel: string,
    metricValue: string
  ) => {
    alerts.push({
      id: `${reportKey}::${code}`,
      reportKey,
      reportingDate: report.reportingDate,
      periodLabel,
      code,
      severity,
      title,
      message,
      metricLabel,
      metricValue,
      createdAt,
      isRead: false
    });
  };

  const hasRevenue = isMetricAvailable(report, "totalRevenue");
  const hasMargin = isMetricAvailable(report, "grossProfitMargin");
  const hasProfit = isMetricAvailable(report, "grossProfit");
  const hasRating = isMetricAvailable(report, "averageCustomerRating");

  // 1. Zero revenue / no completed orders alert
  if (rules.alertOnZeroRevenue && hasRevenue && report.current.totalRevenue <= 0 && report.current.totalOrders === 0) {
    pushAlert(
      "ZERO_REVENUE",
      "warning",
      "No completed sales recorded",
      `No completed revenue or orders were recorded for ${periodLabel}. Check order statuses or data sync timing.`,
      "Revenue",
      formatMoney(0)
    );
  }

  // 2. Revenue comparison vs comparison daily average
  if (hasRevenue && report.comparisonDailyAverage && report.comparisonDailyAverage.totalRevenue > 0) {
    const days = periodDayCount(report.periodStart, report.periodEnd);
    const currentDailyRevenue = report.current.totalRevenue / days;
    const baseline = report.comparisonDailyAverage.totalRevenue;
    const changePct = ((currentDailyRevenue - baseline) / baseline) * 100;

    if (changePct <= -rules.revenueDropPercent) {
      const severity: AlertSeverity = Math.abs(changePct) >= rules.revenueDropPercent * 2 ? "critical" : "warning";
      pushAlert(
        "REVENUE_DROP",
        severity,
        severity === "critical" ? "Sharp revenue drop detected" : "Revenue below baseline",
        `Daily revenue (${formatMoney(currentDailyRevenue)}) is down ${formatPercent(Math.abs(changePct))} compared to the ${report.comparisonDays || 30}-day daily average (${formatMoney(baseline)}).`,
        "vs Baseline",
        `-${formatPercent(Math.abs(changePct))}`
      );
    } else if (changePct >= rules.revenueGrowthPercent) {
      pushAlert(
        "REVENUE_GROWTH",
        "positive",
        "Strong revenue surge",
        `Daily revenue (${formatMoney(currentDailyRevenue)}) outperformed the ${report.comparisonDays || 30}-day daily average (${formatMoney(baseline)}) by +${formatPercent(changePct)}.`,
        "vs Baseline",
        `+${formatPercent(changePct)}`
      );
    }
  }

  // 3. Profitability / margin alerts
  if (hasProfit && report.current.totalOrders > 0 && report.current.grossProfit < 0) {
    pushAlert(
      "NEGATIVE_PROFIT",
      "critical",
      "Negative gross profit",
      `Gross profit dropped to ${formatMoney(report.current.grossProfit)} in ${periodLabel}. Review discounts and unit cost inputs immediately.`,
      "Gross Profit",
      formatMoney(report.current.grossProfit)
    );
  } else if (hasMargin && report.current.totalRevenue > 0 && report.current.grossProfitMargin < rules.minProfitMarginPercent) {
    pushAlert(
      "LOW_MARGIN",
      "warning",
      "Profit margin below target",
      `Gross profit margin is ${formatPercent(report.current.grossProfitMargin)}, below your ${formatPercent(rules.minProfitMarginPercent)} threshold.`,
      "Profit Margin",
      formatPercent(report.current.grossProfitMargin)
    );
  }

  // 4. Cancellation & return rate alert
  const statusEntries = Object.values(report.current.statusDistribution || {});
  const totalStatusOrders = statusEntries.reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
  if (totalStatusOrders > 0) {
    const lostOrders = (report.current.statusDistribution.Cancelled || 0) + (report.current.statusDistribution.Returned || 0);
    const lostRate = (lostOrders / totalStatusOrders) * 100;
    if (lostRate >= rules.maxCancellationRatePercent) {
      const severity: AlertSeverity = lostRate >= rules.maxCancellationRatePercent * 2 ? "critical" : "warning";
      pushAlert(
        "HIGH_CANCELLATION",
        severity,
        "Elevated cancellation & return rate",
        `${lostOrders} of ${totalStatusOrders} orders (${formatPercent(lostRate)}) were cancelled or returned, exceeding the ${formatPercent(rules.maxCancellationRatePercent)} threshold.`,
        "Cancel/Return",
        formatPercent(lostRate)
      );
    }
  }

  // 5. Customer rating alert
  if (hasRating && report.current.averageCustomerRating !== null && report.current.averageCustomerRating < rules.minCustomerRating) {
    pushAlert(
      "LOW_RATING",
      "warning",
      "Customer rating dipped below target",
      `Average customer rating is ${report.current.averageCustomerRating.toFixed(2)} / 5.00, below the ${rules.minCustomerRating.toFixed(1)} target.`,
      "Avg. Rating",
      `${report.current.averageCustomerRating.toFixed(2)} / 5`
    );
  }

  // 6. Top performer highlight
  if (rules.highlightTopPerformer && hasRevenue && report.current.totalRevenue > 0) {
    const topProduct = report.productPerformance.find(item => item.revenue > 0);
    if (topProduct) {
      const share = (topProduct.revenue / report.current.totalRevenue) * 100;
      pushAlert(
        "TOP_PERFORMER",
        "info",
        `Top product: ${topProduct.label}`,
        `${topProduct.label} generated ${formatMoney(topProduct.revenue)} (${formatPercent(share)} of total revenue) across ${topProduct.orders} order(s).`,
        "Revenue Share",
        formatPercent(share)
      );
    }
  }

  // 7. Healthy summary when no risks or highlights triggered
  if (alerts.length === 0 && report.current.totalOrders > 0) {
    pushAlert(
      "HEALTHY_SUMMARY",
      "positive",
      "All daily KPIs within target thresholds",
      `${report.current.totalOrders} completed order(s) recorded for ${periodLabel} with no threshold breaches.`,
      "Orders",
      String(report.current.totalOrders)
    );
  }

  return alerts;
}

export function mergeAlerts(
  existing: DailyReportAlert[],
  incoming: DailyReportAlert[],
  maxItems = 50
): DailyReportAlert[] {
  const existingById = new Map(existing.map(item => [item.id, item]));
  const mergedIncoming = incoming.map(alert => {
    const previous = existingById.get(alert.id);
    return previous ? { ...alert, isRead: previous.isRead } : alert;
  });
  const incomingIds = new Set(mergedIncoming.map(item => item.id));
  const retained = existing.filter(item => !incomingIds.has(item.id));
  return [...mergedIncoming, ...retained].slice(0, Math.max(1, maxItems));
}
