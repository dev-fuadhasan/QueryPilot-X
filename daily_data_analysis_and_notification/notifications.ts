import type { AnalysisReport } from "./types";
import type { BusinessDomainId } from "./profiler/types";
import type { DynamicAnalysisResult, MetricResult } from "./metrics/types";

export type AlertSeverity = "critical" | "warning" | "positive" | "info";

export type AlertCode =
  | "ZERO_REVENUE"
  | "REVENUE_DROP"
  | "REVENUE_GROWTH"
  | "LOW_MARGIN"
  | "NEGATIVE_PROFIT"
  | "HIGH_CANCELLATION"
  | "HIGH_RETURN_RATE"
  | "LOW_RATING"
  | "TOP_PERFORMER"
  | "HEALTHY_SUMMARY"
  | "ZERO_ACTIVITY"
  | "LOW_STOCK"
  | "REORDER_THRESHOLD"
  | "STOCKOUT_RISK"
  | "UNUSUAL_STOCK_MOVEMENT"
  | "SPEND_SPIKE"
  | "CONVERSION_DECLINE"
  | "ROAS_DETERIORATION"
  | "EXPENSE_SPIKE"
  | "BUDGET_EXCEEDED"
  | "OVERDUE_PAYMENT"
  | "CASH_FLOW_ALERT"
  | "RETENTION_DECLINE"
  | "CUSTOMER_INACTIVITY"
  | "CHURN_SPIKE"
  | "DELIVERY_DELAYS"
  | "FULFILLMENT_DECLINE"
  | "PENDING_BACKLOG"
  | "ACTIVE_USER_DECLINE"
  | "FEATURE_ADOPTION_DROP"
  | "RECURRING_REVENUE_DROP"
  | "DATA_QUALITY_NOTICE";

export type AlertRules = {
  enabled: boolean;
  revenueDropPercent: number;
  revenueGrowthPercent: number;
  minProfitMarginPercent: number;
  maxCancellationRatePercent: number;
  minCustomerRating: number;
  alertOnZeroRevenue: boolean;
  highlightTopPerformer: boolean;
  /** Optional domain-aware thresholds (defaults applied via sanitizeAlertRules). */
  metricDeclinePercent?: number;
  metricSpikePercent?: number;
  maxStockoutRiskPercent?: number;
  minRoasRatio?: number;
  minFulfillmentRatePercent?: number;
  minRetentionRatePercent?: number;
  maxChurnRatePercent?: number;
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
  /** Extended multi-domain & durable-storage compatible fields. */
  domainId?: BusinessDomainId;
  tableName?: string;
  metricId?: string;
  observedValue?: number | null;
  referenceValue?: number | null;
  changePercent?: number | null;
  sourceIssueType?: "business" | "data_quality";
  acknowledgedAt?: string | null;
};

export const DEFAULT_ALERT_RULES: AlertRules = {
  enabled: true,
  revenueDropPercent: 15,
  revenueGrowthPercent: 20,
  minProfitMarginPercent: 15,
  maxCancellationRatePercent: 15,
  minCustomerRating: 3.8,
  alertOnZeroRevenue: true,
  highlightTopPerformer: true,
  metricDeclinePercent: 15,
  metricSpikePercent: 25,
  maxStockoutRiskPercent: 15,
  minRoasRatio: 1.5,
  minFulfillmentRatePercent: 85,
  minRetentionRatePercent: 60,
  maxChurnRatePercent: 10
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
    highlightTopPerformer: typeof input.highlightTopPerformer === "boolean" ? input.highlightTopPerformer : DEFAULT_ALERT_RULES.highlightTopPerformer,
    metricDeclinePercent: clampNumber(input.metricDeclinePercent, DEFAULT_ALERT_RULES.metricDeclinePercent ?? 15, 1, 100),
    metricSpikePercent: clampNumber(input.metricSpikePercent, DEFAULT_ALERT_RULES.metricSpikePercent ?? 25, 1, 500),
    maxStockoutRiskPercent: clampNumber(input.maxStockoutRiskPercent, DEFAULT_ALERT_RULES.maxStockoutRiskPercent ?? 15, 1, 100),
    minRoasRatio: clampNumber(input.minRoasRatio, DEFAULT_ALERT_RULES.minRoasRatio ?? 1.5, 0.1, 100),
    minFulfillmentRatePercent: clampNumber(input.minFulfillmentRatePercent, DEFAULT_ALERT_RULES.minFulfillmentRatePercent ?? 85, 1, 100),
    minRetentionRatePercent: clampNumber(input.minRetentionRatePercent, DEFAULT_ALERT_RULES.minRetentionRatePercent ?? 60, 1, 100),
    maxChurnRatePercent: clampNumber(input.maxChurnRatePercent, DEFAULT_ALERT_RULES.maxChurnRatePercent ?? 10, 1, 100)
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
    metricValue: string,
    extra: Partial<DailyReportAlert> = {}
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
      isRead: false,
      domainId: "sales_ecommerce",
      tableName: report.dataset?.table,
      sourceIssueType: "business",
      acknowledgedAt: null,
      ...extra
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
      formatMoney(0),
      { metricId: "totalRevenue", observedValue: 0, referenceValue: report.comparisonDailyAverage?.totalRevenue ?? null }
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
        `-${formatPercent(Math.abs(changePct))}`,
        { metricId: "totalRevenue", observedValue: currentDailyRevenue, referenceValue: baseline, changePercent: Number(changePct.toFixed(2)) }
      );
    } else if (changePct >= rules.revenueGrowthPercent) {
      pushAlert(
        "REVENUE_GROWTH",
        "positive",
        "Strong revenue surge",
        `Daily revenue (${formatMoney(currentDailyRevenue)}) outperformed the ${report.comparisonDays || 30}-day daily average (${formatMoney(baseline)}) by +${formatPercent(changePct)}.`,
        "vs Baseline",
        `+${formatPercent(changePct)}`,
        { metricId: "totalRevenue", observedValue: currentDailyRevenue, referenceValue: baseline, changePercent: Number(changePct.toFixed(2)) }
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
      formatMoney(report.current.grossProfit),
      { metricId: "grossProfit", observedValue: report.current.grossProfit }
    );
  } else if (hasMargin && report.current.totalRevenue > 0 && report.current.grossProfitMargin < rules.minProfitMarginPercent) {
    pushAlert(
      "LOW_MARGIN",
      "warning",
      "Profit margin below target",
      `Gross profit margin is ${formatPercent(report.current.grossProfitMargin)}, below your ${formatPercent(rules.minProfitMarginPercent)} threshold.`,
      "Profit Margin",
      formatPercent(report.current.grossProfitMargin),
      { metricId: "grossProfitMargin", observedValue: report.current.grossProfitMargin, referenceValue: rules.minProfitMarginPercent }
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
        formatPercent(lostRate),
        { metricId: "cancellationRate", observedValue: Number(lostRate.toFixed(2)), referenceValue: rules.maxCancellationRatePercent }
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
      `${report.current.averageCustomerRating.toFixed(2)} / 5`,
      { metricId: "averageCustomerRating", observedValue: report.current.averageCustomerRating, referenceValue: rules.minCustomerRating }
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
        formatPercent(share),
        { metricId: "totalRevenue", observedValue: topProduct.revenue }
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
      String(report.current.totalOrders),
      { metricId: "totalOrders", observedValue: report.current.totalOrders }
    );
  }

  return alerts;
}

/**
 * Domain-aware alert evaluator built on top of the Stage 2 Dynamic Metrics Engine.
 * Reuses the exact same DailyReportAlert & AlertRules model without creating a competing alert system.
 * Never generates alerts for unavailable metrics and distinguishes data gaps from business issues.
 */
export function evaluateDynamicAnalysisAlerts(
  analysis: DynamicAnalysisResult,
  rawRules?: Partial<AlertRules> | null
): DailyReportAlert[] {
  const rules = sanitizeAlertRules(rawRules);
  if (!rules.enabled) return [];

  const reportKey = `${analysis.domainId}|${analysis.tableName}|${analysis.reportingPeriod.start}|${analysis.reportingPeriod.end}`;
  const periodLabel = analysis.reportingPeriod.label;
  const reportingDate = analysis.reportingPeriod.end;
  const createdAt = analysis.generatedAt || new Date().toISOString();

  const byId = new Map<string, MetricResult>(
    analysis.availableMetrics.map(m => [m.metricId, m])
  );
  const avail = (id: string): MetricResult | null => {
    const m = byId.get(id);
    return m && m.availability === "available" && m.value !== null ? m : null;
  };

  const alerts: DailyReportAlert[] = [];
  const seenKeys = new Set<string>();

  const push = (
    code: AlertCode,
    metricId: string,
    severity: AlertSeverity,
    title: string,
    message: string,
    metricLabel: string,
    metricValue: string,
    options: {
      observedValue?: number | null;
      referenceValue?: number | null;
      changePercent?: number | null;
      sourceIssueType?: "business" | "data_quality";
    } = {}
  ) => {
    const dedupId = `${reportKey}::${code}::${metricId}`;
    if (seenKeys.has(dedupId)) return;
    seenKeys.add(dedupId);
    alerts.push({
      id: dedupId,
      reportKey,
      reportingDate,
      periodLabel,
      code,
      severity,
      title,
      message,
      metricLabel,
      metricValue,
      createdAt,
      isRead: false,
      domainId: analysis.domainId,
      tableName: analysis.tableName,
      metricId,
      observedValue: options.observedValue ?? null,
      referenceValue: options.referenceValue ?? null,
      changePercent: options.changePercent ?? null,
      sourceIssueType: options.sourceIssueType ?? "business",
      acknowledgedAt: null
    });
  };

  const declineThreshold = rules.metricDeclinePercent ?? 15;
  const spikeThreshold = rules.metricSpikePercent ?? 25;

  // Source data-gap distinction: do not misreport missing source records as business deterioration
  if (analysis.source.missingRequiredRoles.length > 0) {
    push(
      "DATA_QUALITY_NOTICE",
      "schema",
      "warning",
      "Required source fields missing for full analysis",
      `Missing required field(s) for ${analysis.domainName}: ${analysis.source.missingRequiredRoles.join(", ")}. Alerts are restricted to verified available metrics.`,
      "Missing Fields",
      String(analysis.source.missingRequiredRoles.length),
      { observedValue: analysis.source.missingRequiredRoles.length, sourceIssueType: "data_quality" }
    );
  }

  if (analysis.source.rowCountInPeriod === 0) {
    if (rules.alertOnZeroRevenue) {
      push(
        "ZERO_ACTIVITY",
        "rowCount",
        "warning",
        "No records found in reporting period",
        `Table "${analysis.tableName}" contains 0 records for ${periodLabel}. Verify whether business activity was zero or source data sync is delayed.`,
        "Records",
        "0",
        { observedValue: 0, referenceValue: analysis.source.rowCountInComparison || null, sourceIssueType: "data_quality" }
      );
    }
    return alerts;
  }

  switch (analysis.domainId) {
    case "sales_ecommerce": {
      const rev = avail("totalRevenue");
      const orders = avail("totalOrders");
      const profit = avail("grossProfit");
      const margin = avail("grossProfitMargin");
      const cancel = avail("cancellationRate");
      const ret = avail("returnRate");

      if (rules.alertOnZeroRevenue && rev && rev.value === 0 && (!orders || orders.value === 0)) {
        push("ZERO_REVENUE", "totalRevenue", "warning", "No completed sales recorded", `Completed revenue and orders are both zero for ${periodLabel}.`, "Revenue", rev.formattedValue || "0.00", { observedValue: 0, referenceValue: rev.comparisonValue });
      }
      if (rev && rev.changePercent !== null) {
        if (rev.changePercent <= -rules.revenueDropPercent) {
          const sev: AlertSeverity = Math.abs(rev.changePercent) >= rules.revenueDropPercent * 2 ? "critical" : "warning";
          push("REVENUE_DROP", "totalRevenue", sev, sev === "critical" ? "Sharp revenue decline detected" : "Revenue below reference period", `Revenue (${rev.formattedValue}) declined ${formatPercent(Math.abs(rev.changePercent))} vs reference (${rev.formattedComparisonValue}).`, "Revenue", `${rev.changePercent.toFixed(1)}%`, { observedValue: rev.value, referenceValue: rev.comparisonValue, changePercent: rev.changePercent });
        } else if (rev.changePercent >= rules.revenueGrowthPercent) {
          push("REVENUE_GROWTH", "totalRevenue", "positive", "Significant revenue growth", `Revenue (${rev.formattedValue}) grew +${formatPercent(rev.changePercent)} vs reference (${rev.formattedComparisonValue}).`, "Revenue", `+${rev.changePercent.toFixed(1)}%`, { observedValue: rev.value, referenceValue: rev.comparisonValue, changePercent: rev.changePercent });
        }
      }
      if (profit && profit.value! < 0) {
        push("NEGATIVE_PROFIT", "grossProfit", "critical", "Negative gross profit", `Gross profit fell to ${profit.formattedValue} in ${periodLabel}.`, "Gross Profit", profit.formattedValue!, { observedValue: profit.value });
      } else if (margin && margin.value! < rules.minProfitMarginPercent) {
        push("LOW_MARGIN", "grossProfitMargin", "warning", "Profit margin below target", `Gross profit margin is ${margin.formattedValue}, below the ${formatPercent(rules.minProfitMarginPercent)} threshold.`, "Profit Margin", margin.formattedValue!, { observedValue: margin.value, referenceValue: rules.minProfitMarginPercent });
      }
      if (cancel && cancel.value! >= rules.maxCancellationRatePercent) {
        const sev: AlertSeverity = cancel.value! >= rules.maxCancellationRatePercent * 2 ? "critical" : "warning";
        push("HIGH_CANCELLATION", "cancellationRate", sev, "High order cancellation rate", `Cancellation rate reached ${cancel.formattedValue}, exceeding ${formatPercent(rules.maxCancellationRatePercent)}.`, "Cancellation", cancel.formattedValue!, { observedValue: cancel.value, referenceValue: rules.maxCancellationRatePercent });
      }
      if (ret && ret.value! >= rules.maxCancellationRatePercent) {
        push("HIGH_RETURN_RATE", "returnRate", "warning", "High order return rate", `Return rate reached ${ret.formattedValue}, exceeding ${formatPercent(rules.maxCancellationRatePercent)}.`, "Return Rate", ret.formattedValue!, { observedValue: ret.value, referenceValue: rules.maxCancellationRatePercent });
      }
      break;
    }

    case "inventory_supply_chain": {
      const reorder = avail("reorderAlerts");
      const risk = avail("stockoutRisk");
      const movement = avail("stockMovement");
      const stock = avail("availableStock");
      const maxRisk = rules.maxStockoutRiskPercent ?? 15;

      if (reorder && reorder.value! > 0) {
        push("REORDER_THRESHOLD", "reorderAlerts", reorder.value! >= 5 ? "critical" : "warning", "Reorder threshold reached", `${reorder.formattedValue} SKU position(s) are at or below their configured reorder point.`, "Reorder Alerts", reorder.formattedValue!, { observedValue: reorder.value, referenceValue: 0 });
      }
      if (risk && risk.value! >= maxRisk) {
        push("STOCKOUT_RISK", "stockoutRisk", risk.value! >= maxRisk * 2 ? "critical" : "warning", "Elevated stockout risk", `${risk.formattedValue} of tracked SKU-warehouse positions are at zero stock or below reorder threshold (limit ${formatPercent(maxRisk)}).`, "Stockout Risk", risk.formattedValue!, { observedValue: risk.value, referenceValue: maxRisk });
      }
      if (stock && stock.changePercent !== null && stock.changePercent <= -declineThreshold) {
        push("LOW_STOCK", "availableStock", "warning", "Available stock dropped significantly", `Available stock (${stock.formattedValue}) fell ${formatPercent(Math.abs(stock.changePercent))} vs reference (${stock.formattedComparisonValue}).`, "Available Stock", `${stock.changePercent.toFixed(1)}%`, { observedValue: stock.value, referenceValue: stock.comparisonValue, changePercent: stock.changePercent });
      }
      if (movement && movement.changePercent !== null && Math.abs(movement.changePercent) >= spikeThreshold) {
        push("UNUSUAL_STOCK_MOVEMENT", "stockMovement", "info", "Unusual stock movement detected", `Net stock movement (${movement.formattedValue}) shifted ${movement.changePercent >= 0 ? "+" : ""}${movement.changePercent.toFixed(1)}% vs reference (${movement.formattedComparisonValue}).`, "Stock Movement", movement.formattedValue!, { observedValue: movement.value, referenceValue: movement.comparisonValue, changePercent: movement.changePercent });
      }
      break;
    }

    case "marketing_campaigns": {
      const spend = avail("campaignSpend");
      const conversions = avail("conversions");
      const roas = avail("returnOnAdSpend");
      const minRoas = rules.minRoasRatio ?? 1.5;

      if (spend && spend.changePercent !== null && spend.changePercent >= spikeThreshold) {
        push("SPEND_SPIKE", "campaignSpend", "warning", "Campaign spend increased sharply", `Campaign spend (${spend.formattedValue}) rose +${formatPercent(spend.changePercent)} vs reference (${spend.formattedComparisonValue}).`, "Spend", `+${spend.changePercent.toFixed(1)}%`, { observedValue: spend.value, referenceValue: spend.comparisonValue, changePercent: spend.changePercent });
      }
      if (conversions && conversions.changePercent !== null && conversions.changePercent <= -declineThreshold) {
        const sev: AlertSeverity = Math.abs(conversions.changePercent) >= declineThreshold * 2 ? "critical" : "warning";
        push("CONVERSION_DECLINE", "conversions", sev, "Campaign conversions declined", `Conversions (${conversions.formattedValue}) fell ${formatPercent(Math.abs(conversions.changePercent))} vs reference (${conversions.formattedComparisonValue}).`, "Conversions", `${conversions.changePercent.toFixed(1)}%`, { observedValue: conversions.value, referenceValue: conversions.comparisonValue, changePercent: conversions.changePercent });
      }
      if (roas && (roas.value! < minRoas || (roas.changePercent !== null && roas.changePercent <= -declineThreshold))) {
        const sev: AlertSeverity = roas.value! < 1 ? "critical" : "warning";
        push("ROAS_DETERIORATION", "returnOnAdSpend", sev, "ROAS deterioration detected", `Return on Ad Spend is ${roas.formattedValue} (target ≥ ${minRoas.toFixed(2)}x)${roas.changePercent !== null ? `, down ${formatPercent(Math.abs(roas.changePercent))} vs reference` : ""}.`, "ROAS", roas.formattedValue!, { observedValue: roas.value, referenceValue: roas.comparisonValue ?? minRoas, changePercent: roas.changePercent });
      }
      break;
    }

    case "finance_expenses": {
      const expGrowth = avail("expenseGrowth");
      const budgetVar = avail("budgetVariance");
      const overdueRec = avail("overdueReceivables");
      const overduePay = avail("overduePayables");
      const cashFlow = avail("netCashFlow");

      if (expGrowth && expGrowth.value! >= spikeThreshold) {
        const sev: AlertSeverity = expGrowth.value! >= spikeThreshold * 2 ? "critical" : "warning";
        push("EXPENSE_SPIKE", "expenseGrowth", sev, "Expense spike detected", `Expenses grew +${formatPercent(expGrowth.value!)} compared to the reference period (threshold ${formatPercent(spikeThreshold)}).`, "Expense Growth", `+${expGrowth.value!.toFixed(1)}%`, { observedValue: expGrowth.value, referenceValue: spikeThreshold, changePercent: expGrowth.value });
      }
      if (budgetVar && budgetVar.value! < 0) {
        push("BUDGET_EXCEEDED", "budgetVariance", "warning", "Actual expenses exceeded budget", `Budget variance is ${budgetVar.formattedValue}, indicating spending exceeded the planned budget.`, "Budget Variance", budgetVar.formattedValue!, { observedValue: budgetVar.value, referenceValue: 0 });
      }
      if (overduePay && overduePay.value! > 0) {
        push("OVERDUE_PAYMENT", "overduePayables", "warning", "Overdue payables require attention", `Unpaid outgoing bills past due date total ${overduePay.formattedValue}.`, "Overdue Payables", overduePay.formattedValue!, { observedValue: overduePay.value, referenceValue: 0 });
      }
      if (overdueRec && overdueRec.value! > 0) {
        push("OVERDUE_PAYMENT", "overdueReceivables", "warning", "Overdue receivables detected", `Unpaid customer receivables past due date total ${overdueRec.formattedValue}.`, "Overdue Receivables", overdueRec.formattedValue!, { observedValue: overdueRec.value, referenceValue: 0 });
      }
      if (cashFlow && (cashFlow.value! < 0 || (cashFlow.changePercent !== null && cashFlow.changePercent <= -declineThreshold))) {
        push("CASH_FLOW_ALERT", "netCashFlow", cashFlow.value! < 0 ? "critical" : "warning", cashFlow.value! < 0 ? "Negative net cash flow" : "Net cash flow declined", `Net cash flow is ${cashFlow.formattedValue}${cashFlow.formattedComparisonValue ? ` vs ${cashFlow.formattedComparisonValue} in reference` : ""}.`, "Net Cash Flow", cashFlow.formattedValue!, { observedValue: cashFlow.value, referenceValue: cashFlow.comparisonValue, changePercent: cashFlow.changePercent });
      }
      break;
    }

    case "customers_crm": {
      const retention = avail("customerRetention");
      const churn = avail("customerChurn");
      const active = avail("activeCustomers");
      const minRet = rules.minRetentionRatePercent ?? 60;
      const maxChurn = rules.maxChurnRatePercent ?? 10;

      if (retention && retention.value! < minRet) {
        push("RETENTION_DECLINE", "customerRetention", retention.value! < minRet * 0.7 ? "critical" : "warning", "Customer retention below target", `Cohort retention is ${retention.formattedValue}, below the ${formatPercent(minRet)} threshold.`, "Retention", retention.formattedValue!, { observedValue: retention.value, referenceValue: minRet });
      }
      if (churn && churn.value! >= maxChurn) {
        push("CHURN_SPIKE", "customerChurn", churn.value! >= maxChurn * 2 ? "critical" : "warning", "Elevated confirmed customer churn", `Confirmed customer churn reached ${churn.formattedValue}, exceeding ${formatPercent(maxChurn)}.`, "Churn Rate", churn.formattedValue!, { observedValue: churn.value, referenceValue: maxChurn });
      }
      if (active && active.changePercent !== null && active.changePercent <= -declineThreshold) {
        push("CUSTOMER_INACTIVITY", "activeCustomers", "warning", "Drop in active customers", `Active customers (${active.formattedValue}) fell ${formatPercent(Math.abs(active.changePercent))} vs reference (${active.formattedComparisonValue}).`, "Active Customers", `${active.changePercent.toFixed(1)}%`, { observedValue: active.value, referenceValue: active.comparisonValue, changePercent: active.changePercent });
      }
      break;
    }

    case "operations_fulfillment": {
      const delayed = avail("delayedDeliveries");
      const fulfillment = avail("fulfillmentRate");
      const backlog = avail("pendingOrderBacklog");
      const minFulfill = rules.minFulfillmentRatePercent ?? 85;

      if (delayed && delayed.value! > 0) {
        const sev: AlertSeverity = delayed.value! >= 10 || (delayed.changePercent !== null && delayed.changePercent >= spikeThreshold) ? "critical" : "warning";
        push("DELIVERY_DELAYS", "delayedDeliveries", sev, "Delivery delays detected", `${delayed.formattedValue} shipment(s) missed SLA or promised delivery targets in ${periodLabel}.`, "Delayed", delayed.formattedValue!, { observedValue: delayed.value, referenceValue: delayed.comparisonValue, changePercent: delayed.changePercent });
      }
      if (fulfillment && fulfillment.value! < minFulfill) {
        push("FULFILLMENT_DECLINE", "fulfillmentRate", fulfillment.value! < minFulfill - 15 ? "critical" : "warning", "Fulfillment rate below target", `Fulfillment rate is ${fulfillment.formattedValue}, below the ${formatPercent(minFulfill)} target.`, "Fulfillment", fulfillment.formattedValue!, { observedValue: fulfillment.value, referenceValue: minFulfill });
      }
      if (backlog && backlog.value! > 0 && (backlog.changePercent === null || backlog.changePercent >= declineThreshold)) {
        push("PENDING_BACKLOG", "pendingOrderBacklog", backlog.changePercent !== null && backlog.changePercent >= spikeThreshold ? "critical" : "warning", "Pending order backlog requires attention", `${backlog.formattedValue} order(s) remain unfulfilled in pending/processing backlog.`, "Backlog", backlog.formattedValue!, { observedValue: backlog.value, referenceValue: backlog.comparisonValue, changePercent: backlog.changePercent });
      }
      break;
    }

    case "product_usage_saas": {
      const dau = avail("dau");
      const adoption = avail("featureAdoption");
      const churn = avail("saasChurn");
      const mrr = avail("mrr");
      const maxChurn = rules.maxChurnRatePercent ?? 10;

      if (dau && dau.changePercent !== null && dau.changePercent <= -declineThreshold) {
        push("ACTIVE_USER_DECLINE", "dau", Math.abs(dau.changePercent) >= declineThreshold * 2 ? "critical" : "warning", "Daily active users declined", `DAU (${dau.formattedValue}) decreased ${formatPercent(Math.abs(dau.changePercent))} vs reference (${dau.formattedComparisonValue}).`, "DAU", `${dau.changePercent.toFixed(1)}%`, { observedValue: dau.value, referenceValue: dau.comparisonValue, changePercent: dau.changePercent });
      }
      if (adoption && adoption.value! < 50) {
        push("FEATURE_ADOPTION_DROP", "featureAdoption", "warning", "Low feature adoption observed", `Feature adoption is ${adoption.formattedValue} among period active users.`, "Adoption", adoption.formattedValue!, { observedValue: adoption.value, referenceValue: 50 });
      }
      if (churn && churn.value! >= maxChurn) {
        push("CHURN_SPIKE", "saasChurn", churn.value! >= maxChurn * 2 ? "critical" : "warning", "Elevated subscription churn", `Subscription churn reached ${churn.formattedValue}, exceeding ${formatPercent(maxChurn)}.`, "SaaS Churn", churn.formattedValue!, { observedValue: churn.value, referenceValue: maxChurn });
      }
      if (mrr && mrr.changePercent !== null && mrr.changePercent <= -declineThreshold) {
        push("RECURRING_REVENUE_DROP", "mrr", "critical", "Monthly recurring revenue declined", `MRR (${mrr.formattedValue}) fell ${formatPercent(Math.abs(mrr.changePercent))} vs reference (${mrr.formattedComparisonValue}).`, "MRR", `${mrr.changePercent.toFixed(1)}%`, { observedValue: mrr.value, referenceValue: mrr.comparisonValue, changePercent: mrr.changePercent });
      }
      break;
    }
  }

  // Highlight top dimension contributor if enabled and no issues were flagged
  if (rules.highlightTopPerformer && analysis.breakdowns.length > 0) {
    const firstDim = analysis.breakdowns[0];
    const topItem = firstDim.items[0];
    if (topItem && topItem.primaryValue > 0) {
      push(
        "TOP_PERFORMER",
        firstDim.primaryMetricId,
        "info",
        `Top ${firstDim.dimensionId}: ${topItem.label}`,
        `${topItem.label} led ${firstDim.label.toLowerCase()} with ${topItem.primaryValue.toLocaleString("en-US")}${topItem.sharePercent !== null ? ` (${formatPercent(topItem.sharePercent)} share)` : ""}.`,
        firstDim.label,
        topItem.sharePercent !== null ? formatPercent(topItem.sharePercent) : String(topItem.primaryValue),
        { observedValue: topItem.primaryValue }
      );
    }
  }

  // Healthy summary when available metrics exist and no critical/warning business issues triggered
  const hasBusinessRisk = alerts.some(a => a.sourceIssueType === "business" && (a.severity === "critical" || a.severity === "warning"));
  if (!hasBusinessRisk && analysis.availableMetrics.length > 0 && alerts.length === 0) {
    push(
      "HEALTHY_SUMMARY",
      "summary",
      "positive",
      `All ${analysis.domainName} KPIs within target thresholds`,
      `${analysis.availableMetrics.length} active metric(s) evaluated across ${analysis.source.rowCountInPeriod} record(s) in ${periodLabel} with no threshold breaches.`,
      "Metrics Checked",
      String(analysis.availableMetrics.length),
      { observedValue: analysis.availableMetrics.length }
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
    return previous
      ? { ...alert, isRead: previous.isRead, acknowledgedAt: previous.acknowledgedAt ?? alert.acknowledgedAt ?? null }
      : alert;
  });
  const incomingIds = new Set(mergedIncoming.map(item => item.id));
  const retained = existing.filter(item => !incomingIds.has(item.id));
  return [...mergedIncoming, ...retained].slice(0, Math.max(1, maxItems));
}
