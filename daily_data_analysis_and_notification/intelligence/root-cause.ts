import type { BusinessDomainId, DomainTableUnderstanding } from "../profiler/types";
import { createRoleAccessor, type RoleAccessor } from "../metrics/domain-calculators";
import { safePercent, safeRound, safeSum } from "../metrics/math-and-periods";
import type { ComparisonWindow, DynamicAnalysisResult, MetricResult, PeriodWindow } from "../metrics/types";
import type {
  RootCauseAnalysisResult,
  RootCauseContributor,
  RootCauseMetricAnalysis
} from "./types";

const CAUSALITY_DISCLAIMER =
  "Dimension contribution reflects statistical decomposition and association within available columns; it does not prove underlying causation.";

type DomainDimensionSpec = {
  dimensionId: string;
  label: string;
  role: string;
};

const DOMAIN_DIMENSIONS: Record<BusinessDomainId, DomainDimensionSpec[]> = {
  sales_ecommerce: [
    { dimensionId: "product", label: "Product", role: "product" },
    { dimensionId: "category", label: "Category", role: "category" },
    { dimensionId: "region", label: "Region / Branch", role: "region" },
    { dimensionId: "channel", label: "Sales Channel", role: "channel" }
  ],
  inventory_supply_chain: [
    { dimensionId: "product", label: "Product / SKU", role: "product" },
    { dimensionId: "warehouse", label: "Warehouse", role: "warehouse" },
    { dimensionId: "supplier", label: "Supplier", role: "supplier" }
  ],
  marketing_campaigns: [
    { dimensionId: "campaign", label: "Campaign", role: "campaignName" },
    { dimensionId: "channel", label: "Channel", role: "channel" }
  ],
  finance_expenses: [
    { dimensionId: "expenseCategory", label: "Expense Category", role: "expenseCategory" },
    { dimensionId: "department", label: "Department", role: "department" },
    { dimensionId: "transactionType", label: "Transaction Type", role: "transactionType" },
    { dimensionId: "vendor", label: "Vendor", role: "vendor" }
  ],
  customers_crm: [
    { dimensionId: "segment", label: "Customer Segment", role: "segment" },
    { dimensionId: "acquisitionChannel", label: "Acquisition Channel", role: "acquisitionChannel" },
    { dimensionId: "region", label: "Region", role: "region" }
  ],
  operations_fulfillment: [
    { dimensionId: "region", label: "Region", role: "region" },
    { dimensionId: "carrier", label: "Carrier", role: "carrier" },
    { dimensionId: "warehouse", label: "Warehouse", role: "warehouse" },
    { dimensionId: "fulfillmentStatus", label: "Fulfillment Stage", role: "fulfillmentStatus" }
  ],
  product_usage_saas: [
    { dimensionId: "feature", label: "Feature", role: "featureName" },
    { dimensionId: "planTier", label: "Subscription Plan", role: "planTier" },
    { dimensionId: "platform", label: "Platform / Segment", role: "platform" }
  ]
};

const SALES_CANCELLED_OR_RETURNED = new Set(["cancelled", "canceled", "void", "voided", "failed", "rejected", "returned", "refunded", "chargeback"]);
const OPS_DELAYED_STATUS = new Set(["delayed", "late", "overdue", "sla breached", "breached"]);
const FINANCE_EXPENSE_TYPES = new Set(["expense", "debit", "outflow", "payable", "cost", "disbursement", "bill", "payout"]);
const FINANCE_INCOME_TYPES = new Set(["income", "credit", "inflow", "revenue", "receivable", "receipt", "deposit"]);

/**
 * Evaluates an additive metric value for a single group of rows so that
 * group contributions sum accurately without double-counting.
 */
function evaluateGroupMetricValue(
  domainId: BusinessDomainId,
  metricId: string,
  rows: Array<Record<string, unknown>>,
  accessor: RoleAccessor
): number | null {
  switch (domainId) {
    case "sales_ecommerce": {
      const eligible = rows.filter(row => {
        if (!accessor.has("status")) return true;
        const st = (accessor.str(row, "status") || "").toLowerCase();
        return !SALES_CANCELLED_OR_RETURNED.has(st);
      });
      if (metricId === "totalRevenue" && accessor.has("revenue")) {
        return safeSum(eligible.map(r => accessor.num(r, "revenue") ?? 0));
      }
      if (metricId === "totalOrders" && accessor.has("orderId")) {
        return new Set(eligible.map(r => accessor.str(r, "orderId")).filter((v): v is string => Boolean(v))).size;
      }
      if (metricId === "unitsSold" && accessor.has("quantity")) {
        return safeSum(eligible.map(r => accessor.num(r, "quantity") ?? 0));
      }
      return null;
    }

    case "inventory_supply_chain": {
      if (metricId === "stockMovement") {
        let net = 0;
        for (const r of rows) {
          net += (accessor.num(r, "quantityReceived") ?? 0) - (accessor.num(r, "quantityShipped") ?? 0);
        }
        return safeRound(net, 2);
      }
      if (metricId === "availableStock" && accessor.has("stockOnHand")) {
        // Deduplicate by latest SKU+warehouse within the group
        const latest = new Map<string, { date: string; qty: number }>();
        for (const r of rows) {
          const sku = accessor.str(r, "skuId");
          const d = accessor.dateKey(r, "recordedDate") || "";
          const qty = accessor.num(r, "stockOnHand");
          if (!sku || qty === null) continue;
          const wh = accessor.str(r, "warehouse") || "Default";
          const k = `${sku}::${wh}`;
          const prev = latest.get(k);
          if (!prev || d >= prev.date) latest.set(k, { date: d, qty });
        }
        return safeSum([...latest.values()].map(v => v.qty));
      }
      return null;
    }

    case "marketing_campaigns": {
      if (metricId === "campaignSpend" && accessor.has("spend")) {
        return safeSum(rows.map(r => accessor.num(r, "spend") ?? 0));
      }
      if (metricId === "attributedRevenue" && accessor.has("attributedRevenue")) {
        return safeSum(rows.map(r => accessor.num(r, "attributedRevenue") ?? 0));
      }
      if (metricId === "conversions" && accessor.has("conversions")) {
        return safeSum(rows.map(r => accessor.num(r, "conversions") ?? 0));
      }
      if (metricId === "clicks" && accessor.has("clicks")) {
        return safeSum(rows.map(r => accessor.num(r, "clicks") ?? 0));
      }
      return null;
    }

    case "finance_expenses": {
      if (metricId === "totalExpenses") {
        const vals: number[] = [];
        for (const r of rows) {
          if (accessor.has("expenseAmount")) {
            const v = accessor.num(r, "expenseAmount");
            if (v !== null && v > 0) vals.push(v);
          } else if (accessor.has("amount")) {
            const typeVal = (accessor.str(r, "transactionType") || "").toLowerCase();
            if (!accessor.has("transactionType") || FINANCE_EXPENSE_TYPES.has(typeVal)) {
              const v = accessor.num(r, "amount");
              if (v !== null) vals.push(Math.abs(v));
            }
          }
        }
        return safeSum(vals);
      }
      if (metricId === "totalIncome") {
        const vals: number[] = [];
        for (const r of rows) {
          if (accessor.has("incomeAmount")) {
            const v = accessor.num(r, "incomeAmount");
            if (v !== null && v > 0) vals.push(v);
          } else if (accessor.has("amount") && accessor.has("transactionType")) {
            const typeVal = (accessor.str(r, "transactionType") || "").toLowerCase();
            if (FINANCE_INCOME_TYPES.has(typeVal)) {
              const v = accessor.num(r, "amount");
              if (v !== null) vals.push(Math.abs(v));
            }
          }
        }
        return safeSum(vals);
      }
      return null;
    }

    case "customers_crm": {
      if ((metricId === "activeCustomers" || metricId === "newCustomers") && accessor.has("customerId")) {
        return new Set(rows.map(r => accessor.str(r, "customerId")).filter((v): v is string => Boolean(v))).size;
      }
      return null;
    }

    case "operations_fulfillment": {
      if (metricId === "delayedDeliveries") {
        let count = 0;
        for (const r of rows) {
          const st = (accessor.str(r, "fulfillmentStatus") || "").toLowerCase();
          const sla = accessor.has("slaMet") ? accessor.bool(r, "slaMet") : null;
          const deliv = accessor.has("deliveredAt") ? accessor.tsMs(r, "deliveredAt") : null;
          const prom = accessor.has("promisedDate") ? accessor.tsMs(r, "promisedDate") : null;
          if (sla === false || (deliv !== null && prom !== null && deliv > prom) || OPS_DELAYED_STATUS.has(st)) {
            count += 1;
          }
        }
        return count;
      }
      return null;
    }

    case "product_usage_saas": {
      if (metricId === "dau" && accessor.has("userId")) {
        return new Set(rows.map(r => accessor.str(r, "userId")).filter((v): v is string => Boolean(v))).size;
      }
      if (metricId === "mrr" && accessor.has("mrr")) {
        return safeSum(rows.map(r => accessor.num(r, "mrr") ?? 0));
      }
      return null;
    }
  }
}

const DECOMPOSABLE_METRICS_BY_DOMAIN: Record<BusinessDomainId, string[]> = {
  sales_ecommerce: ["totalRevenue", "totalOrders", "unitsSold"],
  inventory_supply_chain: ["availableStock", "stockMovement"],
  marketing_campaigns: ["attributedRevenue", "conversions", "campaignSpend", "clicks"],
  finance_expenses: ["totalExpenses", "totalIncome"],
  customers_crm: ["activeCustomers"],
  operations_fulfillment: ["delayedDeliveries"],
  product_usage_saas: ["dau", "mrr"]
};

function pickTargetMetrics(analysis: DynamicAnalysisResult): MetricResult[] {
  const allowedIds = new Set(DECOMPOSABLE_METRICS_BY_DOMAIN[analysis.domainId]);
  const candidates = analysis.availableMetrics.filter(
    m => allowedIds.has(m.metricId) && m.comparisonValue !== null
  );
  // Prioritize metrics with largest meaningful movement; keep top 2
  const changed = candidates
    .filter(m => m.changePercent !== null && Math.abs(m.changePercent) >= 3)
    .sort((a, b) => Math.abs(b.changePercent!) - Math.abs(a.changePercent!));
  if (changed.length > 0) return changed.slice(0, 2);
  return candidates.slice(0, 1);
}

export function buildRootCauseAnalysis(input: {
  analysis: DynamicAnalysisResult;
  understanding: DomainTableUnderstanding;
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  period: PeriodWindow;
  comparison: ComparisonWindow | null;
  allowMediumConfidence?: boolean;
}): RootCauseAnalysisResult {
  const { analysis, understanding, periodRows, comparisonRows, period, comparison } = input;

  if (!comparison || comparisonRows.length === 0) {
    return {
      domainId: analysis.domainId,
      domainName: analysis.domainName,
      tableName: analysis.tableName,
      reportingPeriod: period,
      comparisonPeriod: comparison,
      available: false,
      unavailableReason: "Root cause decomposition requires comparison-period records to measure group-level changes.",
      analyses: [],
      causalityDisclaimer: CAUSALITY_DISCLAIMER,
      generatedAt: analysis.generatedAt
    };
  }

  const accessor = createRoleAccessor(understanding, period.timezone, input.allowMediumConfidence ?? true);
  const rawDimensions = DOMAIN_DIMENSIONS[analysis.domainId].map(dim => {
    // Fallbacks when primary label role isn't mapped
    if (analysis.domainId === "marketing_campaigns" && dim.role === "campaignName" && !accessor.has("campaignName") && accessor.has("campaignId")) {
      return { ...dim, role: "campaignId" };
    }
    if (analysis.domainId === "product_usage_saas" && dim.role === "featureName" && !accessor.has("featureName") && accessor.has("eventName")) {
      return { ...dim, role: "eventName" };
    }
    if (analysis.domainId === "inventory_supply_chain" && dim.role === "product" && !accessor.has("product") && accessor.has("skuId")) {
      return { ...dim, role: "skuId" };
    }
    return dim;
  });

  const availableDimensions = rawDimensions.filter(dim => accessor.has(dim.role));
  if (availableDimensions.length === 0) {
    return {
      domainId: analysis.domainId,
      domainName: analysis.domainName,
      tableName: analysis.tableName,
      reportingPeriod: period,
      comparisonPeriod: comparison,
      available: false,
      unavailableReason: `Table "${analysis.tableName}" does not contain mapped categorical breakdown columns for ${analysis.domainName} root cause analysis.`,
      analyses: [],
      causalityDisclaimer: CAUSALITY_DISCLAIMER,
      generatedAt: analysis.generatedAt
    };
  }

  const targetMetrics = pickTargetMetrics(analysis);
  if (targetMetrics.length === 0) {
    return {
      domainId: analysis.domainId,
      domainName: analysis.domainName,
      tableName: analysis.tableName,
      reportingPeriod: period,
      comparisonPeriod: comparison,
      available: false,
      unavailableReason: "No decomposable metrics with valid comparison baselines are available for root cause analysis.",
      analyses: [],
      causalityDisclaimer: CAUSALITY_DISCLAIMER,
      generatedAt: analysis.generatedAt
    };
  }

  const normalizeScale = period.dayCount !== comparison.dayCount
    ? period.dayCount / comparison.dayCount
    : 1;

  const analyses: RootCauseMetricAnalysis[] = [];

  for (const metric of targetMetrics) {
    const isVolumeScaled = metric.metricId !== "availableStock" && metric.metricId !== "activeCustomers" && metric.metricId !== "dau";
    const scale = isVolumeScaled ? normalizeScale : 1;

    const currentTotal = metric.value ?? 0;
    const comparisonTotal = metric.comparisonValue ?? 0;
    const totalDelta = safeRound(currentTotal - comparisonTotal, 2);

    const positiveContributors: RootCauseContributor[] = [];
    const negativeContributors: RootCauseContributor[] = [];
    const investigatedDimensions: string[] = [];

    for (const dim of availableDimensions) {
      const sourceColumn = accessor.column(dim.role)!;
      const currGroups = new Map<string, Array<Record<string, unknown>>>();
      const compGroups = new Map<string, Array<Record<string, unknown>>>();

      for (const row of periodRows) {
        const label = accessor.str(row, dim.role) || "Unspecified";
        const list = currGroups.get(label) || [];
        list.push(row);
        currGroups.set(label, list);
      }
      for (const row of comparisonRows) {
        const label = accessor.str(row, dim.role) || "Unspecified";
        const list = compGroups.get(label) || [];
        list.push(row);
        compGroups.set(label, list);
      }

      const allLabels = new Set([...currGroups.keys(), ...compGroups.keys()]);
      if (allLabels.size === 0) continue;
      investigatedDimensions.push(dim.label);

      const dimContributors: RootCauseContributor[] = [];
      for (const groupLabel of allLabels) {
        const currRows = currGroups.get(groupLabel) || [];
        const compRows = compGroups.get(groupLabel) || [];
        const currVal = currRows.length ? (evaluateGroupMetricValue(analysis.domainId, metric.metricId, currRows, accessor) ?? 0) : 0;
        const rawCompVal = compRows.length ? (evaluateGroupMetricValue(analysis.domainId, metric.metricId, compRows, accessor) ?? 0) : 0;
        const compVal = safeRound(rawCompVal * scale, 2);
        const absoluteDelta = safeRound(currVal - compVal, 2);
        if (Math.abs(absoluteDelta) < 0.01) continue;

        const appearance: RootCauseContributor["appearance"] = currRows.length > 0 && compRows.length > 0
          ? "both_periods"
          : currRows.length > 0
            ? "current_only"
            : "comparison_only";

        const contributionPercent = totalDelta !== 0
          ? safePercent(absoluteDelta, Math.abs(totalDelta), 1)
          : null;

        const direction: RootCauseContributor["direction"] = absoluteDelta > 0 ? "positive" : "negative";
        const appearanceNote = appearance === "current_only"
          ? " (present only in current period)"
          : appearance === "comparison_only"
            ? " (present only in comparison period)"
            : "";

        const evidence = `${dim.label} "${groupLabel}" moved from ${compVal.toLocaleString("en-US", { maximumFractionDigits: 2 })} to ${currVal.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${absoluteDelta >= 0 ? "+" : ""}${absoluteDelta.toLocaleString("en-US", { maximumFractionDigits: 2 })}${contributionPercent !== null ? `, ${contributionPercent >= 0 ? "+" : ""}${contributionPercent}% relative to total net shift` : ""})${appearanceNote}.`;

        dimContributors.push({
          dimensionId: dim.dimensionId,
          dimensionLabel: dim.label,
          sourceColumn,
          groupLabel,
          currentValue: safeRound(currVal, 2),
          comparisonValue: compVal,
          absoluteDelta,
          contributionPercent,
          direction,
          appearance,
          evidence
        });
      }

      // Pick strongest contributors per dimension (keeps dimensions cleanly separated without cross-dimension double counting)
      const topPos = dimContributors
        .filter(c => c.direction === "positive")
        .sort((a, b) => b.absoluteDelta - a.absoluteDelta)
        .slice(0, 3);
      const topNeg = dimContributors
        .filter(c => c.direction === "negative")
        .sort((a, b) => a.absoluteDelta - b.absoluteDelta)
        .slice(0, 3);

      positiveContributors.push(...topPos);
      negativeContributors.push(...topNeg);
    }

    positiveContributors.sort((a, b) => b.absoluteDelta - a.absoluteDelta);
    negativeContributors.sort((a, b) => a.absoluteDelta - b.absoluteDelta);

    const topDriver = totalDelta < 0 ? negativeContributors[0] : positiveContributors[0];
    const summary = topDriver
      ? `Across ${investigatedDimensions.join(", ")}, the largest associated shift for ${metric.name} (${totalDelta >= 0 ? "+" : ""}${totalDelta}) was ${topDriver.evidence}`
      : `${metric.name} showed no material group-level variance across ${investigatedDimensions.join(", ") || "available dimensions"}.`;

    analyses.push({
      metricId: metric.metricId,
      metricName: metric.name,
      currentValue: currentTotal,
      comparisonValue: comparisonTotal,
      totalDelta,
      changePercent: metric.changePercent,
      investigatedDimensions,
      positiveContributors: positiveContributors.slice(0, 6),
      negativeContributors: negativeContributors.slice(0, 6),
      summary,
      causalityDisclaimer: CAUSALITY_DISCLAIMER,
      reliability: investigatedDimensions.length > 0 ? "reliable" : "unavailable",
      unavailableReason: investigatedDimensions.length > 0 ? null : "No populated group values found for root cause decomposition."
    });
  }

  return {
    domainId: analysis.domainId,
    domainName: analysis.domainName,
    tableName: analysis.tableName,
    reportingPeriod: period,
    comparisonPeriod: comparison,
    available: analyses.length > 0,
    unavailableReason: analyses.length > 0 ? null : "Insufficient group-level variance to produce root cause findings.",
    analyses,
    causalityDisclaimer: CAUSALITY_DISCLAIMER,
    generatedAt: analysis.generatedAt
  };
}
