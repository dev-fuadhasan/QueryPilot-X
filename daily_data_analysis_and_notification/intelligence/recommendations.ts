import type { DynamicAnalysisResult } from "../metrics/types";
import type { DailyReportAlert } from "../notifications";
import type {
  ActionableRecommendation,
  DailyIntelligenceBrief,
  DataHealthReport,
  RecommendationPriority,
  RootCauseAnalysisResult,
  SmartDayComparison
} from "./types";

const PRIORITY_RANK: Record<RecommendationPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

function priorityFromSeverity(severity: DailyReportAlert["severity"]): RecommendationPriority {
  if (severity === "critical") return "critical";
  if (severity === "warning") return "high";
  return "medium";
}

function suggestedActionForAlert(alert: DailyReportAlert, topDriverLabel: string | null): string {
  const focus = topDriverLabel ? ` focusing first on ${topDriverLabel}` : "";
  switch (alert.code) {
    case "REVENUE_DROP":
      return `Review order volume, pricing, and conversion funnel changes${focus}, and verify whether cancellations or stockouts affected completed sales.`;
    case "NEGATIVE_PROFIT":
    case "LOW_MARGIN":
      return `Audit product pricing, discount stacking, and unit cost inputs${focus} to restore target gross margin.`;
    case "HIGH_CANCELLATION":
    case "HIGH_RETURN_RATE":
      return `Inspect cancelled and returned orders${focus} to identify fulfillment, quality, or payment failure patterns.`;
    case "REORDER_THRESHOLD":
    case "STOCKOUT_RISK":
    case "LOW_STOCK":
      return `Review SKUs at or below reorder level${focus} and initiate supplier replenishment checks against lead times.`;
    case "SPEND_SPIKE":
    case "CONVERSION_DECLINE":
    case "ROAS_DETERIORATION":
      return `Review campaign bidding, audience targeting, and landing-page conversion performance${focus} before scaling spend further.`;
    case "EXPENSE_SPIKE":
    case "BUDGET_EXCEEDED":
      return `Audit the top spending categories and departments${focus} against approved budgets to identify unplanned variances.`;
    case "OVERDUE_PAYMENT":
      return `Review overdue invoices/bills in the finance ledger and follow up on pending collections or scheduled vendor payments.`;
    case "CASH_FLOW_ALERT":
      return `Review cash inflow timing, overdue receivables, and upcoming payables to stabilize net cash flow.`;
    case "RETENTION_DECLINE":
    case "CHURN_SPIKE":
    case "CUSTOMER_INACTIVITY":
      return `Review affected customer segments${focus} to identify onboarding gaps, support friction, or renewal risks.`;
    case "DELIVERY_DELAYS":
    case "FULFILLMENT_DECLINE":
    case "PENDING_BACKLOG":
      return `Review carrier performance, regional bottlenecks, and pending fulfillment queues${focus} to clear backlog and recover SLA targets.`;
    case "ACTIVE_USER_DECLINE":
    case "FEATURE_ADOPTION_DROP":
    case "RECURRING_REVENUE_DROP":
      return `Review recent product releases, onboarding steps, and feature engagement${focus} to understand user drop-off.`;
    case "ZERO_REVENUE":
    case "ZERO_ACTIVITY":
    case "DATA_QUALITY_NOTICE":
      return `Verify source database ingestion and schema column mappings before drawing business conclusions.`;
    default:
      return `Review the supporting metrics and breakdowns${focus} to confirm next operational steps.`;
  }
}

export function buildActionableRecommendations(input: {
  analysis: DynamicAnalysisResult;
  brief?: DailyIntelligenceBrief | null;
  comparison?: SmartDayComparison | null;
  alerts: DailyReportAlert[];
  rootCause?: RootCauseAnalysisResult | null;
  dataHealth?: DataHealthReport | null;
}): ActionableRecommendation[] {
  const { analysis, alerts, rootCause, dataHealth, comparison } = input;
  const recommendations: ActionableRecommendation[] = [];
  const seenKeys = new Set<string>();
  const periodLabel = analysis.reportingPeriod.label;

  const pushUnique = (dedupKey: string, rec: ActionableRecommendation) => {
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);
    recommendations.push(rec);
  };

  // Index top negative root-cause contributors by metricId
  const topDriverByMetric = new Map<string, { label: string; evidence: string }>();
  for (const rc of rootCause?.analyses || []) {
    const driver = rc.totalDelta < 0 ? rc.negativeContributors[0] : rc.positiveContributors[0];
    if (driver) {
      topDriverByMetric.set(rc.metricId, {
        label: `${driver.dimensionLabel} "${driver.groupLabel}"`,
        evidence: driver.evidence
      });
    }
  }

  // 1. Recommendations linked to active warning/critical alerts
  for (const alert of alerts) {
    if (alert.severity !== "critical" && alert.severity !== "warning") continue;
    const metricId = alert.metricId || null;
    const driver = metricId ? topDriverByMetric.get(metricId) || null : null;
    const dedupKey = `metric::${metricId || alert.code}`;

    pushUnique(dedupKey, {
      id: `rec::alert::${alert.code}::${metricId || "general"}`,
      title: driver ? `Investigate ${alert.title.toLowerCase()} in ${driver.label}` : `Investigate: ${alert.title}`,
      description: driver ? `${alert.message} Associated contributor: ${driver.evidence}` : alert.message,
      reason: `Triggered by ${alert.severity} alert (${alert.code}) on ${alert.metricLabel}: ${alert.metricValue}.`,
      sourceTool: driver ? "root_cause" : "alerts",
      metricId,
      metricName: alert.metricLabel,
      metricValue: alert.metricValue,
      affectedDimension: driver ? driver.label : null,
      priority: priorityFromSeverity(alert.severity),
      suggestedAction: suggestedActionForAlert(alert, driver?.label || null),
      evidenceLevel: alert.sourceIssueType === "data_quality" ? "medium" : "high",
      reportingPeriodLabel: periodLabel,
      status: "open"
    });
  }

  // 2. Recommendations from root-cause findings not already covered by alerts
  for (const rc of rootCause?.analyses || []) {
    const metric = analysis.availableMetrics.find(m => m.metricId === rc.metricId);
    if (!metric) continue;
    const isAdverse = (metric.polarity === "higher_is_better" && rc.totalDelta < 0)
      || (metric.polarity === "lower_is_better" && rc.totalDelta > 0);
    if (!isAdverse) continue;

    const driver = rc.totalDelta < 0 ? rc.negativeContributors[0] : rc.positiveContributors[0];
    if (!driver) continue;

    const dedupKey = `metric::${rc.metricId}`;
    pushUnique(dedupKey, {
      id: `rec::root_cause::${rc.metricId}::${driver.dimensionId}`,
      title: `Investigate ${metric.name} shift in ${driver.dimensionLabel} "${driver.groupLabel}"`,
      description: driver.evidence,
      reason: `Root Cause Analysis identified ${driver.dimensionLabel} "${driver.groupLabel}" as the largest associated contributor to ${metric.name} (${rc.changePercent !== null ? `${rc.changePercent >= 0 ? "+" : ""}${rc.changePercent.toFixed(1)}%` : `${rc.totalDelta}`}).`,
      sourceTool: "root_cause",
      metricId: rc.metricId,
      metricName: metric.name,
      metricValue: metric.formattedValue,
      affectedDimension: `${driver.dimensionLabel}: ${driver.groupLabel}`,
      priority: rc.changePercent !== null && Math.abs(rc.changePercent) >= 25 ? "high" : "medium",
      suggestedAction: `Inspect underlying records for ${driver.dimensionLabel} "${driver.groupLabel}" and compare against prior-period activity to determine whether operational action is needed.`,
      evidenceLevel: "high",
      reportingPeriodLabel: periodLabel,
      status: "open"
    });
  }

  // 3. Recommendations from significant declining Smart Comparison rows not yet covered
  for (const row of comparison?.metrics || []) {
    if (row.outcome !== "declined" || row.changePercent === null || Math.abs(row.changePercent) < 15) continue;
    const dedupKey = `metric::${row.metricId}`;
    pushUnique(dedupKey, {
      id: `rec::comparison::${row.metricId}`,
      title: `Review ${row.name} deterioration (${row.changePercent >= 0 ? "+" : ""}${row.changePercent.toFixed(1)}%)`,
      description: `${row.name} moved from ${row.formattedComparisonValue} to ${row.formattedCurrentValue} in ${periodLabel}.`,
      reason: `Detected in Smart Day Comparison (${comparison?.mode}).`,
      sourceTool: "comparison",
      metricId: row.metricId,
      metricName: row.name,
      metricValue: row.formattedCurrentValue,
      affectedDimension: null,
      priority: Math.abs(row.changePercent) >= 30 ? "high" : "medium",
      suggestedAction: `Compare ${row.name} across a 7-day or same-weekday window and check segment breakdowns to verify whether this decline persists.`,
      evidenceLevel: "medium",
      reportingPeriodLabel: periodLabel,
      status: "open"
    });
  }

  // 4. Data Health remediation recommendations
  for (const check of dataHealth?.checks || []) {
    if (check.status !== "critical" && check.status !== "warning") continue;
    const dedupKey = `health::${check.id}`;
    pushUnique(dedupKey, {
      id: `rec::health::${check.id}`,
      title: `Resolve data health issue: ${check.title}`,
      description: check.explanation,
      reason: `Data Health Monitor flagged "${check.title}" (${check.status})${check.metricValue ? ` — ${check.metricValue}` : ""}.`,
      sourceTool: "data_health",
      metricId: null,
      metricName: check.title,
      metricValue: check.metricValue,
      affectedDimension: check.affectedFields.length ? check.affectedFields.join(", ") : analysis.tableName,
      priority: check.status === "critical" ? "critical" : "medium",
      suggestedAction: check.remediation,
      evidenceLevel: "high",
      reportingPeriodLabel: periodLabel,
      status: "open"
    });
  }

  recommendations.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id));
  return recommendations;
}
