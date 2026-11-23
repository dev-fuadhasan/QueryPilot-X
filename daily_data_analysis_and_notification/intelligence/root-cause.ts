import type { BusinessDomainId, DomainTableUnderstanding, ReadOnlyQueryExecutor, TableProfile } from "../profiler/types";
import { quoteIdentifier, quoteQualifiedTable } from "../profiler/sql-safety";
import { createRoleAccessor, type RoleAccessor } from "../metrics/domain-calculators";
import { PRIMARY_DATE_ROLE_BY_DOMAIN } from "../metrics/engine";
import { safePercent, safeRound, safeSum } from "../metrics/math-and-periods";
import type { ComparisonWindow, DynamicAnalysisResult, MetricResult, PeriodWindow } from "../metrics/types";
import type {
  RootCauseAnalysisResult,
  RootCauseContributor,
  RootCauseMetricAnalysis
} from "./types";

const CAUSALITY_DISCLAIMER =
  "Dimension contribution reflects statistical decomposition and association within available columns; it does not prove underlying causation.";

export type DomainDimensionSpec = {
  dimensionId: string;
  label: string;
  role: string;
};

export const DOMAIN_DIMENSIONS: Record<BusinessDomainId, DomainDimensionSpec[]> = {
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

export type PrecomputedDimensionGroupValue = {
  groupLabel: string;
  value: number;
  rowCount: number;
};

export type PrecomputedDimensionRollup = {
  metricId: string;
  dimensionId: string;
  dimensionLabel: string;
  sourceColumn: string;
  currentGroups: PrecomputedDimensionGroupValue[];
  comparisonGroups: PrecomputedDimensionGroupValue[];
};

const SALES_CANCELLED_OR_RETURNED = new Set(["cancelled", "canceled", "void", "voided", "failed", "rejected", "returned", "refunded", "chargeback"]);
const OPS_DELAYED_STATUS = new Set(["delayed", "late", "overdue", "sla breached", "breached"]);
const FINANCE_EXPENSE_TYPES = new Set(["expense", "debit", "outflow", "payable", "cost", "disbursement", "bill", "payout"]);
const FINANCE_INCOME_TYPES = new Set(["income", "credit", "inflow", "revenue", "receivable", "receipt", "deposit"]);

const DECOMPOSABLE_METRICS_BY_DOMAIN: Record<BusinessDomainId, string[]> = {
  sales_ecommerce: ["totalRevenue", "totalOrders", "unitsSold"],
  inventory_supply_chain: ["availableStock", "stockMovement"],
  marketing_campaigns: ["attributedRevenue", "conversions", "campaignSpend", "clicks"],
  finance_expenses: ["totalExpenses", "totalIncome"],
  customers_crm: ["activeCustomers"],
  operations_fulfillment: ["delayedDeliveries"],
  product_usage_saas: ["dau", "mrr"]
};

function resolveAvailableDimensions(domainId: BusinessDomainId, accessor: RoleAccessor): DomainDimensionSpec[] {
  return DOMAIN_DIMENSIONS[domainId]
    .map(dim => {
      if (domainId === "marketing_campaigns" && dim.role === "campaignName" && !accessor.has("campaignName") && accessor.has("campaignId")) {
        return { ...dim, role: "campaignId" };
      }
      if (domainId === "product_usage_saas" && dim.role === "featureName" && !accessor.has("featureName") && accessor.has("eventName")) {
        return { ...dim, role: "eventName" };
      }
      if (domainId === "inventory_supply_chain" && dim.role === "product" && !accessor.has("product") && accessor.has("skuId")) {
        return { ...dim, role: "skuId" };
      }
      return dim;
    })
    .filter(dim => accessor.has(dim.role));
}

function pickTargetMetrics(analysis: DynamicAnalysisResult): MetricResult[] {
  const allowedIds = new Set(DECOMPOSABLE_METRICS_BY_DOMAIN[analysis.domainId]);
  const candidates = analysis.availableMetrics.filter(
    m => allowedIds.has(m.metricId) && m.comparisonValue !== null
  );
  const changed = candidates
    .filter(m => m.changePercent !== null && Math.abs(m.changePercent) >= 3)
    .sort((a, b) => Math.abs(b.changePercent!) - Math.abs(a.changePercent!));
  if (changed.length > 0) return changed.slice(0, 2);
  return candidates.slice(0, 1);
}

/**
 * Builds a safe, read-only database-side GROUP BY query for ONE categorical dimension
 * and ONE decomposable metric over a date window (or explicit list of matching dates).
 * Never loads raw rows into memory and validates every table/column identifier strictly.
 */
export function buildDimensionGroupBySql(input: {
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  domainId: BusinessDomainId;
  metricId: string;
  dimensionColumn: string;
  dateColumn: string;
  startDate: string;
  endDate: string;
  matchingDates?: string[];
  limit?: number;
}): string | null {
  const { tableProfile, understanding, domainId, metricId, dimensionColumn, dateColumn, startDate, endDate, matchingDates } = input;
  const allowedTables = new Set([tableProfile.name]);
  const allowedCols = new Set(tableProfile.columns.filter(c => !c.isSensitive && c.supported).map(c => c.name));

  if (!allowedCols.has(dimensionColumn) || !allowedCols.has(dateColumn)) return null;

  const qualified = quoteQualifiedTable(tableProfile.schema, tableProfile.name, allowedTables);
  const qDim = quoteIdentifier(dimensionColumn, allowedCols);
  const qDate = quoteIdentifier(dateColumn, allowedCols);
  const roleCol = (role: string): string | null => {
    const col = understanding.roleAssignments[role]?.columnName;
    return col && allowedCols.has(col) ? quoteIdentifier(col, allowedCols) : null;
  };

  let aggExpr: string | null = null;
  const extraPredicates: string[] = [];

  switch (domainId) {
    case "sales_ecommerce": {
      const statusCol = roleCol("status");
      if (statusCol) {
        extraPredicates.push(`LOWER(COALESCE(TRIM(CAST(${statusCol} AS TEXT)), '')) NOT IN ('cancelled','canceled','void','voided','failed','rejected','returned','refunded','chargeback')`);
      }
      if (metricId === "totalRevenue") {
        const revCol = roleCol("revenue");
        if (revCol) aggExpr = `COALESCE(SUM(${revCol}::double precision), 0)`;
      } else if (metricId === "totalOrders") {
        const orderCol = roleCol("orderId");
        if (orderCol) aggExpr = `COUNT(DISTINCT ${orderCol})`;
      } else if (metricId === "unitsSold") {
        const qtyCol = roleCol("quantity");
        if (qtyCol) aggExpr = `COALESCE(SUM(${qtyCol}::double precision), 0)`;
      }
      break;
    }

    case "inventory_supply_chain": {
      if (metricId === "stockMovement") {
        const recCol = roleCol("quantityReceived");
        const shipCol = roleCol("quantityShipped");
        if (recCol && shipCol) aggExpr = `COALESCE(SUM(COALESCE(${recCol}::double precision, 0) - COALESCE(${shipCol}::double precision, 0)), 0)`;
        else if (recCol) aggExpr = `COALESCE(SUM(${recCol}::double precision), 0)`;
        else if (shipCol) aggExpr = `COALESCE(SUM(-${shipCol}::double precision), 0)`;
      } else if (metricId === "availableStock") {
        const stockCol = roleCol("stockOnHand");
        if (stockCol) aggExpr = `COALESCE(AVG(${stockCol}::double precision), 0)`;
      }
      break;
    }

    case "marketing_campaigns": {
      const map: Record<string, string> = {
        campaignSpend: "spend",
        attributedRevenue: "attributedRevenue",
        conversions: "conversions",
        clicks: "clicks"
      };
      const targetCol = map[metricId] ? roleCol(map[metricId]) : null;
      if (targetCol) aggExpr = `COALESCE(SUM(${targetCol}::double precision), 0)`;
      break;
    }

    case "finance_expenses": {
      const typeCol = roleCol("transactionType");
      if (metricId === "totalExpenses") {
        const expCol = roleCol("expenseAmount");
        const amtCol = roleCol("amount");
        if (expCol) {
          aggExpr = `COALESCE(SUM(CASE WHEN ${expCol}::double precision > 0 THEN ${expCol}::double precision ELSE 0 END), 0)`;
        } else if (amtCol) {
          if (typeCol) {
            extraPredicates.push(`LOWER(COALESCE(TRIM(CAST(${typeCol} AS TEXT)), '')) IN ('expense','debit','outflow','payable','cost','disbursement','bill','payout')`);
          }
          aggExpr = `COALESCE(SUM(ABS(${amtCol}::double precision)), 0)`;
        }
      } else if (metricId === "totalIncome") {
        const incCol = roleCol("incomeAmount");
        const amtCol = roleCol("amount");
        if (incCol) {
          aggExpr = `COALESCE(SUM(CASE WHEN ${incCol}::double precision > 0 THEN ${incCol}::double precision ELSE 0 END), 0)`;
        } else if (amtCol && typeCol) {
          extraPredicates.push(`LOWER(COALESCE(TRIM(CAST(${typeCol} AS TEXT)), '')) IN ('income','credit','inflow','revenue','receivable','receipt','deposit')`);
          aggExpr = `COALESCE(SUM(ABS(${amtCol}::double precision)), 0)`;
        }
      }
      break;
    }

    case "customers_crm": {
      if (metricId === "activeCustomers" || metricId === "newCustomers") {
        const custCol = roleCol("customerId");
        if (custCol) aggExpr = `COUNT(DISTINCT ${custCol})`;
      }
      break;
    }

    case "operations_fulfillment": {
      if (metricId === "delayedDeliveries") {
        const slaCol = roleCol("slaMet");
        const statusCol = roleCol("fulfillmentStatus");
        const delivCol = roleCol("deliveredAt");
        const promCol = roleCol("promisedDate");
        const delayChecks: string[] = [];
        if (slaCol) delayChecks.push(`${slaCol} IS FALSE`);
        if (delivCol && promCol) delayChecks.push(`${delivCol} > ${promCol}`);
        if (statusCol) delayChecks.push(`LOWER(COALESCE(TRIM(CAST(${statusCol} AS TEXT)), '')) IN ('delayed','late','overdue','sla breached','breached')`);
        if (delayChecks.length > 0) {
          extraPredicates.push(`(${delayChecks.join(" OR ")})`);
          aggExpr = `COUNT(*)`;
        }
      }
      break;
    }

    case "product_usage_saas": {
      if (metricId === "dau") {
        const userCol = roleCol("userId");
        if (userCol) aggExpr = `COUNT(DISTINCT ${userCol})`;
      } else if (metricId === "mrr") {
        const mrrCol = roleCol("mrr");
        if (mrrCol) aggExpr = `COALESCE(SUM(${mrrCol}::double precision), 0)`;
      }
      break;
    }
  }

  if (!aggExpr) return null;

  const datePredicate = matchingDates && matchingDates.length > 0
    ? `CAST(${qDate} AS DATE) IN (${matchingDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(d => `'${d}'`).join(", ")})`
    : `${qDate} >= '${startDate}' AND ${qDate} <= '${endDate} 23:59:59'`;

  const whereParts = [datePredicate, ...extraPredicates];
  const groupExpr = `COALESCE(NULLIF(TRIM(CAST(${qDim} AS TEXT)), ''), 'Unspecified')`;
  const safeLimit = Math.max(1, Math.min(Math.trunc(input.limit || 100), 200));

  return `SELECT ${groupExpr} AS group_label, ${aggExpr} AS metric_value, COUNT(*) AS row_count FROM ${qualified} WHERE ${whereParts.join(" AND ")} GROUP BY ${groupExpr} ORDER BY ABS(${aggExpr}) DESC LIMIT ${safeLimit}`;
}

/**
 * Executes independent per-dimension database-side GROUP BY queries for high-volume datasets
 * (>25,000 rows) so Root Cause Analysis works accurately without loading entire tables into memory.
 */
export async function fetchHighVolumeDimensionRollups(input: {
  executor: ReadOnlyQueryExecutor;
  tableProfile: TableProfile;
  understanding: DomainTableUnderstanding;
  analysis: DynamicAnalysisResult;
  allowMediumConfidence?: boolean;
}): Promise<PrecomputedDimensionRollup[]> {
  const { executor, tableProfile, understanding, analysis } = input;
  const comparison = analysis.comparisonPeriod;
  if (!comparison) return [];

  const primaryDateRole = PRIMARY_DATE_ROLE_BY_DOMAIN[analysis.domainId];
  const dateColumn = understanding.roleAssignments[primaryDateRole]?.columnName;
  if (!dateColumn) return [];

  const accessor = createRoleAccessor(understanding, analysis.timezone, input.allowMediumConfidence ?? true);
  const dimensions = resolveAvailableDimensions(analysis.domainId, accessor);
  const targetMetrics = pickTargetMetrics(analysis);
  if (!dimensions.length || !targetMetrics.length) return [];

  const rollups: PrecomputedDimensionRollup[] = [];

  for (const metric of targetMetrics) {
    for (const dim of dimensions) {
      const sourceColumn = accessor.column(dim.role);
      if (!sourceColumn) continue;

      const currentSql = buildDimensionGroupBySql({
        tableProfile,
        understanding,
        domainId: analysis.domainId,
        metricId: metric.metricId,
        dimensionColumn: sourceColumn,
        dateColumn,
        startDate: analysis.reportingPeriod.start,
        endDate: analysis.reportingPeriod.end
      });
      const comparisonSql = buildDimensionGroupBySql({
        tableProfile,
        understanding,
        domainId: analysis.domainId,
        metricId: metric.metricId,
        dimensionColumn: sourceColumn,
        dateColumn,
        startDate: comparison.start,
        endDate: comparison.end,
        matchingDates: comparison.matchingDates
      });

      if (!currentSql || !comparisonSql) continue;

      try {
        const [currRows, compRows] = await Promise.all([
          executor(currentSql),
          executor(comparisonSql)
        ]);

        const toGroups = (rows: Array<Record<string, unknown>>): PrecomputedDimensionGroupValue[] =>
          rows
            .map(row => ({
              groupLabel: String(row.group_label || "Unspecified").trim() || "Unspecified",
              value: Number(row.metric_value ?? 0),
              rowCount: Math.max(0, Math.trunc(Number(row.row_count ?? 0)))
            }))
            .filter(g => Number.isFinite(g.value));

        rollups.push({
          metricId: metric.metricId,
          dimensionId: dim.dimensionId,
          dimensionLabel: dim.label,
          sourceColumn,
          currentGroups: toGroups(currRows),
          comparisonGroups: toGroups(compRows)
        });
      } catch {
        // Non-fatal: skip this dimension cleanly if database query fails; other dimensions still succeed
      }
    }
  }

  return rollups;
}

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

function buildContributorsFromGroupMaps(input: {
  dimensionId: string;
  dimensionLabel: string;
  sourceColumn: string;
  currentMap: Map<string, { value: number; present: boolean }>;
  comparisonMap: Map<string, { value: number; present: boolean }>;
  totalDelta: number;
  scale: number;
}): { positive: RootCauseContributor[]; negative: RootCauseContributor[] } {
  const { dimensionId, dimensionLabel, sourceColumn, currentMap, comparisonMap, totalDelta, scale } = input;
  const allLabels = new Set([...currentMap.keys(), ...comparisonMap.keys()]);
  const dimContributors: RootCauseContributor[] = [];

  for (const groupLabel of allLabels) {
    const currEntry = currentMap.get(groupLabel);
    const compEntry = comparisonMap.get(groupLabel);
    const currVal = currEntry ? currEntry.value : 0;
    const rawCompVal = compEntry ? compEntry.value : 0;
    const compVal = safeRound(rawCompVal * scale, 2);
    const absoluteDelta = safeRound(currVal - compVal, 2);
    if (Math.abs(absoluteDelta) < 0.01) continue;

    const appearance: RootCauseContributor["appearance"] = currEntry?.present && compEntry?.present
      ? "both_periods"
      : currEntry?.present
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

    const evidence = `${dimensionLabel} "${groupLabel}" moved from ${compVal.toLocaleString("en-US", { maximumFractionDigits: 2 })} to ${currVal.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${absoluteDelta >= 0 ? "+" : ""}${absoluteDelta.toLocaleString("en-US", { maximumFractionDigits: 2 })}${contributionPercent !== null ? `, ${contributionPercent >= 0 ? "+" : ""}${contributionPercent}% relative to total net shift` : ""})${appearanceNote}.`;

    dimContributors.push({
      dimensionId,
      dimensionLabel,
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

  return {
    positive: dimContributors
      .filter(c => c.direction === "positive")
      .sort((a, b) => b.absoluteDelta - a.absoluteDelta)
      .slice(0, 3),
    negative: dimContributors
      .filter(c => c.direction === "negative")
      .sort((a, b) => a.absoluteDelta - b.absoluteDelta)
      .slice(0, 3)
  };
}

export function buildRootCauseAnalysis(input: {
  analysis: DynamicAnalysisResult;
  understanding: DomainTableUnderstanding;
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  period: PeriodWindow;
  comparison: ComparisonWindow | null;
  allowMediumConfidence?: boolean;
  /** Database-side per-dimension GROUP BY rollups used for high-volume (>25,000 row) tables. */
  precomputedRollups?: PrecomputedDimensionRollup[];
}): RootCauseAnalysisResult {
  const { analysis, understanding, periodRows, comparisonRows, period, comparison, precomputedRollups } = input;
  const hasPrecomputed = Boolean(precomputedRollups && precomputedRollups.length > 0);

  if (!comparison || (!hasPrecomputed && comparisonRows.length === 0)) {
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

  if (analysis.source.executionMode === "database_aggregate" && !hasPrecomputed) {
    return {
      domainId: analysis.domainId,
      domainName: analysis.domainName,
      tableName: analysis.tableName,
      reportingPeriod: period,
      comparisonPeriod: comparison,
      available: false,
      unavailableReason: "High-volume dataset required database-side dimension GROUP BY rollups, which were unavailable for the mapped columns.",
      analyses: [],
      causalityDisclaimer: CAUSALITY_DISCLAIMER,
      generatedAt: analysis.generatedAt
    };
  }

  const accessor = createRoleAccessor(understanding, period.timezone, input.allowMediumConfidence ?? true);
  const availableDimensions = resolveAvailableDimensions(analysis.domainId, accessor);

  if (availableDimensions.length === 0 && !hasPrecomputed) {
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

    const metricRollups = hasPrecomputed
      ? precomputedRollups!.filter(r => r.metricId === metric.metricId)
      : [];

    if (metricRollups.length > 0) {
      // High-volume database-side GROUP BY mode: each dimension was queried independently
      for (const rollup of metricRollups) {
        const currentMap = new Map<string, { value: number; present: boolean }>();
        const comparisonMap = new Map<string, { value: number; present: boolean }>();

        for (const g of rollup.currentGroups) {
          currentMap.set(g.groupLabel, { value: g.value, present: g.rowCount > 0 || g.value !== 0 });
        }
        for (const g of rollup.comparisonGroups) {
          comparisonMap.set(g.groupLabel, { value: g.value, present: g.rowCount > 0 || g.value !== 0 });
        }

        if (currentMap.size === 0 && comparisonMap.size === 0) continue;
        investigatedDimensions.push(rollup.dimensionLabel);

        const { positive, negative } = buildContributorsFromGroupMaps({
          dimensionId: rollup.dimensionId,
          dimensionLabel: rollup.dimensionLabel,
          sourceColumn: rollup.sourceColumn,
          currentMap,
          comparisonMap,
          totalDelta,
          scale
        });

        positiveContributors.push(...positive);
        negativeContributors.push(...negative);
      }
    } else {
      // Standard scoped-records mode
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

        const currentMap = new Map<string, { value: number; present: boolean }>();
        const comparisonMap = new Map<string, { value: number; present: boolean }>();

        for (const [label, rows] of currGroups.entries()) {
          currentMap.set(label, {
            value: evaluateGroupMetricValue(analysis.domainId, metric.metricId, rows, accessor) ?? 0,
            present: rows.length > 0
          });
        }
        for (const [label, rows] of compGroups.entries()) {
          comparisonMap.set(label, {
            value: evaluateGroupMetricValue(analysis.domainId, metric.metricId, rows, accessor) ?? 0,
            present: rows.length > 0
          });
        }

        if (currentMap.size === 0 && comparisonMap.size === 0) continue;
        investigatedDimensions.push(dim.label);

        const { positive, negative } = buildContributorsFromGroupMaps({
          dimensionId: dim.dimensionId,
          dimensionLabel: dim.label,
          sourceColumn,
          currentMap,
          comparisonMap,
          totalDelta,
          scale
        });

        positiveContributors.push(...positive);
        negativeContributors.push(...negative);
      }
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
