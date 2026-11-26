import type { BusinessDomainId, ConfidenceLevel, DomainTableUnderstanding, RoleAssignment } from "../profiler/types";
import { normalizeName, type NumericDateOrder } from "../profiler/sql-safety";
import {
  addDaysToDate,
  enumerateDates,
  parseTimestampMs,
  safeChangePercent,
  safeDivide,
  safePercent,
  safeRound,
  safeSum,
  toCleanString,
  toDateKeyInTimezone,
  toNullableBoolean,
  toNullableNumber
} from "./math-and-periods";
import type {
  ComparisonWindow,
  DimensionBreakdown,
  DimensionBreakdownItem,
  DynamicAnalysisOptions,
  PeriodWindow,
  TimeSeriesPoint
} from "./types";

export type RoleAccessor = {
  has: (role: string) => boolean;
  column: (role: string) => string | undefined;
  assignment: (role: string) => RoleAssignment | undefined;
  confidence: (role: string) => ConfidenceLevel | "unavailable";
  raw: (row: Record<string, unknown>, role: string) => unknown;
  num: (row: Record<string, unknown>, role: string) => number | null;
  str: (row: Record<string, unknown>, role: string) => string | null;
  bool: (row: Record<string, unknown>, role: string) => boolean | null;
  dateKey: (row: Record<string, unknown>, role: string) => string | null;
  tsMs: (row: Record<string, unknown>, role: string) => number | null;
};

export type DomainCalculationInput = {
  understanding: DomainTableUnderstanding;
  allRows: Array<Record<string, unknown>>;
  periodRows: Array<Record<string, unknown>>;
  comparisonRows: Array<Record<string, unknown>>;
  period: PeriodWindow;
  comparison: ComparisonWindow | null;
  options: DynamicAnalysisOptions;
  accessor: RoleAccessor;
};

export type DomainCalculationOutput = {
  values: Record<string, number | null>;
  comparisonValues: Record<string, number | null>;
  metricWarnings: Record<string, string[]>;
  unavailableOverrides: Record<string, { status: "unavailable" | "insufficient_data"; reason: string; missingRoles?: string[] }>;
  timeSeries: TimeSeriesPoint[];
  breakdowns: DimensionBreakdown[];
  domainWarnings: string[];
  domainSpecificData?: Record<string, unknown>;
};

export function createRoleAccessor(
  understanding: DomainTableUnderstanding,
  timezone: string,
  allowMediumConfidence = true,
  preferredDateOrder?: NumericDateOrder
): RoleAccessor {
  const usable = new Map<string, RoleAssignment>();
  for (const [role, assignment] of Object.entries(understanding.roleAssignments)) {
    if (assignment.confidence === "high") {
      usable.set(role, assignment);
    } else if (allowMediumConfidence && assignment.confidence === "medium" && !assignment.ambiguous) {
      usable.set(role, assignment);
    }
  }

  return {
    has: role => usable.has(role),
    column: role => usable.get(role)?.columnName,
    assignment: role => usable.get(role),
    confidence: role => usable.get(role)?.confidence || "unavailable",
    raw: (row, role) => {
      const col = usable.get(role)?.columnName;
      return col ? row[col] : undefined;
    },
    num: (row, role) => {
      const col = usable.get(role)?.columnName;
      return col ? toNullableNumber(row[col]) : null;
    },
    str: (row, role) => {
      const col = usable.get(role)?.columnName;
      return col ? toCleanString(row[col]) : null;
    },
    bool: (row, role) => {
      const col = usable.get(role)?.columnName;
      return col ? toNullableBoolean(row[col]) : null;
    },
    dateKey: (row, role) => {
      const col = usable.get(role)?.columnName;
      return col ? toDateKeyInTimezone(row[col], timezone, preferredDateOrder) : null;
    },
    tsMs: (row, role) => {
      const col = usable.get(role)?.columnName;
      return col ? parseTimestampMs(row[col], preferredDateOrder) : null;
    }
  };
}

function addMetricWarning(map: Record<string, string[]>, metricId: string, warning: string) {
  if (!map[metricId]) map[metricId] = [];
  if (!map[metricId].includes(warning)) map[metricId].push(warning);
}

function buildBreakdown(
  dimensionId: string,
  label: string,
  sourceColumn: string,
  primaryMetricId: string,
  rawItems: Array<{ label: string; primaryValue: number; recordCount: number; metrics: Record<string, number | null> }>,
  limit = 10
): DimensionBreakdown | null {
  if (!rawItems.length) return null;
  const sorted = [...rawItems].sort((a, b) => b.primaryValue - a.primaryValue || a.label.localeCompare(b.label));
  const totalPositive = sorted.reduce((sum, item) => sum + (item.primaryValue > 0 ? item.primaryValue : 0), 0);
  const items: DimensionBreakdownItem[] = sorted.slice(0, limit).map(item => ({
    label: item.label,
    primaryValue: safeRound(item.primaryValue, 2),
    primaryMetricId,
    recordCount: item.recordCount,
    metrics: item.metrics,
    sharePercent: totalPositive > 0 && item.primaryValue >= 0 ? safePercent(item.primaryValue, totalPositive) : null
  }));
  return {
    dimensionId,
    label,
    sourceColumn,
    primaryMetricId,
    items,
    totalItems: sorted.length
  };
}

function groupRowsByDate(
  rows: Array<Record<string, unknown>>,
  accessor: RoleAccessor,
  dateRole: string
): Map<string, Array<Record<string, unknown>>> {
  const byDate = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = accessor.dateKey(row, dateRole);
    if (!key) continue;
    const list = byDate.get(key) || [];
    list.push(row);
    byDate.set(key, list);
  }
  return byDate;
}

/* ============================================================================
 * 1. SALES & E-COMMERCE
 * ============================================================================ */

const SALES_CANCELLED = new Set(["cancelled", "canceled", "void", "voided", "failed", "rejected"]);
const SALES_RETURNED = new Set(["returned", "refunded", "chargeback"]);
const SALES_COMPLETED = new Set(["completed", "complete", "delivered", "paid", "success", "successful", "fulfilled", "done"]);

function classifySalesStatus(status: string | null): "completed" | "cancelled" | "returned" | "other" {
  if (!status) return "completed"; // When no status column is present, rows are eligible
  const norm = status.trim().toLowerCase();
  if (SALES_CANCELLED.has(norm)) return "cancelled";
  if (SALES_RETURNED.has(norm)) return "returned";
  if (SALES_COMPLETED.has(norm)) return "completed";
  return "other";
}

function computeSalesRowFinancials(row: Record<string, unknown>, accessor: RoleAccessor) {
  const revenueCol = normalizeName(accessor.column("revenue") || "");
  const discountCol = normalizeName(accessor.column("discount") || "");
  const costCol = normalizeName(accessor.column("cost") || "");

  const isRevenueUnitPriceCol = Boolean(accessor.has("revenue") && accessor.has("quantity") && ["unitprice", "itemprice", "price"].includes(revenueCol));
  const isDiscountPercent = discountCol.includes("percent") || discountCol.includes("pct") || discountCol.includes("rate");
  const isTotalCost = costCol.includes("totalcost") || costCol.includes("linecost") || costCol === "cogs";

  const quantity = accessor.has("quantity") ? (accessor.num(row, "quantity") ?? 0) : 0;
  const rawRev = accessor.has("revenue") ? accessor.num(row, "revenue") : null;
  const rawUnitPrice = accessor.has("unitPrice") ? accessor.num(row, "unitPrice") : null;
  const rawDisc = accessor.has("discount") ? (accessor.num(row, "discount") ?? 0) : 0;

  let revenue: number | null = null;
  let discountAmount = 0;
  let derivedRevenueFromUnitPrice = false;

  if (rawRev !== null) {
    if (isRevenueUnitPriceCol) {
      const gross = rawRev * quantity;
      discountAmount = accessor.has("discount") ? (isDiscountPercent ? (gross * rawDisc) / 100 : rawDisc) : 0;
      revenue = gross - discountAmount;
      derivedRevenueFromUnitPrice = true;
    } else {
      revenue = rawRev;
      discountAmount = accessor.has("discount") ? (isDiscountPercent ? (rawRev * rawDisc) / 100 : rawDisc) : 0;
    }
  } else if (rawUnitPrice !== null && accessor.has("quantity")) {
    // Only derive line revenue from UnitPrice when Quantity is also present (never assume UnitPrice alone = total revenue)
    const gross = rawUnitPrice * quantity;
    discountAmount = accessor.has("discount") ? (isDiscountPercent ? (gross * rawDisc) / 100 : rawDisc) : 0;
    revenue = gross - discountAmount;
    derivedRevenueFromUnitPrice = true;
  } else if (accessor.has("discount") && !isDiscountPercent) {
    discountAmount = rawDisc;
  }

  let profit: number | null = null;
  if (accessor.has("profit")) {
    profit = accessor.num(row, "profit");
  } else if (accessor.has("cost") && revenue !== null) {
    const rawCost = accessor.num(row, "cost");
    if (rawCost !== null) {
      profit = isTotalCost || !accessor.has("quantity") ? revenue - rawCost : revenue - rawCost * quantity;
    }
  }

  return {
    quantity,
    revenue,
    discountAmount,
    profit,
    derivedRevenueFromUnitPrice
  };
}

function summarizeSalesSlice(
  rows: Array<Record<string, unknown>>,
  accessor: RoleAccessor
) {
  const completedRows: Array<Record<string, unknown>> = [];
  const allOrderIds = new Set<string>();
  const completedOrderIds = new Set<string>();
  const cancelledOrderIds = new Set<string>();
  const returnedOrderIds = new Set<string>();
  const activeCustomerIds = new Set<string>();

  const revenues: number[] = [];
  const profits: number[] = [];
  const discounts: number[] = [];
  const quantities: number[] = [];

  const hasOrderId = accessor.has("orderId");
  const hasRevenueSource = accessor.has("revenue") || (accessor.has("unitPrice") && accessor.has("quantity"));
  const revenueCol = normalizeName(accessor.column("revenue") || "");
  const isOrderHeaderTotalCol = hasOrderId && ["ordertotal", "grandtotal", "invoicetotal"].includes(revenueCol);
  const seenOrderHeaderRevenue = new Set<string>();

  let aggregatedOrdersCount = 0;
  let usedDerivedUnitPriceRevenue = false;
  let deduplicatedOrderHeaderLines = 0;

  for (const row of rows) {
    // Support high-volume database-side daily rollup rows (_agg_row_count present without per-order IDs)
    if (row._agg_row_count !== undefined && !accessor.str(row, "orderId")) {
      if (hasOrderId) {
        const entityCount = toNullableNumber(row._agg_distinct_entities) ?? toNullableNumber(row._agg_row_count) ?? 0;
        aggregatedOrdersCount += Math.max(0, Math.trunc(entityCount));
      }
      completedRows.push(row);
      const fin = computeSalesRowFinancials(row, accessor);
      if (fin.derivedRevenueFromUnitPrice) usedDerivedUnitPriceRevenue = true;
      if (fin.revenue !== null) revenues.push(fin.revenue);
      if (fin.profit !== null) profits.push(fin.profit);
      if (accessor.has("discount")) discounts.push(fin.discountAmount);
      if (accessor.has("quantity")) quantities.push(fin.quantity);
      continue;
    }

    const orderId = hasOrderId ? accessor.str(row, "orderId") : null;
    if (hasOrderId && !orderId) continue;

    if (orderId) allOrderIds.add(orderId);
    const statusClass = accessor.has("status") ? classifySalesStatus(accessor.str(row, "status")) : "completed";
    if (statusClass === "cancelled") {
      if (orderId) cancelledOrderIds.add(orderId);
      continue;
    }
    if (statusClass === "returned") {
      if (orderId) returnedOrderIds.add(orderId);
      continue;
    }
    if (statusClass !== "completed") continue;

    completedRows.push(row);
    if (orderId) completedOrderIds.add(orderId);
    const custId = accessor.str(row, "customerId");
    if (custId) activeCustomerIds.add(custId);

    const fin = computeSalesRowFinancials(row, accessor);
    if (fin.derivedRevenueFromUnitPrice) usedDerivedUnitPriceRevenue = true;

    // Prevent double-counting order-level header totals repeated across multi-line orders
    if (isOrderHeaderTotalCol && orderId) {
      if (!seenOrderHeaderRevenue.has(orderId)) {
        seenOrderHeaderRevenue.add(orderId);
        if (fin.revenue !== null) revenues.push(fin.revenue);
      } else {
        deduplicatedOrderHeaderLines += 1;
      }
    } else if (fin.revenue !== null) {
      revenues.push(fin.revenue);
    }

    if (fin.profit !== null) profits.push(fin.profit);
    if (accessor.has("discount")) discounts.push(fin.discountAmount);
    if (accessor.has("quantity")) quantities.push(fin.quantity);
  }

  const totalOrders = hasOrderId ? completedOrderIds.size + aggregatedOrdersCount : null;
  const totalRevenue = hasRevenueSource ? safeSum(revenues) : null;
  const unitsSold = accessor.has("quantity") ? safeSum(quantities) : null;
  const hasProfitSource = accessor.has("profit") || (hasRevenueSource && accessor.has("cost"));
  const grossProfit = hasProfitSource && profits.length > 0 ? safeSum(profits) : (hasProfitSource && completedRows.length === 0 ? 0 : null);
  const totalDiscounts = accessor.has("discount") ? safeSum(discounts) : null;

  return {
    completedRows,
    totalOrders,
    totalAllOrders: allOrderIds.size,
    totalRevenue,
    unitsSold,
    grossProfit,
    grossProfitMargin: totalRevenue !== null && grossProfit !== null ? safePercent(grossProfit, totalRevenue) : null,
    averageOrderValue: hasOrderId && totalRevenue !== null && totalOrders !== null ? safeDivide(totalRevenue, totalOrders) : null,
    averageSellingPrice: totalRevenue !== null && unitsSold !== null ? safeDivide(totalRevenue, unitsSold) : null,
    totalDiscounts,
    cancellationRate: hasOrderId && accessor.has("status") ? safePercent(cancelledOrderIds.size, allOrderIds.size) : null,
    returnRate: hasOrderId && accessor.has("status") ? safePercent(returnedOrderIds.size, allOrderIds.size) : null,
    activeCustomerIds,
    usedDerivedUnitPriceRevenue,
    deduplicatedOrderHeaderLines
  };
}

function calculateSalesDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, periodRows, comparisonRows, allRows, period } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  const curr = summarizeSalesSlice(periodRows, accessor);
  const comp = comparisonRows.length ? summarizeSalesSlice(comparisonRows, accessor) : null;

  if (curr.usedDerivedUnitPriceRevenue) {
    addMetricWarning(
      metricWarnings,
      "totalRevenue",
      "Derived from Unit Price × Quantity because no explicit total revenue column was mapped."
    );
  }
  if (curr.deduplicatedOrderHeaderLines > 0) {
    domainWarnings.push(`Deduplicated order-level total across ${curr.deduplicatedOrderHeaderLines} multi-line order row(s) to prevent double-counting.`);
  }
  if (!accessor.has("orderId")) {
    domainWarnings.push("No reliable Order ID column was mapped: independent sales totals are computed, while order-level metrics (Total Orders, AOV, Cancellation/Return Rates, Repeat Rate, CLV) remain unavailable.");
  }

  // Repeat Customer Rate & CLV Estimate require historical completed orders by customerId AND orderId
  let repeatCustomerRate: number | null = null;
  let clvEstimate: number | null = null;
  let compRepeatRate: number | null = null;

  if (accessor.has("customerId") && accessor.has("orderId")) {
    const customerOrdersUpToEnd = new Map<string, Set<string>>();
    const customerRevenueUpToEnd = new Map<string, number[]>();
    const historyDates = new Set<string>();

    for (const row of allRows) {
      const dateKey = accessor.dateKey(row, "transactionDate");
      if (!dateKey || dateKey > period.end) continue;
      if (accessor.has("status") && classifySalesStatus(accessor.str(row, "status")) !== "completed") continue;
      const custId = accessor.str(row, "customerId");
      const orderId = accessor.str(row, "orderId");
      if (!custId || !orderId) continue;
      historyDates.add(dateKey);
      const set = customerOrdersUpToEnd.get(custId) || new Set<string>();
      set.add(orderId);
      customerOrdersUpToEnd.set(custId, set);
      const fin = computeSalesRowFinancials(row, accessor);
      if (fin.revenue !== null) {
        const revList = customerRevenueUpToEnd.get(custId) || [];
        revList.push(fin.revenue);
        customerRevenueUpToEnd.set(custId, revList);
      }
    }

    if (curr.activeCustomerIds.size > 0) {
      let repeatCount = 0;
      for (const custId of curr.activeCustomerIds) {
        if ((customerOrdersUpToEnd.get(custId)?.size || 0) >= 2) repeatCount += 1;
      }
      repeatCustomerRate = safePercent(repeatCount, curr.activeCustomerIds.size);
      if (historyDates.size < 2) {
        addMetricWarning(metricWarnings, "repeatCustomerRate", "Only one day of purchase history is available; repeat rate may be understated.");
      }
    } else {
      unavailableOverrides.repeatCustomerRate = {
        status: "insufficient_data",
        reason: "No completed orders with identifiable customers in the reporting period."
      };
    }

    if (accessor.has("revenue")) {
      const totalUniqueCustomers = customerRevenueUpToEnd.size;
      if (totalUniqueCustomers > 0 && historyDates.size >= 2) {
        const perCustomerTotals = [...customerRevenueUpToEnd.values()].map(list => safeSum(list));
        clvEstimate = safeDivide(safeSum(perCustomerTotals), totalUniqueCustomers);
        addMetricWarning(metricWarnings, "customerLifetimeValueEstimate", "Estimated from cumulative observed customer revenue across available transaction history.");
      } else {
        unavailableOverrides.customerLifetimeValueEstimate = {
          status: "insufficient_data",
          reason: "Customer Lifetime Value estimate requires identifiable customers and multi-day transaction history."
        };
      }
    }

    if (comp && comp.activeCustomerIds.size > 0 && input.comparison) {
      const compCustOrders = new Map<string, Set<string>>();
      for (const row of allRows) {
        const dateKey = accessor.dateKey(row, "transactionDate");
        if (!dateKey || dateKey > input.comparison.end) continue;
        if (accessor.has("status") && classifySalesStatus(accessor.str(row, "status")) !== "completed") continue;
        const custId = accessor.str(row, "customerId");
        const orderId = accessor.str(row, "orderId");
        if (!custId || !orderId) continue;
        const set = compCustOrders.get(custId) || new Set<string>();
        set.add(orderId);
        compCustOrders.set(custId, set);
      }
      let compRepeats = 0;
      for (const custId of comp.activeCustomerIds) {
        if ((compCustOrders.get(custId)?.size || 0) >= 2) compRepeats += 1;
      }
      compRepeatRate = safePercent(compRepeats, comp.activeCustomerIds.size);
    }
  }

  // Time series
  const byDate = groupRowsByDate(periodRows, accessor, "transactionDate");
  const timeSeries: TimeSeriesPoint[] = enumerateDates(period.start, period.end).map(date => {
    const dayRows = byDate.get(date) || [];
    const s = summarizeSalesSlice(dayRows, accessor);
    return {
      date,
      recordCount: dayRows.length,
      metrics: {
        totalRevenue: s.totalRevenue,
        totalOrders: s.totalOrders,
        unitsSold: s.unitsSold,
        grossProfit: s.grossProfit,
        averageOrderValue: s.averageOrderValue
      }
    };
  });

  // Dimension breakdowns: Product, Category, Region, Channel
  const breakdowns: DimensionBreakdown[] = [];
  const salesDimensions: Array<[string, string, string]> = [
    ["product", "Product Performance", "product"],
    ["category", "Category Performance", "category"],
    ["region", "Region / Branch Performance", "region"],
    ["channel", "Sales Channel Performance", "channel"]
  ];

  const hasRevenueSource = accessor.has("revenue") || (accessor.has("unitPrice") && accessor.has("quantity"));
  for (const [role, label, dimId] of salesDimensions) {
    if (!accessor.has(role)) continue;
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of curr.completedRows) {
      const key = accessor.str(row, role);
      if (!key) continue;
      const list = grouped.get(key) || [];
      list.push(row);
      grouped.set(key, list);
    }
    const primaryMetricId = hasRevenueSource
      ? "totalRevenue"
      : accessor.has("quantity")
        ? "unitsSold"
        : "totalOrders";
    const items = [...grouped.entries()].map(([groupLabel, rows]) => {
      const s = summarizeSalesSlice(rows, accessor);
      const primaryValue = primaryMetricId === "totalRevenue"
        ? (s.totalRevenue ?? 0)
        : primaryMetricId === "unitsSold"
          ? (s.unitsSold ?? 0)
          : (s.totalOrders ?? rows.length);
      return {
        label: groupLabel,
        primaryValue,
        recordCount: rows.length,
        metrics: {
          totalRevenue: s.totalRevenue,
          totalOrders: s.totalOrders,
          unitsSold: s.unitsSold,
          grossProfit: s.grossProfit
        }
      };
    });
    const built = buildBreakdown(dimId, label, accessor.column(role)!, primaryMetricId, items);
    if (built) breakdowns.push(built);
  }

  return {
    values: {
      totalRevenue: curr.totalRevenue,
      totalOrders: curr.totalOrders,
      unitsSold: curr.unitsSold,
      grossProfit: curr.grossProfit,
      grossProfitMargin: curr.grossProfitMargin,
      averageOrderValue: curr.averageOrderValue,
      averageSellingPrice: curr.averageSellingPrice,
      totalDiscounts: curr.totalDiscounts,
      cancellationRate: curr.cancellationRate,
      returnRate: curr.returnRate,
      repeatCustomerRate,
      customerLifetimeValueEstimate: clvEstimate
    },
    comparisonValues: comp
      ? {
          totalRevenue: comp.totalRevenue,
          totalOrders: comp.totalOrders,
          unitsSold: comp.unitsSold,
          grossProfit: comp.grossProfit,
          grossProfitMargin: comp.grossProfitMargin,
          averageOrderValue: comp.averageOrderValue,
          averageSellingPrice: comp.averageSellingPrice,
          totalDiscounts: comp.totalDiscounts,
          cancellationRate: comp.cancellationRate,
          returnRate: comp.returnRate,
          repeatCustomerRate: compRepeatRate,
          customerLifetimeValueEstimate: null
        }
      : {},
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings
  };
}

/* ============================================================================
 * 2. INVENTORY & SUPPLY CHAIN
 * ============================================================================ */

type DeduplicatedStockPosition = {
  key: string;
  skuId: string;
  productLabel: string;
  warehouse: string;
  supplier: string | null;
  latestDate: string;
  stockOnHand: number;
  reorderPoint: number | null;
  unitCost: number | null;
  leadTimeDays: number | null;
};

function deduplicateInventorySnapshots(
  rows: Array<Record<string, unknown>>,
  accessor: RoleAccessor,
  upToDate: string
): { positions: DeduplicatedStockPosition[]; snapshotDates: Set<string>; duplicateSnapshotCount: number } {
  const latestByKey = new Map<string, DeduplicatedStockPosition>();
  const snapshotDates = new Set<string>();
  let snapshotRows = 0;

  for (const row of rows) {
    const dateKey = accessor.dateKey(row, "recordedDate");
    if (!dateKey || dateKey > upToDate) continue;
    const skuId = accessor.str(row, "skuId");
    const stock = accessor.num(row, "stockOnHand");
    if (!skuId || stock === null) continue;

    // Distinguish pure movement transactions from stock snapshots
    const moveType = accessor.str(row, "movementType")?.toLowerCase();
    if (moveType && ["in", "out", "inbound", "outbound", "received", "shipped", "sale", "adjustment"].includes(moveType)) {
      continue;
    }

    snapshotRows += 1;
    snapshotDates.add(dateKey);
    const warehouse = accessor.str(row, "warehouse") || "Default";
    const key = `${skuId}::${warehouse}`;
    const existing = latestByKey.get(key);
    if (!existing || dateKey >= existing.latestDate) {
      latestByKey.set(key, {
        key,
        skuId,
        productLabel: accessor.str(row, "product") || skuId,
        warehouse,
        supplier: accessor.str(row, "supplier"),
        latestDate: dateKey,
        stockOnHand: stock,
        reorderPoint: accessor.num(row, "reorderPoint"),
        unitCost: accessor.num(row, "unitCost"),
        leadTimeDays: accessor.num(row, "leadTimeDays")
      });
    }
  }

  return {
    positions: [...latestByKey.values()],
    snapshotDates,
    duplicateSnapshotCount: Math.max(0, snapshotRows - latestByKey.size)
  };
}

function computeInventoryMovements(
  rows: Array<Record<string, unknown>>,
  accessor: RoleAccessor
) {
  let received = 0;
  let shipped = 0;
  let sold = 0;
  let movementRecords = 0;
  const outboundBySku = new Map<string, number>();

  for (const row of rows) {
    const skuId = accessor.str(row, "skuId");
    if (!skuId) continue;

    const qtyRec = accessor.has("quantityReceived") ? accessor.num(row, "quantityReceived") : null;
    const qtyShip = accessor.has("quantityShipped") ? accessor.num(row, "quantityShipped") : null;
    const qtySold = accessor.has("quantitySold") ? accessor.num(row, "quantitySold") : null;
    const moveType = accessor.str(row, "movementType")?.toLowerCase();

    if (qtyRec !== null) {
      received += qtyRec;
      movementRecords += 1;
    }
    if (qtyShip !== null) {
      shipped += qtyShip;
      movementRecords += 1;
      outboundBySku.set(skuId, (outboundBySku.get(skuId) || 0) + Math.max(0, qtyShip));
    }
    if (qtySold !== null) {
      sold += qtySold;
      movementRecords += 1;
      outboundBySku.set(skuId, (outboundBySku.get(skuId) || 0) + Math.max(0, qtySold));
    }

    if (moveType && qtyRec === null && qtyShip === null && accessor.has("stockOnHand")) {
      const qty = Math.abs(accessor.num(row, "stockOnHand") ?? 0);
      if (["in", "inbound", "received", "return"].includes(moveType)) {
        received += qty;
        movementRecords += 1;
      } else if (["out", "outbound", "shipped", "sale"].includes(moveType)) {
        shipped += qty;
        movementRecords += 1;
        outboundBySku.set(skuId, (outboundBySku.get(skuId) || 0) + qty);
      }
    }
  }

  const totalDemand = accessor.has("quantitySold") ? sold : shipped;
  return {
    received: safeRound(received, 2),
    shipped: safeRound(shipped, 2),
    netMovement: movementRecords > 0 ? safeRound(received - shipped, 2) : null,
    totalDemand: safeRound(totalDemand, 2),
    outboundBySku,
    movementRecords
  };
}

function calculateInventoryDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, allRows, periodRows, comparisonRows, period, comparison } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  const snapshot = accessor.has("stockOnHand")
    ? deduplicateInventorySnapshots(allRows, accessor, period.end)
    : { positions: [], snapshotDates: new Set<string>(), duplicateSnapshotCount: 0 };

  if (snapshot.duplicateSnapshotCount > 0) {
    domainWarnings.push(`Deduplicated ${snapshot.duplicateSnapshotCount} historical snapshot row(s) by latest date per SKU and warehouse to avoid double-counting stock.`);
  }

  const availableStock = accessor.has("stockOnHand") && snapshot.positions.length > 0
    ? safeSum(snapshot.positions.map(p => p.stockOnHand))
    : null;

  if (accessor.has("stockOnHand") && snapshot.positions.length === 0) {
    unavailableOverrides.availableStock = {
      status: "insufficient_data",
      reason: "No inventory snapshot records found on or before the reporting period end."
    };
  }

  const movements = computeInventoryMovements(periodRows, accessor);
  const compMovements = comparisonRows.length ? computeInventoryMovements(comparisonRows, accessor) : null;
  const compSnapshot = comparison && accessor.has("stockOnHand")
    ? deduplicateInventorySnapshots(allRows, accessor, comparison.end)
    : null;

  // Stock Turnover requires historical average stock (>= 2 snapshot dates) AND outbound/sold demand
  let stockTurnover: number | null = null;
  if (accessor.has("stockOnHand") && (accessor.has("quantitySold") || accessor.has("quantityShipped"))) {
    if (snapshot.snapshotDates.size < 2) {
      unavailableOverrides.stockTurnover = {
        status: "insufficient_data",
        reason: "Stock Turnover requires multiple historical inventory snapshots; cannot calculate turnover from a single current stock snapshot alone."
      };
    } else {
      // Average total stock across observed snapshot dates
      const stockByDate = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        const d = accessor.dateKey(row, "recordedDate");
        const sku = accessor.str(row, "skuId");
        const qty = accessor.num(row, "stockOnHand");
        if (!d || d > period.end || !sku || qty === null) continue;
        const wh = accessor.str(row, "warehouse") || "Default";
        const dateMap = stockByDate.get(d) || new Map<string, number>();
        dateMap.set(`${sku}::${wh}`, qty);
        stockByDate.set(d, dateMap);
      }
      const dailyTotals = [...stockByDate.values()].map(m => safeSum([...m.values()]));
      const avgInventory = safeDivide(safeSum(dailyTotals), dailyTotals.length);
      if (avgInventory && avgInventory > 0) {
        stockTurnover = safeDivide(movements.totalDemand, avgInventory);
      } else {
        unavailableOverrides.stockTurnover = {
          status: "insufficient_data",
          reason: "Average inventory is zero; stock turnover cannot be calculated."
        };
      }
    }
  }

  // Days of Inventory requires positive available stock AND positive historical average daily demand
  let daysOfInventory: number | null = null;
  if (accessor.has("stockOnHand") && (accessor.has("quantitySold") || accessor.has("quantityShipped"))) {
    const avgDailyDemand = safeDivide(movements.totalDemand, period.dayCount, 4);
    if (availableStock !== null && availableStock > 0 && avgDailyDemand !== null && avgDailyDemand > 0) {
      daysOfInventory = safeDivide(availableStock, avgDailyDemand, 1);
    } else {
      unavailableOverrides.daysOfInventory = {
        status: "insufficient_data",
        reason: "Days of Inventory requires positive available stock and positive average daily demand."
      };
    }
  }

  // Reorder Alerts & Stockout Risk
  let reorderAlerts: number | null = null;
  let stockoutRisk: number | null = null;
  const reorderItems: Array<{ skuId: string; product: string; warehouse: string; stockOnHand: number; reorderPoint: number }> = [];

  if (snapshot.positions.length > 0) {
    let atRisk = 0;
    for (const pos of snapshot.positions) {
      const belowReorder = pos.reorderPoint !== null && pos.stockOnHand <= pos.reorderPoint;
      if (pos.stockOnHand <= 0 || belowReorder) atRisk += 1;
      if (belowReorder) {
        reorderItems.push({
          skuId: pos.skuId,
          product: pos.productLabel,
          warehouse: pos.warehouse,
          stockOnHand: pos.stockOnHand,
          reorderPoint: pos.reorderPoint!
        });
      }
    }
    stockoutRisk = safePercent(atRisk, snapshot.positions.length);
    if (accessor.has("reorderPoint")) {
      reorderAlerts = reorderItems.length;
    }
  }

  // Slow-moving products: SKUs with positive stock and zero/minimal outbound movement
  let slowMovingProducts: number | null = null;
  const slowMovingSkus: string[] = [];
  if (snapshot.positions.length > 0 && (accessor.has("quantitySold") || accessor.has("quantityShipped"))) {
    const stockBySku = new Map<string, number>();
    for (const pos of snapshot.positions) {
      stockBySku.set(pos.skuId, (stockBySku.get(pos.skuId) || 0) + pos.stockOnHand);
    }
    for (const [skuId, stock] of stockBySku.entries()) {
      if (stock <= 0) continue;
      const demand = movements.outboundBySku.get(skuId) || 0;
      if (demand === 0 || demand / stock < 0.05) {
        slowMovingSkus.push(skuId);
      }
    }
    slowMovingProducts = slowMovingSkus.length;
  }

  // Time series
  const byDate = groupRowsByDate(periodRows, accessor, "recordedDate");
  const timeSeries: TimeSeriesPoint[] = enumerateDates(period.start, period.end).map(date => {
    const dayRows = byDate.get(date) || [];
    const dayMove = computeInventoryMovements(dayRows, accessor);
    return {
      date,
      recordCount: dayRows.length,
      metrics: {
        stockMovement: dayMove.netMovement,
        outboundDemand: dayMove.totalDemand
      }
    };
  });

  // Warehouse & Supplier Performance breakdowns
  const breakdowns: DimensionBreakdown[] = [];
  if (accessor.has("warehouse") && snapshot.positions.length > 0) {
    const byWh = new Map<string, DeduplicatedStockPosition[]>();
    for (const pos of snapshot.positions) {
      const list = byWh.get(pos.warehouse) || [];
      list.push(pos);
      byWh.set(pos.warehouse, list);
    }
    const items = [...byWh.entries()].map(([wh, list]) => {
      const total = safeSum(list.map(p => p.stockOnHand));
      const alerts = list.filter(p => p.reorderPoint !== null && p.stockOnHand <= p.reorderPoint).length;
      return {
        label: wh,
        primaryValue: total,
        recordCount: list.length,
        metrics: { availableStock: total, skuCount: list.length, reorderAlerts: accessor.has("reorderPoint") ? alerts : null }
      };
    });
    const built = buildBreakdown("warehouse", "Warehouse Performance", accessor.column("warehouse")!, "availableStock", items);
    if (built) breakdowns.push(built);
  }

  if (accessor.has("supplier") && snapshot.positions.length > 0) {
    const bySup = new Map<string, DeduplicatedStockPosition[]>();
    for (const pos of snapshot.positions) {
      if (!pos.supplier) continue;
      const list = bySup.get(pos.supplier) || [];
      list.push(pos);
      bySup.set(pos.supplier, list);
    }
    const items = [...bySup.entries()].map(([sup, list]) => {
      const total = safeSum(list.map(p => p.stockOnHand));
      const leadTimes = list.map(p => p.leadTimeDays).filter((v): v is number => v !== null);
      const avgLead = leadTimes.length ? safeDivide(safeSum(leadTimes), leadTimes.length) : null;
      return {
        label: sup,
        primaryValue: total,
        recordCount: list.length,
        metrics: { availableStock: total, skuCount: list.length, averageLeadTimeDays: avgLead }
      };
    });
    const built = buildBreakdown("supplier", "Supplier Performance", accessor.column("supplier")!, "availableStock", items);
    if (built) breakdowns.push(built);
  }

  return {
    values: {
      availableStock,
      stockMovement: movements.netMovement,
      stockTurnover,
      daysOfInventory,
      stockoutRisk,
      reorderAlerts,
      slowMovingProducts
    },
    comparisonValues: {
      availableStock: compSnapshot && compSnapshot.positions.length > 0 ? safeSum(compSnapshot.positions.map(p => p.stockOnHand)) : null,
      stockMovement: compMovements ? compMovements.netMovement : null
    },
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings,
    domainSpecificData: {
      deduplicatedPositionCount: snapshot.positions.length,
      reorderAlertItems: reorderItems.slice(0, 20),
      slowMovingSkus: slowMovingSkus.slice(0, 20)
    }
  };
}

/* ============================================================================
 * 3. MARKETING & CAMPAIGNS
 * ============================================================================ */

function summarizeMarketingSlice(rows: Array<Record<string, unknown>>, accessor: RoleAccessor) {
  const spendVals: number[] = [];
  const impVals: number[] = [];
  const clickVals: number[] = [];
  const leadVals: number[] = [];
  const convVals: number[] = [];
  const revVals: number[] = [];

  for (const row of rows) {
    if (accessor.has("spend")) {
      const v = accessor.num(row, "spend");
      if (v !== null) spendVals.push(v);
    }
    if (accessor.has("impressions")) {
      const v = accessor.num(row, "impressions");
      if (v !== null) impVals.push(v);
    }
    if (accessor.has("clicks")) {
      const v = accessor.num(row, "clicks");
      if (v !== null) clickVals.push(v);
    }
    if (accessor.has("leads")) {
      const v = accessor.num(row, "leads");
      if (v !== null) leadVals.push(v);
    }
    if (accessor.has("conversions")) {
      const v = accessor.num(row, "conversions");
      if (v !== null) convVals.push(v);
    }
    if (accessor.has("attributedRevenue")) {
      const v = accessor.num(row, "attributedRevenue");
      if (v !== null) revVals.push(v);
    }
  }

  const campaignSpend = accessor.has("spend") ? safeSum(spendVals) : null;
  const impressions = accessor.has("impressions") ? safeSum(impVals) : null;
  const clicks = accessor.has("clicks") ? safeSum(clickVals) : null;
  const leads = accessor.has("leads") ? safeSum(leadVals) : null;
  const conversions = accessor.has("conversions") ? safeSum(convVals) : null;
  const attributedRevenue = accessor.has("attributedRevenue") ? safeSum(revVals) : null;

  return {
    campaignSpend,
    impressions,
    clicks,
    leads,
    conversions,
    clickThroughRate: safePercent(clicks, impressions), // Clicks / Impressions * 100
    costPerClick: safeDivide(campaignSpend, clicks), // Spend / Clicks
    conversionRate: safePercent(conversions, clicks), // Conversions / Clicks * 100
    costPerAcquisition: safeDivide(campaignSpend, conversions), // Spend / Conversions
    attributedRevenue,
    returnOnAdSpend: safeDivide(attributedRevenue, campaignSpend) // Attributed Revenue / Spend
  };
}

function calculateMarketingDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, periodRows, comparisonRows, period } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  const curr = summarizeMarketingSlice(periodRows, accessor);
  const comp = comparisonRows.length ? summarizeMarketingSlice(comparisonRows, accessor) : null;

  if (accessor.has("attributedRevenue") && accessor.has("spend")) {
    addMetricWarning(metricWarnings, "returnOnAdSpend", "ROAS measures gross attributed revenue per unit of ad spend; it does not deduct product costs or represent profit/ROI.");
  }

  const byDate = groupRowsByDate(periodRows, accessor, "campaignDate");
  const timeSeries: TimeSeriesPoint[] = enumerateDates(period.start, period.end).map(date => {
    const dayRows = byDate.get(date) || [];
    const s = summarizeMarketingSlice(dayRows, accessor);
    return {
      date,
      recordCount: dayRows.length,
      metrics: {
        campaignSpend: s.campaignSpend,
        impressions: s.impressions,
        clicks: s.clicks,
        conversions: s.conversions,
        attributedRevenue: s.attributedRevenue,
        returnOnAdSpend: s.returnOnAdSpend
      }
    };
  });

  const breakdowns: DimensionBreakdown[] = [];
  const marketingDims: Array<[string, string, string]> = [
    ["campaignName", "Campaign Performance", "campaign"],
    ["channel", "Channel Performance", "channel"]
  ];

  // Fallback to campaignId if campaignName is absent
  if (!accessor.has("campaignName") && accessor.has("campaignId")) {
    marketingDims[0] = ["campaignId", "Campaign Performance", "campaign"];
  }

  for (const [role, label, dimId] of marketingDims) {
    if (!accessor.has(role)) continue;
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of periodRows) {
      const key = accessor.str(row, role);
      if (!key) continue;
      const list = grouped.get(key) || [];
      list.push(row);
      grouped.set(key, list);
    }
    const primaryMetricId = accessor.has("attributedRevenue") ? "attributedRevenue" : accessor.has("spend") ? "campaignSpend" : "clicks";
    const items = [...grouped.entries()].map(([groupLabel, rows]) => {
      const s = summarizeMarketingSlice(rows, accessor);
      const primaryValue = primaryMetricId === "attributedRevenue"
        ? (s.attributedRevenue ?? 0)
        : primaryMetricId === "campaignSpend"
          ? (s.campaignSpend ?? 0)
          : (s.clicks ?? 0);
      return {
        label: groupLabel,
        primaryValue,
        recordCount: rows.length,
        metrics: {
          campaignSpend: s.campaignSpend,
          clicks: s.clicks,
          conversions: s.conversions,
          clickThroughRate: s.clickThroughRate,
          returnOnAdSpend: s.returnOnAdSpend
        }
      };
    });
    const built = buildBreakdown(dimId, label, accessor.column(role)!, primaryMetricId, items);
    if (built) breakdowns.push(built);
  }

  return {
    values: curr,
    comparisonValues: comp || {},
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings
  };
}

/* ============================================================================
 * 4. FINANCE & EXPENSES
 * ============================================================================ */

const FINANCE_INCOME_TYPES = new Set(["income", "credit", "inflow", "revenue", "receivable", "receipt", "deposit"]);
const FINANCE_EXPENSE_TYPES = new Set(["expense", "debit", "outflow", "payable", "cost", "disbursement", "bill", "payout"]);
const FINANCE_SETTLED_STATUSES = new Set(["paid", "settled", "cleared", "posted", "reimbursed", "completed", "complete"]);
const FINANCE_UNPAID_STATUSES = new Set(["pending", "unpaid", "open", "overdue", "sent", "billed", "approved", "due"]);
const NON_OPERATING_CATEGORY_TOKENS = ["tax", "interest", "depreciation", "amortization", "capex", "capital", "dividend", "loan", "financing"];

function summarizeFinanceSlice(
  rows: Array<Record<string, unknown>>,
  accessor: RoleAccessor,
  referenceDate: string
) {
  const incomes: number[] = [];
  const expenses: number[] = [];
  const opEx: number[] = [];
  const cashInflows: number[] = [];
  const cashOutflows: number[] = [];
  const budgets: number[] = [];
  const taxes: number[] = [];
  const overdueRec: number[] = [];
  const overduePay: number[] = [];

  let hasAnyIncomeRow = false;
  let hasAnyExpenseRow = false;

  const hasExplicitIncome = accessor.has("incomeAmount");
  const hasExplicitExpense = accessor.has("expenseAmount");
  const hasType = accessor.has("transactionType");
  const hasAmount = accessor.has("amount");
  const hasStatus = accessor.has("status");

  for (const row of rows) {
    const status = hasStatus ? accessor.str(row, "status")?.toLowerCase() || "" : "";
    const isVoid = status === "void" || status === "cancelled" || status === "canceled" || status === "rejected";
    if (isVoid) continue;

    const isSettled = !hasStatus || FINANCE_SETTLED_STATUSES.has(status);
    const isUnpaid = hasStatus && FINANCE_UNPAID_STATUSES.has(status);
    const dueDate = accessor.has("dueDate") ? accessor.dateKey(row, "dueDate") : null;
    const isOverdue = Boolean(isUnpaid && dueDate && dueDate < referenceDate);

    let rowIncome = 0;
    let rowExpense = 0;

    if (hasExplicitIncome) {
      const v = accessor.num(row, "incomeAmount");
      if (v !== null && v > 0) {
        rowIncome = v;
        hasAnyIncomeRow = true;
      }
    }
    if (hasExplicitExpense) {
      const v = accessor.num(row, "expenseAmount");
      if (v !== null && v > 0) {
        rowExpense = v;
        hasAnyExpenseRow = true;
      }
    }

    if (!hasExplicitIncome && !hasExplicitExpense && hasAmount) {
      const amt = accessor.num(row, "amount");
      if (amt !== null) {
        if (hasType) {
          const typeVal = (accessor.str(row, "transactionType") || "").toLowerCase();
          if (FINANCE_INCOME_TYPES.has(typeVal)) {
            rowIncome = Math.abs(amt);
            hasAnyIncomeRow = true;
          } else if (FINANCE_EXPENSE_TYPES.has(typeVal)) {
            rowExpense = Math.abs(amt);
            hasAnyExpenseRow = true;
          }
        } else {
          // Single-direction expense ledger without transactionType
          rowExpense = Math.abs(amt);
          hasAnyExpenseRow = true;
        }
      }
    }

    if (rowIncome > 0) {
      incomes.push(rowIncome);
      if (isSettled) cashInflows.push(rowIncome);
      if (isOverdue) overdueRec.push(rowIncome);
    }

    if (rowExpense > 0) {
      expenses.push(rowExpense);
      if (isSettled) cashOutflows.push(rowExpense);
      if (isOverdue) overduePay.push(rowExpense);

      if (accessor.has("operatingExpense")) {
        const opVal = accessor.num(row, "operatingExpense");
        if (opVal !== null) opEx.push(opVal);
      } else if (accessor.has("expenseCategory")) {
        const cat = (accessor.str(row, "expenseCategory") || "").toLowerCase();
        const isNonOp = NON_OPERATING_CATEGORY_TOKENS.some(tok => cat.includes(tok));
        if (!isNonOp) opEx.push(rowExpense);
      }
    } else if (accessor.has("operatingExpense")) {
      const opVal = accessor.num(row, "operatingExpense");
      if (opVal !== null && opVal > 0) opEx.push(opVal);
    }

    if (accessor.has("budgetAmount")) {
      const b = accessor.num(row, "budgetAmount");
      if (b !== null) budgets.push(b);
    }
    if (accessor.has("taxAmount")) {
      const t = accessor.num(row, "taxAmount");
      if (t !== null) taxes.push(t);
    }
  }

  const canComputeIncome = hasExplicitIncome || (hasAmount && hasType);
  const canComputeExpenses = hasExplicitExpense || hasAmount;
  const canComputeBoth = (hasExplicitIncome && hasExplicitExpense) || (hasAmount && hasType);

  const totalIncome = canComputeIncome ? safeSum(incomes) : null;
  const totalExpenses = canComputeExpenses ? safeSum(expenses) : null;
  const operatingExpenses = (accessor.has("operatingExpense") || (canComputeExpenses && accessor.has("expenseCategory")))
    ? safeSum(opEx)
    : null;
  const cashInflow = canComputeIncome ? safeSum(cashInflows) : null;
  const cashOutflow = canComputeExpenses ? safeSum(cashOutflows) : null;
  const netCashFlow = canComputeBoth && cashInflow !== null && cashOutflow !== null
    ? safeRound(cashInflow - cashOutflow, 2)
    : null;
  const totalBudget = accessor.has("budgetAmount") ? safeSum(budgets) : null;
  const budgetVariance = totalBudget !== null && totalExpenses !== null
    ? safeRound(totalBudget - totalExpenses, 2)
    : null;
  const totalTax = accessor.has("taxAmount") ? safeSum(taxes) : 0;

  // Net Income ONLY when accounting dataset actually contains both income and expense sides
  const netIncome = canComputeBoth && hasAnyIncomeRow && hasAnyExpenseRow && totalIncome !== null && totalExpenses !== null
    ? safeRound(totalIncome - totalExpenses - totalTax, 2)
    : null;

  return {
    totalIncome,
    totalExpenses,
    operatingExpenses,
    cashInflow,
    cashOutflow,
    netCashFlow,
    budgetVariance,
    overdueReceivables: canComputeIncome && accessor.has("dueDate") && hasStatus ? safeSum(overdueRec) : null,
    overduePayables: canComputeExpenses && accessor.has("dueDate") && hasStatus ? safeSum(overduePay) : null,
    netIncome,
    hasAnyIncomeRow,
    hasAnyExpenseRow
  };
}

function calculateFinanceDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, periodRows, comparisonRows, period, comparison } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  const curr = summarizeFinanceSlice(periodRows, accessor, period.end);
  const comp = comparisonRows.length && comparison
    ? summarizeFinanceSlice(comparisonRows, accessor, comparison.end)
    : null;

  if (!accessor.has("status")) {
    const note = "No payment settlement status column mapped; cash inflow/outflow reflects booked transactions (accrual basis).";
    addMetricWarning(metricWarnings, "cashInflow", note);
    addMetricWarning(metricWarnings, "cashOutflow", note);
    addMetricWarning(metricWarnings, "netCashFlow", note);
  }

  if (curr.netIncome === null && (accessor.has("incomeAmount") || accessor.has("expenseAmount") || accessor.has("amount"))) {
    unavailableOverrides.netIncome = {
      status: "insufficient_data",
      reason: "Net Income requires both recognized income and expense accounting records; it is never computed from revenue or expenses alone."
    };
  }

  // Expense Growth requires non-zero comparison period expenses
  let expenseGrowth: number | null = null;
  if (curr.totalExpenses !== null && comp && comp.totalExpenses !== null && comparison) {
    const currDailyExp = curr.totalExpenses / period.dayCount;
    const compDailyExp = comp.totalExpenses / comparison.dayCount;
    expenseGrowth = safeChangePercent(currDailyExp, compDailyExp);
    if (expenseGrowth === null) {
      unavailableOverrides.expenseGrowth = {
        status: "insufficient_data",
        reason: "Comparison period has zero expenses; expense growth percentage is undefined."
      };
    }
  } else if (curr.totalExpenses !== null) {
    unavailableOverrides.expenseGrowth = {
      status: "insufficient_data",
      reason: "Expense Growth requires comparison period expense history."
    };
  }

  const byDate = groupRowsByDate(periodRows, accessor, "transactionDate");
  const timeSeries: TimeSeriesPoint[] = enumerateDates(period.start, period.end).map(date => {
    const dayRows = byDate.get(date) || [];
    const s = summarizeFinanceSlice(dayRows, accessor, date);
    return {
      date,
      recordCount: dayRows.length,
      metrics: {
        totalIncome: s.totalIncome,
        totalExpenses: s.totalExpenses,
        netCashFlow: s.netCashFlow
      }
    };
  });

  const breakdowns: DimensionBreakdown[] = [];
  const financeDims: Array<[string, string, string]> = [
    ["department", "Department-wise Expenses", "department"],
    ["expenseCategory", "Expense Category Breakdown", "expenseCategory"],
    ["vendor", "Vendor Spend Breakdown", "vendor"]
  ];
  for (const [role, label, dimId] of financeDims) {
    if (!accessor.has(role)) continue;
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of periodRows) {
      const key = accessor.str(row, role);
      if (!key) continue;
      const list = grouped.get(key) || [];
      list.push(row);
      grouped.set(key, list);
    }
    const items = [...grouped.entries()].map(([groupLabel, rows]) => {
      const s = summarizeFinanceSlice(rows, accessor, period.end);
      return {
        label: groupLabel,
        primaryValue: s.totalExpenses ?? 0,
        recordCount: rows.length,
        metrics: {
          totalExpenses: s.totalExpenses,
          operatingExpenses: s.operatingExpenses,
          budgetVariance: s.budgetVariance
        }
      };
    }).filter(item => item.primaryValue > 0);
    const built = buildBreakdown(dimId, label, accessor.column(role)!, "totalExpenses", items);
    if (built) breakdowns.push(built);
  }

  return {
    values: {
      totalIncome: curr.totalIncome,
      totalExpenses: curr.totalExpenses,
      operatingExpenses: curr.operatingExpenses,
      cashInflow: curr.cashInflow,
      cashOutflow: curr.cashOutflow,
      netCashFlow: curr.netCashFlow,
      budgetVariance: curr.budgetVariance,
      expenseGrowth,
      overdueReceivables: curr.overdueReceivables,
      overduePayables: curr.overduePayables,
      netIncome: curr.netIncome
    },
    comparisonValues: comp
      ? {
          totalIncome: comp.totalIncome,
          totalExpenses: comp.totalExpenses,
          operatingExpenses: comp.operatingExpenses,
          cashInflow: comp.cashInflow,
          cashOutflow: comp.cashOutflow,
          netCashFlow: comp.netCashFlow,
          budgetVariance: comp.budgetVariance,
          netIncome: comp.netIncome
        }
      : {},
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings
  };
}

/* ============================================================================
 * 5. CUSTOMERS & CRM
 * ============================================================================ */

const CHURNED_STATUS_TOKENS = new Set(["churned", "cancelled", "canceled", "lost", "terminated", "closed lost"]);

function calculateCustomersDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, allRows, periodRows, comparisonRows, period, comparison } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  type CustSummary = {
    firstDate: string;
    lastDate: string;
    dates: Set<string>;
    monetary: number[];
    dealValues: number[];
    churnedConfirmed: boolean;
    segment: string | null;
    region: string | null;
  };

  const customers = new Map<string, CustSummary>();
  const activeInPeriod = new Set<string>();
  const activeInComparison = new Set<string>();
  const compDateSet = comparison?.matchingDates ? new Set(comparison.matchingDates) : null;

  for (const row of allRows) {
    const custId = accessor.str(row, "customerId");
    const actDate = accessor.dateKey(row, "activityDate");
    const lastActDate = accessor.has("lastActivityDate") ? accessor.dateKey(row, "lastActivityDate") : null;
    if (!custId || !actDate) continue;
    if (actDate > period.end && (!lastActDate || lastActDate > period.end)) continue;

    const effectiveLatest = lastActDate && lastActDate <= period.end && lastActDate > actDate ? lastActDate : actDate;
    const existing = customers.get(custId) || {
      firstDate: actDate,
      lastDate: effectiveLatest,
      dates: new Set<string>(),
      monetary: [],
      dealValues: [],
      churnedConfirmed: false,
      segment: null,
      region: null
    };

    if (actDate < existing.firstDate) existing.firstDate = actDate;
    if (effectiveLatest > existing.lastDate) existing.lastDate = effectiveLatest;
    existing.dates.add(actDate);
    if (lastActDate && lastActDate <= period.end) existing.dates.add(lastActDate);

    if (accessor.has("totalSpent")) {
      const m = accessor.num(row, "totalSpent");
      if (m !== null) existing.monetary.push(m);
    }
    if (accessor.has("dealValue")) {
      const d = accessor.num(row, "dealValue");
      if (d !== null) existing.dealValues.push(d);
    }

    // Confirmed churn check ONLY from explicit signals (never missing activity!)
    if (accessor.has("churned")) {
      const colNorm = normalizeName(accessor.column("churned") || "");
      const flag = accessor.bool(row, "churned");
      if (flag !== null) {
        existing.churnedConfirmed = colNorm === "isactive" ? !flag : flag;
      }
    }
    const statusText = (accessor.str(row, "status") || "").toLowerCase();
    const stageText = (accessor.str(row, "lifecycleStage") || "").toLowerCase();
    if (CHURNED_STATUS_TOKENS.has(statusText) || CHURNED_STATUS_TOKENS.has(stageText)) {
      existing.churnedConfirmed = true;
    }

    existing.segment = accessor.str(row, "segment") || existing.segment;
    existing.region = accessor.str(row, "region") || existing.region;
    customers.set(custId, existing);

    const inPeriod = (actDate >= period.start && actDate <= period.end)
      || Boolean(lastActDate && lastActDate >= period.start && lastActDate <= period.end);
    if (inPeriod) activeInPeriod.add(custId);

    if (comparison) {
      const inComp = compDateSet
        ? compDateSet.has(actDate) || Boolean(lastActDate && compDateSet.has(lastActDate))
        : (actDate >= comparison.start && actDate <= comparison.end)
          || Boolean(lastActDate && lastActDate >= comparison.start && lastActDate <= comparison.end);
      if (inComp) activeInComparison.add(custId);
    }
  }

  let newCustomers = 0;
  let repeatCustomers = 0;
  let confirmedChurned = 0;

  for (const [custId, info] of customers.entries()) {
    if (info.firstDate >= period.start && info.firstDate <= period.end) newCustomers += 1;
    if (activeInPeriod.has(custId) && info.dates.size >= 2) repeatCustomers += 1;
    if (info.churnedConfirmed) confirmedChurned += 1;
  }

  // Cohort-based Retention Rate: share of comparison-cohort customers still active in current period
  let customerRetention: number | null = null;
  if (comparison && activeInComparison.size > 0) {
    let retained = 0;
    for (const custId of activeInComparison) {
      if (activeInPeriod.has(custId)) retained += 1;
    }
    customerRetention = safePercent(retained, activeInComparison.size);
  } else {
    unavailableOverrides.customerRetention = {
      status: "insufficient_data",
      reason: "Customer Retention requires a non-empty prior customer cohort in the comparison window."
    };
  }

  // Confirmed Churn Rate (explicit signal required — missing activity is NOT confirmed churn)
  const hasExplicitChurnSignal = accessor.has("churned") || accessor.has("status") || accessor.has("lifecycleStage");
  let customerChurn: number | null = null;
  if (hasExplicitChurnSignal && customers.size > 0) {
    customerChurn = safePercent(confirmedChurned, customers.size);
  } else if (hasExplicitChurnSignal) {
    unavailableOverrides.customerChurn = {
      status: "insufficient_data",
      reason: "No observable customer records available to compute churn rate."
    };
  } else {
    domainWarnings.push("No explicit churn flag or status column is available; missing customer activity is not treated as confirmed churn.");
  }

  // Actual vs Estimated CLV clearly distinguished
  let customerLifetimeValue: number | null = null;
  let clvMethod: "actual" | "estimated" | "unavailable" = "unavailable";
  if (accessor.has("totalSpent") && customers.size > 0) {
    const totals = [...customers.values()].filter(c => c.monetary.length > 0).map(c => safeSum(c.monetary));
    if (totals.length > 0) {
      customerLifetimeValue = safeDivide(safeSum(totals), totals.length);
      clvMethod = "actual";
    }
  } else if (accessor.has("dealValue") && customers.size > 0) {
    const totals = [...customers.values()].filter(c => c.dealValues.length > 0).map(c => safeSum(c.dealValues));
    if (totals.length > 0) {
      customerLifetimeValue = safeDivide(safeSum(totals), totals.length);
      clvMethod = "estimated";
      addMetricWarning(metricWarnings, "customerLifetimeValue", "Estimated CLV derived from CRM deal values (not verified cumulative actual transaction spend).");
    }
  }

  // RFM Analysis (Recency, Frequency, Monetary) when customerId + dates + monetary value exist
  const rfmCounts: Record<string, number> = { Champions: 0, Loyal: 0, Potential: 0, "At Risk": 0, Hibernating: 0 };
  let rfmAvailable = false;
  if ((accessor.has("totalSpent") || accessor.has("dealValue")) && customers.size > 0) {
    const periodEndMs = Date.parse(`${period.end}T00:00:00.000Z`);
    const monetaryValues = [...customers.values()]
      .map(c => safeSum(c.monetary.length ? c.monetary : c.dealValues))
      .filter(v => v > 0);
    const avgMonetary = monetaryValues.length ? safeSum(monetaryValues) / monetaryValues.length : 0;

    if (monetaryValues.length > 0) {
      rfmAvailable = true;
      for (const info of customers.values()) {
        const recencyDays = Math.max(0, Math.round((periodEndMs - Date.parse(`${info.lastDate}T00:00:00.000Z`)) / 86_400_000));
        const frequency = info.dates.size;
        const monetary = safeSum(info.monetary.length ? info.monetary : info.dealValues);

        if (recencyDays <= 14 && frequency >= 2 && monetary >= avgMonetary) rfmCounts.Champions += 1;
        else if (recencyDays <= 30 && frequency >= 2) rfmCounts.Loyal += 1;
        else if (recencyDays <= 30) rfmCounts.Potential += 1;
        else if (recencyDays <= 90) rfmCounts["At Risk"] += 1;
        else rfmCounts.Hibernating += 1;
      }
    }
  }

  // Time series (Customer Activity Trends)
  const byDate = groupRowsByDate(periodRows, accessor, "activityDate");
  const timeSeries: TimeSeriesPoint[] = enumerateDates(period.start, period.end).map(date => {
    const dayRows = byDate.get(date) || [];
    const dayCusts = new Set(dayRows.map(r => accessor.str(r, "customerId")).filter((v): v is string => Boolean(v)));
    let dayNew = 0;
    for (const id of dayCusts) {
      if (customers.get(id)?.firstDate === date) dayNew += 1;
    }
    return {
      date,
      recordCount: dayRows.length,
      metrics: { activeCustomers: dayCusts.size, newCustomers: dayNew }
    };
  });

  // Breakdowns: Segment, Lifecycle Stage, Region
  const breakdowns: DimensionBreakdown[] = [];
  const crmDims: Array<[string, string, string]> = [
    ["segment", "Customer Segmentation", "segment"],
    ["lifecycleStage", "Lifecycle Stage Breakdown", "lifecycleStage"],
    ["region", "Customer Region Breakdown", "region"]
  ];
  for (const [role, label, dimId] of crmDims) {
    if (!accessor.has(role)) continue;
    const grouped = new Map<string, Set<string>>();
    for (const row of periodRows) {
      const key = accessor.str(row, role);
      const custId = accessor.str(row, "customerId");
      if (!key || !custId) continue;
      const set = grouped.get(key) || new Set<string>();
      set.add(custId);
      grouped.set(key, set);
    }
    const items = [...grouped.entries()].map(([groupLabel, ids]) => ({
      label: groupLabel,
      primaryValue: ids.size,
      recordCount: ids.size,
      metrics: { activeCustomers: ids.size }
    }));
    const built = buildBreakdown(dimId, label, accessor.column(role)!, "activeCustomers", items);
    if (built) breakdowns.push(built);
  }

  // Comparison new customers
  let compNewCustomers: number | null = null;
  if (comparison) {
    let count = 0;
    for (const info of customers.values()) {
      if (info.firstDate >= comparison.start && info.firstDate <= comparison.end) count += 1;
    }
    compNewCustomers = count;
  }

  return {
    values: {
      newCustomers,
      activeCustomers: activeInPeriod.size,
      repeatCustomers,
      customerRetention,
      customerChurn,
      customerLifetimeValue
    },
    comparisonValues: comparison
      ? {
          newCustomers: compNewCustomers,
          activeCustomers: activeInComparison.size
        }
      : {},
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings,
    domainSpecificData: {
      clvMethod,
      rfm: rfmAvailable ? { available: true, segments: rfmCounts } : { available: false, reason: "Requires customer IDs, activity dates, and monetary value." }
    }
  };
}

/* ============================================================================
 * 6. OPERATIONS & FULFILLMENT
 * ============================================================================ */

const OPS_DELIVERED = new Set(["delivered", "completed", "complete", "fulfilled", "resolved", "closed"]);
const OPS_CANCELLED = new Set(["cancelled", "canceled", "void", "failed"]);
const OPS_PENDING = new Set(["pending", "open", "processing", "packed", "queued", "in progress", "awaiting dispatch"]);
const OPS_DELAYED = new Set(["delayed", "late", "overdue", "sla breached", "breached"]);

function summarizeOperationsSlice(rows: Array<Record<string, unknown>>, accessor: RoleAccessor) {
  const procHours: number[] = [];
  const delivDays: number[] = [];
  let invalidTimestampCount = 0;

  let totalShipments = 0;
  let deliveredCount = 0;
  let cancelledCount = 0;
  let pendingBacklog = 0;
  let onTimeCount = 0;
  let slaEvaluatedCount = 0;
  let delayedCount = 0;

  for (const row of rows) {
    const id = accessor.str(row, "shipmentId");
    if (!id) continue;
    totalShipments += 1;

    const status = (accessor.str(row, "fulfillmentStatus") || "").toLowerCase();
    const isDelivered = accessor.has("fulfillmentStatus") ? OPS_DELIVERED.has(status) : Boolean(accessor.has("deliveredAt") && accessor.tsMs(row, "deliveredAt") !== null);
    const isCancelled = OPS_CANCELLED.has(status);
    const isPending = OPS_PENDING.has(status);

    if (isDelivered) deliveredCount += 1;
    if (isCancelled) cancelledCount += 1;
    if (isPending) pendingBacklog += 1;

    // Order Processing Time (hours)
    if (accessor.has("processingHours")) {
      const h = accessor.num(row, "processingHours");
      if (h !== null && h >= 0) procHours.push(h);
      else if (h !== null && h < 0) invalidTimestampCount += 1;
    } else if (accessor.has("orderCreatedAt")) {
      const startMs = accessor.tsMs(row, "orderCreatedAt");
      const endMs = accessor.has("packedAt") ? accessor.tsMs(row, "packedAt") : accessor.tsMs(row, "eventDate");
      if (startMs !== null && endMs !== null) {
        if (endMs >= startMs) procHours.push((endMs - startMs) / 3_600_000);
        else invalidTimestampCount += 1;
      }
    }

    // Average Delivery Time (days) — ONLY completed/delivered orders with valid timestamps!
    if (accessor.has("deliveryDays")) {
      const d = accessor.num(row, "deliveryDays");
      if (d !== null && d >= 0 && (!accessor.has("fulfillmentStatus") || isDelivered)) {
        delivDays.push(d);
      } else if (d !== null && d < 0) {
        invalidTimestampCount += 1;
      }
    } else if (accessor.has("deliveredAt")) {
      const delivMs = accessor.tsMs(row, "deliveredAt");
      const startMs = accessor.tsMs(row, "eventDate") ?? accessor.tsMs(row, "orderCreatedAt");
      if (delivMs !== null && startMs !== null && (!accessor.has("fulfillmentStatus") || isDelivered)) {
        if (delivMs >= startMs) delivDays.push((delivMs - startMs) / 86_400_000);
        else invalidTimestampCount += 1;
      }
    }

    // On-time & Delayed Deliveries
    let rowDelayed = false;
    if (accessor.has("slaMet")) {
      const colNorm = normalizeName(accessor.column("slaMet") || "");
      const flag = accessor.bool(row, "slaMet");
      if (flag !== null) {
        const met = colNorm.includes("breach") ? !flag : flag;
        slaEvaluatedCount += 1;
        if (met) onTimeCount += 1;
        else rowDelayed = true;
      }
    } else if (accessor.has("deliveredAt") && accessor.has("promisedDate")) {
      const delivMs = accessor.tsMs(row, "deliveredAt");
      const promMs = accessor.tsMs(row, "promisedDate");
      if (delivMs !== null && promMs !== null) {
        slaEvaluatedCount += 1;
        if (delivMs <= promMs) onTimeCount += 1;
        else rowDelayed = true;
      }
    }

    if (rowDelayed || OPS_DELAYED.has(status)) {
      delayedCount += 1;
    }
  }

  return {
    totalShipments,
    orderProcessingTime: procHours.length ? safeDivide(safeSum(procHours), procHours.length) : null,
    averageDeliveryTime: delivDays.length ? safeDivide(safeSum(delivDays), delivDays.length) : null,
    onTimeDeliveryRate: slaEvaluatedCount > 0 ? safePercent(onTimeCount, slaEvaluatedCount) : null,
    delayedDeliveries: (accessor.has("slaMet") || (accessor.has("deliveredAt") && accessor.has("promisedDate")) || accessor.has("fulfillmentStatus"))
      ? delayedCount
      : null,
    cancellationRate: accessor.has("fulfillmentStatus") ? safePercent(cancelledCount, totalShipments) : null,
    fulfillmentRate: accessor.has("fulfillmentStatus") ? safePercent(deliveredCount, totalShipments) : null,
    pendingOrderBacklog: accessor.has("fulfillmentStatus") ? pendingBacklog : null,
    invalidTimestampCount
  };
}

function calculateOperationsDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, periodRows, comparisonRows, period } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  const curr = summarizeOperationsSlice(periodRows, accessor);
  const comp = comparisonRows.length ? summarizeOperationsSlice(comparisonRows, accessor) : null;

  if (curr.invalidTimestampCount > 0) {
    domainWarnings.push(`Excluded ${curr.invalidTimestampCount} record(s) with negative durations or invalid timestamp sequences.`);
  }

  if (curr.averageDeliveryTime === null && (accessor.has("deliveryDays") || accessor.has("deliveredAt"))) {
    unavailableOverrides.averageDeliveryTime = {
      status: "insufficient_data",
      reason: "No completed deliveries with valid start and delivery timestamps in the reporting period."
    };
  }
  if (curr.orderProcessingTime === null && (accessor.has("processingHours") || accessor.has("orderCreatedAt"))) {
    unavailableOverrides.orderProcessingTime = {
      status: "insufficient_data",
      reason: "No valid order processing timestamp sequences found in the reporting period."
    };
  }

  const byDate = groupRowsByDate(periodRows, accessor, "eventDate");
  const timeSeries: TimeSeriesPoint[] = enumerateDates(period.start, period.end).map(date => {
    const dayRows = byDate.get(date) || [];
    const s = summarizeOperationsSlice(dayRows, accessor);
    return {
      date,
      recordCount: dayRows.length,
      metrics: {
        onTimeDeliveryRate: s.onTimeDeliveryRate,
        fulfillmentRate: s.fulfillmentRate,
        delayedDeliveries: s.delayedDeliveries
      }
    };
  });

  const breakdowns: DimensionBreakdown[] = [];
  const opsDims: Array<[string, string, string]> = [
    ["region", "Region-wise Operations Performance", "region"],
    ["carrier", "Carrier Performance", "carrier"],
    ["warehouse", "Warehouse Operations Performance", "warehouse"]
  ];
  for (const [role, label, dimId] of opsDims) {
    if (!accessor.has(role)) continue;
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of periodRows) {
      const key = accessor.str(row, role);
      if (!key) continue;
      const list = grouped.get(key) || [];
      list.push(row);
      grouped.set(key, list);
    }
    const items = [...grouped.entries()].map(([groupLabel, rows]) => {
      const s = summarizeOperationsSlice(rows, accessor);
      return {
        label: groupLabel,
        primaryValue: s.totalShipments,
        recordCount: rows.length,
        metrics: {
          onTimeDeliveryRate: s.onTimeDeliveryRate,
          averageDeliveryTime: s.averageDeliveryTime,
          fulfillmentRate: s.fulfillmentRate,
          delayedDeliveries: s.delayedDeliveries
        }
      };
    });
    const built = buildBreakdown(dimId, label, accessor.column(role)!, "totalShipments", items);
    if (built) breakdowns.push(built);
  }

  return {
    values: {
      orderProcessingTime: curr.orderProcessingTime,
      averageDeliveryTime: curr.averageDeliveryTime,
      onTimeDeliveryRate: curr.onTimeDeliveryRate,
      delayedDeliveries: curr.delayedDeliveries,
      cancellationRate: curr.cancellationRate,
      fulfillmentRate: curr.fulfillmentRate,
      pendingOrderBacklog: curr.pendingOrderBacklog
    },
    comparisonValues: comp
      ? {
          orderProcessingTime: comp.orderProcessingTime,
          averageDeliveryTime: comp.averageDeliveryTime,
          onTimeDeliveryRate: comp.onTimeDeliveryRate,
          delayedDeliveries: comp.delayedDeliveries,
          cancellationRate: comp.cancellationRate,
          fulfillmentRate: comp.fulfillmentRate,
          pendingOrderBacklog: comp.pendingOrderBacklog
        }
      : {},
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings
  };
}

/* ============================================================================
 * 7. PRODUCT USAGE & SAAS ANALYTICS
 * ============================================================================ */

const SAAS_CHURNED_STATUSES = new Set(["cancelled", "canceled", "churned", "expired", "terminated"]);
const SAAS_ACTIVE_STATUSES = new Set(["active", "trialing", "paid", "renewed"]);
const NON_RECURRING_INTERVALS = new Set(["one_time", "one-time", "onetime", "single", "non_recurring", "once"]);

function calculateProductUsageDomain(input: DomainCalculationInput): DomainCalculationOutput {
  const { accessor, allRows, periodRows, comparisonRows, period, comparison, options } = input;
  const metricWarnings: Record<string, string[]> = {};
  const unavailableOverrides: DomainCalculationOutput["unavailableOverrides"] = {};
  const domainWarnings: string[] = [];

  const wauStart = addDaysToDate(period.end, -6);
  const mauStart = addDaysToDate(period.end, -29);

  const wauUsers = new Set<string>();
  const mauUsers = new Set<string>();
  const periodUsers = new Set<string>();
  const periodUsersByDay = new Map<string, Set<string>>();

  for (const row of allRows) {
    const userId = accessor.str(row, "userId");
    const d = accessor.dateKey(row, "eventTimestamp");
    if (!userId || !d || d > period.end) continue;
    if (d >= mauStart) mauUsers.add(userId);
    if (d >= wauStart) wauUsers.add(userId);
    if (d >= period.start) {
      periodUsers.add(userId);
      const daySet = periodUsersByDay.get(d) || new Set<string>();
      daySet.add(userId);
      periodUsersByDay.set(d, daySet);
    }
  }

  const dates = enumerateDates(period.start, period.end);
  const dailyUserCounts = dates.map(d => periodUsersByDay.get(d)?.size || 0);
  const dau = period.dayCount === 1
    ? dailyUserCounts[0]
    : safeDivide(safeSum(dailyUserCounts), period.dayCount);

  // Comparison DAU
  let compDau: number | null = null;
  if (comparison && comparisonRows.length > 0) {
    const compByDay = new Map<string, Set<string>>();
    for (const row of comparisonRows) {
      const userId = accessor.str(row, "userId");
      const d = accessor.dateKey(row, "eventTimestamp");
      if (!userId || !d) continue;
      const set = compByDay.get(d) || new Set<string>();
      set.add(userId);
      compByDay.set(d, set);
    }
    const totalDayUsers = [...compByDay.values()].reduce((sum, s) => sum + s.size, 0);
    compDau = safeDivide(totalDayUsers, comparison.dayCount);
  }

  // Feature Adoption (requires featureName or eventName)
  const featureRole = accessor.has("featureName") ? "featureName" : accessor.has("eventName") ? "eventName" : null;
  let featureAdoption: number | null = null;
  const featureUserSets = new Map<string, Set<string>>();
  if (featureRole && periodUsers.size > 0) {
    const adoptedAny = new Set<string>();
    for (const row of periodRows) {
      const userId = accessor.str(row, "userId");
      const feat = accessor.str(row, featureRole);
      if (!userId || !feat) continue;
      adoptedAny.add(userId);
      const set = featureUserSets.get(feat) || new Set<string>();
      set.add(userId);
      featureUserSets.set(feat, set);
    }
    featureAdoption = safePercent(adoptedAny.size, periodUsers.size);
  }

  // Activation Rate — STRICTLY requires explicit activationFlag OR explicit options.activationEventName
  let activationRate: number | null = null;
  if (accessor.has("activationFlag")) {
    const activatedUsers = new Set<string>();
    for (const row of periodRows) {
      const userId = accessor.str(row, "userId");
      const flag = accessor.bool(row, "activationFlag");
      if (userId && flag === true) activatedUsers.add(userId);
    }
    activationRate = periodUsers.size > 0 ? safePercent(activatedUsers.size, periodUsers.size) : null;
  } else if (accessor.has("eventName") && options.activationEventName?.trim()) {
    const targetEvent = options.activationEventName.trim().toLowerCase();
    const activatedUsers = new Set<string>();
    for (const row of periodRows) {
      const userId = accessor.str(row, "userId");
      const ev = accessor.str(row, "eventName")?.toLowerCase();
      if (userId && ev === targetEvent) activatedUsers.add(userId);
    }
    activationRate = periodUsers.size > 0 ? safePercent(activatedUsers.size, periodUsers.size) : null;
  } else {
    unavailableOverrides.activationRate = {
      status: "unavailable",
      reason: "Activation Rate requires an explicit activation flag column or a configured activationEventName rule."
    };
  }

  // Subscription Growth
  let subscriptionGrowth: number | null = null;
  if (accessor.has("subscriptionId")) {
    const activeSubIds = (rows: Array<Record<string, unknown>>) => {
      const ids = new Set<string>();
      for (const row of rows) {
        const subId = accessor.str(row, "subscriptionId");
        if (!subId) continue;
        if (accessor.has("subscriptionStatus")) {
          const st = (accessor.str(row, "subscriptionStatus") || "").toLowerCase();
          if (SAAS_CHURNED_STATUSES.has(st)) continue;
        }
        ids.add(subId);
      }
      return ids;
    };
    const currSubs = activeSubIds(periodRows);
    const compSubs = comparison ? activeSubIds(comparisonRows) : new Set<string>();
    if (compSubs.size > 0) {
      subscriptionGrowth = safeChangePercent(currSubs.size, compSubs.size);
    } else {
      unavailableOverrides.subscriptionGrowth = {
        status: "insufficient_data",
        reason: "Subscription Growth requires active subscription records in the comparison period."
      };
    }
  }

  // MRR & ARR — ONLY from explicit recurring revenue columns (never one-off payments!)
  let mrr: number | null = null;
  let arr: number | null = null;
  let skippedOneOffCount = 0;

  if (accessor.has("mrr") || accessor.has("arr")) {
    // Deduplicate latest recurring record per subscriptionId (or userId) to prevent event-row inflation
    const latestRecurring = new Map<string, { date: string; mrr: number | null; arr: number | null }>();
    for (const row of periodRows) {
      const entityKey = accessor.str(row, "subscriptionId") || accessor.str(row, "userId");
      const d = accessor.dateKey(row, "eventTimestamp");
      if (!entityKey || !d) continue;

      if (accessor.has("billingInterval")) {
        const interval = (accessor.str(row, "billingInterval") || "").toLowerCase();
        if (NON_RECURRING_INTERVALS.has(interval)) {
          skippedOneOffCount += 1;
          continue;
        }
      }
      if (accessor.has("subscriptionStatus")) {
        const st = (accessor.str(row, "subscriptionStatus") || "").toLowerCase();
        if (st && !SAAS_ACTIVE_STATUSES.has(st)) continue;
      }

      const rowMrr = accessor.has("mrr") ? accessor.num(row, "mrr") : null;
      const rowArr = accessor.has("arr") ? accessor.num(row, "arr") : null;
      if (rowMrr === null && rowArr === null) continue;

      const existing = latestRecurring.get(entityKey);
      if (!existing || d >= existing.date) {
        latestRecurring.set(entityKey, { date: d, mrr: rowMrr, arr: rowArr });
      }
    }

    if (skippedOneOffCount > 0) {
      domainWarnings.push(`Excluded ${skippedOneOffCount} non-recurring / one-time billing record(s) from MRR and ARR.`);
    }

    const mrrValues: number[] = [];
    const arrValues: number[] = [];
    for (const item of latestRecurring.values()) {
      if (item.mrr !== null) {
        mrrValues.push(item.mrr);
        arrValues.push(item.arr !== null ? item.arr : item.mrr * 12);
      } else if (item.arr !== null) {
        arrValues.push(item.arr);
        mrrValues.push(item.arr / 12);
      }
    }

    if (mrrValues.length > 0) {
      mrr = safeSum(mrrValues);
      arr = safeSum(arrValues);
    } else {
      unavailableOverrides.mrr = { status: "insufficient_data", reason: "No active recurring subscription billing records found in period." };
      unavailableOverrides.arr = { status: "insufficient_data", reason: "No active recurring subscription billing records found in period." };
    }
  }

  // SaaS Subscription Churn — requires explicit subscriptionStatus or churnedAt state change
  let saasChurn: number | null = null;
  if (accessor.has("subscriptionStatus") || accessor.has("churnedAt")) {
    const observable = new Set<string>();
    const churned = new Set<string>();
    for (const row of periodRows) {
      const key = accessor.str(row, "subscriptionId") || accessor.str(row, "userId");
      if (!key) continue;
      observable.add(key);
      const st = (accessor.str(row, "subscriptionStatus") || "").toLowerCase();
      const churnedDate = accessor.has("churnedAt") ? accessor.dateKey(row, "churnedAt") : null;
      if (SAAS_CHURNED_STATUSES.has(st) || (churnedDate && churnedDate >= period.start && churnedDate <= period.end)) {
        churned.add(key);
      }
    }
    saasChurn = observable.size > 0 ? safePercent(churned.size, observable.size) : null;
  }

  const timeSeries: TimeSeriesPoint[] = dates.map(date => ({
    date,
    recordCount: periodRows.filter(r => accessor.dateKey(r, "eventTimestamp") === date).length,
    metrics: {
      dau: periodUsersByDay.get(date)?.size || 0
    }
  }));

  const breakdowns: DimensionBreakdown[] = [];
  if (featureRole && featureUserSets.size > 0) {
    const items = [...featureUserSets.entries()].map(([feat, users]) => ({
      label: feat,
      primaryValue: users.size,
      recordCount: users.size,
      metrics: {
        activeUsers: users.size,
        adoptionPercent: periodUsers.size > 0 ? safePercent(users.size, periodUsers.size) : null
      }
    }));
    const built = buildBreakdown("featureAdoption", "Feature Adoption Breakdown", accessor.column(featureRole)!, "activeUsers", items);
    if (built) breakdowns.push(built);
  }

  if (accessor.has("planTier")) {
    const byPlan = new Map<string, Set<string>>();
    for (const row of periodRows) {
      const plan = accessor.str(row, "planTier");
      const userId = accessor.str(row, "userId");
      if (!plan || !userId) continue;
      const set = byPlan.get(plan) || new Set<string>();
      set.add(userId);
      byPlan.set(plan, set);
    }
    const items = [...byPlan.entries()].map(([plan, users]) => ({
      label: plan,
      primaryValue: users.size,
      recordCount: users.size,
      metrics: { activeUsers: users.size }
    }));
    const built = buildBreakdown("planTier", "Plan Tier Breakdown", accessor.column("planTier")!, "activeUsers", items);
    if (built) breakdowns.push(built);
  }

  return {
    values: {
      dau,
      wau: wauUsers.size,
      mau: mauUsers.size,
      featureAdoption,
      activationRate,
      subscriptionGrowth,
      mrr,
      arr,
      saasChurn
    },
    comparisonValues: {
      dau: compDau
    },
    metricWarnings,
    unavailableOverrides,
    timeSeries,
    breakdowns,
    domainWarnings
  };
}

/* ============================================================================
 * DISPATCHER
 * ============================================================================ */

export function runDomainCalculator(domainId: BusinessDomainId, input: DomainCalculationInput): DomainCalculationOutput {
  switch (domainId) {
    case "sales_ecommerce":
      return calculateSalesDomain(input);
    case "inventory_supply_chain":
      return calculateInventoryDomain(input);
    case "marketing_campaigns":
      return calculateMarketingDomain(input);
    case "finance_expenses":
      return calculateFinanceDomain(input);
    case "customers_crm":
      return calculateCustomersDomain(input);
    case "operations_fulfillment":
      return calculateOperationsDomain(input);
    case "product_usage_saas":
      return calculateProductUsageDomain(input);
  }
}
