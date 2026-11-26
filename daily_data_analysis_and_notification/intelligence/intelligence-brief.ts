import { evaluateMetricComparisonStatus } from "../metrics/math-and-periods";
import type { DynamicAnalysisResult, MetricResult } from "../metrics/types";
import type {
  BriefFinding,
  DailyIntelligenceBrief,
  DataHealthReport,
  RootCauseAnalysisResult
} from "./types";

function whyMetricMatters(domainName: string, metric: MetricResult): string {
  if (metric.polarity === "higher_is_better") {
    return `${metric.name} is a core ${domainName} performance indicator where higher values reflect stronger performance.`;
  }
  if (metric.polarity === "lower_is_better") {
    return `${metric.name} is a risk/efficiency indicator in ${domainName} where increases signal higher cost, friction, or operational pressure.`;
  }
  return `${metric.name} tracks activity level and resource balance for ${domainName}.`;
}

export function buildDailyIntelligenceBrief(
  analysis: DynamicAnalysisResult,
  context: {
    rootCause?: RootCauseAnalysisResult | null;
    dataHealth?: DataHealthReport | null;
  } = {}
): DailyIntelligenceBrief {
  const findings: BriefFinding[] = [];
  const dataCaveats: string[] = [...analysis.dataQualityWarnings];

  if (analysis.unavailableMetrics.length > 0) {
    dataCaveats.push(
      `${analysis.unavailableMetrics.length} domain metric(s) could not be calculated due to missing columns or insufficient records: ${analysis.unavailableMetrics.slice(0, 4).map(m => m.name).join(", ")}${analysis.unavailableMetrics.length > 4 ? "…" : ""}.`
    );
  }

  // Honest insufficient-data handling
  if (analysis.availableMetrics.length === 0 || analysis.source.rowCountInPeriod === 0) {
    const reason = analysis.source.rowCountInPeriod === 0
      ? `No records were found in "${analysis.tableName}" for ${analysis.reportingPeriod.label}.`
      : `None of the ${analysis.domainName} metrics could be computed from "${analysis.tableName}" because required semantic columns are missing or unconfirmed.`;

    findings.push({
      id: `brief::data_gap::insufficient`,
      category: "data_gap",
      certainty: "confirmed",
      headline: "Insufficient data for a complete daily brief",
      whatHappened: reason,
      whatChanged: null,
      affectedArea: analysis.tableName,
      whyItMatters: "Generating performance conclusions without verified source records would produce misleading insights.",
      investigateNext: analysis.source.missingRequiredRoles.length > 0
        ? `Verify column mapping for missing required field(s): ${analysis.source.missingRequiredRoles.join(", ")}.`
        : `Verify whether business activity was genuinely zero on ${analysis.reportingPeriod.label} or if source data ingestion is delayed.`,
      metricId: null,
      metricValue: null,
      changePercent: null
    });

    return {
      domainId: analysis.domainId,
      domainName: analysis.domainName,
      tableName: analysis.tableName,
      reportingPeriod: analysis.reportingPeriod,
      comparisonPeriod: analysis.comparisonPeriod,
      status: "insufficient_data",
      executiveSummary: `${reason} No unsupported business trends were inferred.`,
      findings,
      positiveHighlights: [],
      negativeHighlights: [],
      unusualActivities: [],
      dataCaveats: [...new Set(dataCaveats)],
      generatedAt: analysis.generatedAt
    };
  }

  // Index root-cause top contributors by metricId for evidence-backed area attribution
  const rootCauseByMetric = new Map(
    (context.rootCause?.analyses || []).map(a => [a.metricId, a])
  );

  // Rank metrics with valid comparison changes by absolute percentage magnitude
  const comparedMetrics = analysis.availableMetrics
    .filter(m => m.changePercent !== null && Math.abs(m.changePercent) >= 5)
    .sort((a, b) => Math.abs(b.changePercent!) - Math.abs(a.changePercent!));

  for (const metric of comparedMetrics) {
    const evalStatus = evaluateMetricComparisonStatus({
      metricId: metric.metricId,
      metricName: metric.name,
      polarity: metric.polarity,
      currentValue: metric.value,
      referenceValue: metric.comparisonValue,
      available: metric.availability === "available"
    });
    const effectiveChangePct = evalStatus.changePercent ?? metric.changePercent!;
    const absChange = Math.abs(effectiveChangePct);
    const isUnusual = absChange >= 35;
    const rc = rootCauseByMetric.get(metric.metricId);
    const topContributor = effectiveChangePct < 0
      ? rc?.negativeContributors[0]
      : rc?.positiveContributors[0];

    const affectedArea = topContributor
      ? `${topContributor.dimensionLabel}: ${topContributor.groupLabel}`
      : analysis.breakdowns[0]?.items[0]
        ? `${analysis.breakdowns[0].label}: ${analysis.breakdowns[0].items[0].label}`
        : analysis.domainName;

    // Never mark a metric that is STILL in a loss position as a healthy "positive" highlight,
    // and never mark loss reduction as "negative" performance.
    let category: BriefFinding["category"];
    if (evalStatus.isLossPosition && evalStatus.performanceDirection === "improved") {
      category = "domain_event";
    } else if (evalStatus.performanceDirection === "improved") {
      category = "positive";
    } else if (evalStatus.performanceDirection === "declined") {
      category = "negative";
    } else {
      category = isUnusual ? "unusual" : "domain_event";
    }

    let headline: string;
    if (evalStatus.performanceLabel === "Improved — Loss Reduced") {
      headline = `${metric.name} loss reduced by ${absChange.toFixed(1)}% (still negative)`;
    } else if (evalStatus.performanceLabel === "Declined — Loss Increased") {
      headline = `${metric.name} loss increased by ${absChange.toFixed(1)}%`;
    } else if (evalStatus.performanceLabel === "Turned Profitable") {
      headline = `${metric.name} turned profitable (+${absChange.toFixed(1)}%)`;
    } else if (evalStatus.performanceLabel === "Moved Into Loss") {
      headline = `${metric.name} moved into loss (-${absChange.toFixed(1)}%)`;
    } else {
      const directionWord = effectiveChangePct >= 0 ? "increased" : "decreased";
      headline = `${metric.name} ${directionWord} by ${absChange.toFixed(1)}%`;
    }

    const whatChanged = `${metric.formattedValue} vs ${metric.formattedComparisonValue} reference (${effectiveChangePct >= 0 ? "+" : ""}${effectiveChangePct.toFixed(1)}%).`;

    const investigateNext = topContributor
      ? `Review ${topContributor.dimensionLabel.toLowerCase()} "${topContributor.groupLabel}", which was associated with ${topContributor.evidence}.`
      : `Review ${metric.name} drivers in Automatic Investigation.`;

    const possibleExplanation = topContributor
      ? `This shift may be associated with ${topContributor.dimensionLabel} "${topContributor.groupLabel}" (${topContributor.evidence}).`
      : null;

    findings.push({
      id: `brief::${category}::${metric.metricId}`,
      category,
      certainty: "confirmed",
      headline,
      whatHappened: `${metric.name} reached ${metric.formattedValue}.`,
      whatChanged,
      affectedArea,
      whyItMatters: whyMetricMatters(analysis.domainName, metric),
      investigateNext,
      possibleExplanation,
      metricId: metric.metricId,
      metricValue: metric.formattedValue,
      changePercent: effectiveChangePct,
      performanceDirection: evalStatus.performanceDirection,
      performanceLabel: evalStatus.performanceLabel,
      financialPosition: evalStatus.financialPosition,
      financialPositionLabel: evalStatus.financialPositionLabel,
      isLossPosition: evalStatus.isLossPosition
    });
  }

  // Domain-specific confirmed events even when comparison history is absent
  if (analysis.domainId === "inventory_supply_chain") {
    const reorder = analysis.availableMetrics.find(m => m.metricId === "reorderAlerts");
    if (reorder && reorder.value !== null && reorder.value > 0) {
      findings.push({
        id: "brief::domain_event::reorderAlerts",
        category: "domain_event",
        certainty: "confirmed",
        headline: `${reorder.formattedValue} SKU position(s) at or below reorder threshold`,
        whatHappened: `${reorder.formattedValue} deduplicated SKU-warehouse item(s) have reached or fallen below their reorder point.`,
        whatChanged: null,
        affectedArea: "Inventory Replenishment",
        whyItMatters: "Delayed replenishment can lead to stockouts and lost sales.",
        investigateNext: "Review the reorder alert SKU list and supplier lead times.",
        metricId: "reorderAlerts",
        metricValue: reorder.formattedValue,
        changePercent: reorder.changePercent
      });
    }
  } else if (analysis.domainId === "finance_expenses") {
    const budget = analysis.availableMetrics.find(m => m.metricId === "budgetVariance");
    if (budget && budget.value !== null && budget.value < 0) {
      findings.push({
        id: "brief::domain_event::budgetVariance",
        category: "domain_event",
        certainty: "confirmed",
        headline: `Actual expenses exceeded planned budget (${budget.formattedValue})`,
        whatHappened: `Recorded expenses surpassed planned budget allocation by ${Math.abs(budget.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
        whatChanged: null,
        affectedArea: analysis.breakdowns[0]?.items[0]?.label || "Expenses & Budget",
        whyItMatters: "Budget overruns reduce cash runway and net operating margin.",
        investigateNext: "Inspect department-wise and category-wise expense breakdowns to locate the largest variances.",
        metricId: "budgetVariance",
        metricValue: budget.formattedValue,
        changePercent: budget.changePercent
      });
    }
  } else if (analysis.domainId === "operations_fulfillment") {
    const delayed = analysis.availableMetrics.find(m => m.metricId === "delayedDeliveries");
    if (delayed && delayed.value !== null && delayed.value > 0) {
      findings.push({
        id: "brief::domain_event::delayedDeliveries",
        category: "domain_event",
        certainty: "confirmed",
        headline: `${delayed.formattedValue} delayed delivery record(s) observed`,
        whatHappened: `${delayed.formattedValue} shipment(s) breached SLA or promised delivery dates.`,
        whatChanged: delayed.changePercent !== null ? `${delayed.changePercent >= 0 ? "+" : ""}${delayed.changePercent.toFixed(1)}% vs reference.` : null,
        affectedArea: analysis.breakdowns[0]?.items[0]?.label || "Fulfillment Operations",
        whyItMatters: "Delivery delays directly hurt customer satisfaction and increase return/cancellation risk.",
        investigateNext: "Review region and carrier performance breakdowns to identify bottlenecks.",
        possibleExplanation: null,
        metricId: "delayedDeliveries",
        metricValue: delayed.formattedValue,
        changePercent: delayed.changePercent
      });
    }
  }

  // If no comparisons or domain alerts triggered, provide a factual snapshot finding
  if (findings.length === 0) {
    const topMetric = analysis.availableMetrics[0];
    findings.push({
      id: `brief::domain_event::snapshot_${topMetric.metricId}`,
      category: "domain_event",
      certainty: "confirmed",
      headline: `${analysis.domainName} snapshot recorded`,
      whatHappened: `${topMetric.name} was ${topMetric.formattedValue} across ${analysis.source.rowCountInPeriod} record(s).`,
      whatChanged: analysis.comparisonSummary.available
        ? "No metric shifted by more than 5% compared to reference."
        : null,
      affectedArea: analysis.domainName,
      whyItMatters: "Establishes a verified baseline from live database records.",
      investigateNext: "Monitor multi-day trends or select a wider historical comparison period.",
      possibleExplanation: null,
      metricId: topMetric.metricId,
      metricValue: topMetric.formattedValue,
      changePercent: topMetric.changePercent
    });
  }

  // Surface critical Data Health issues as explicit data_gap caveats
  if (context.dataHealth && (context.dataHealth.overallStatus === "critical" || context.dataHealth.overallStatus === "warning")) {
    const criticalChecks = context.dataHealth.checks.filter(c => c.status === "critical" || c.status === "warning").slice(0, 2);
    for (const check of criticalChecks) {
      findings.push({
        id: `brief::data_gap::${check.id}`,
        category: "data_gap",
        certainty: "confirmed",
        headline: `Data health ${check.status}: ${check.title}`,
        whatHappened: check.explanation,
        whatChanged: null,
        affectedArea: check.affectedFields.join(", ") || analysis.tableName,
        whyItMatters: "Source data quality issues can distort KPI accuracy or hide underlying trends.",
        investigateNext: check.remediation,
        metricId: null,
        metricValue: check.metricValue,
        changePercent: null
      });
    }
  }

  const positiveHighlights = findings.filter(f => f.category === "positive");
  const negativeHighlights = findings.filter(f => f.category === "negative");
  const unusualActivities = findings.filter(
    f => f.category === "unusual" || (f.changePercent !== null && Math.abs(f.changePercent) >= 35)
  );

  const status: DailyIntelligenceBrief["status"] =
    !analysis.comparisonSummary.available || analysis.unavailableMetrics.length > analysis.availableMetrics.length
      ? "limited_data"
      : "ready";

  const summaryParts: string[] = [
    `${analysis.domainName} summary across ${analysis.source.rowCountInPeriod.toLocaleString("en-US")} record(s).`
  ];
  if (positiveHighlights.length) summaryParts.push(`Positive: ${positiveHighlights[0].headline}.`);
  if (negativeHighlights.length) summaryParts.push(`Watch: ${negativeHighlights[0].headline}.`);
  if (!analysis.comparisonSummary.available && analysis.comparisonSummary.reason) {
    summaryParts.push(analysis.comparisonSummary.reason);
  }

  return {
    domainId: analysis.domainId,
    domainName: analysis.domainName,
    tableName: analysis.tableName,
    reportingPeriod: analysis.reportingPeriod,
    comparisonPeriod: analysis.comparisonPeriod,
    status,
    executiveSummary: summaryParts.join(" "),
    findings,
    positiveHighlights,
    negativeHighlights,
    unusualActivities,
    dataCaveats: [...new Set(dataCaveats)],
    generatedAt: analysis.generatedAt
  };
}
