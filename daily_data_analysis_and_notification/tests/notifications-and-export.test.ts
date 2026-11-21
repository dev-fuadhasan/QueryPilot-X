import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisReport } from "../types";
import {
  DEFAULT_ALERT_RULES,
  evaluateReportAlerts,
  mergeAlerts,
  sanitizeAlertRules
} from "../notifications";
import { buildReportCsv, csvFilename } from "../export-csv";

function createSampleReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    id: 1,
    generationKey: "automatic|2026-11-15|2026-11-15|2026-11-15|30|2026-10-16|2026-11-14",
    reportKind: "automatic",
    reportingDate: "2026-11-15",
    periodStart: "2026-11-15",
    periodEnd: "2026-11-15",
    comparisonDays: 30,
    comparisonStart: "2026-10-16",
    comparisonEnd: "2026-11-14",
    dataset: { table: "daily_sales_orders" },
    current: {
      periodStart: "2026-11-15",
      periodEnd: "2026-11-15",
      totalRevenue: 1200,
      totalOrders: 10,
      totalUnitsSold: 18,
      totalProductLines: 14,
      grossProfit: 360,
      grossProfitMargin: 30,
      totalDiscounts: 60,
      averageOrderValue: 120,
      averageCustomerRating: 4.5,
      statusDistribution: {
        Pending: 1,
        Processing: 0,
        Confirmed: 0,
        Completed: 10,
        Cancelled: 1,
        Returned: 0
      }
    },
    comparisonDailyAverage: {
      totalRevenue: 1150,
      totalOrders: 9,
      totalUnitsSold: 15,
      totalProductLines: 12,
      grossProfit: 320,
      grossProfitMargin: 27.8,
      totalDiscounts: 50,
      averageOrderValue: 127.7,
      averageCustomerRating: 4.3
    },
    comparison: null,
    dailyPerformance: [
      {
        date: "2026-11-15",
        totalRevenue: 1200,
        totalOrders: 10,
        totalUnitsSold: 18,
        totalProductLines: 14,
        grossProfit: 360,
        grossProfitMargin: 30,
        totalDiscounts: 60,
        averageOrderValue: 120,
        averageCustomerRating: 4.5
      }
    ],
    productPerformance: [
      {
        label: "Pro Laptop",
        revenue: 800,
        orders: 4,
        units: 4,
        productLines: 4,
        grossProfit: 240,
        discounts: 40,
        averageRating: 4.7
      }
    ],
    categoryPerformance: [
      {
        label: "Electronics",
        revenue: 1200,
        orders: 10,
        units: 18,
        productLines: 14,
        grossProfit: 360,
        discounts: 60,
        averageRating: 4.5
      }
    ],
    regionPerformance: [
      {
        label: "Dhaka",
        revenue: 1200,
        orders: 10,
        units: 18,
        productLines: 14,
        grossProfit: 360,
        discounts: 60,
        averageRating: 4.5
      }
    ],
    genderPerformance: [
      {
        label: "Female",
        revenue: 700,
        orders: 6,
        units: 10,
        productLines: 8,
        grossProfit: 210,
        discounts: 30,
        averageRating: 4.6
      }
    ],
    generatedAt: "2026-11-16T00:15:00.000Z",
    status: "generated",
    ...overrides
  };
}

test("sanitizeAlertRules clamps out-of-range values safely", () => {
  const sanitized = sanitizeAlertRules({
    revenueDropPercent: 0,
    revenueGrowthPercent: 999,
    minProfitMarginPercent: -5,
    maxCancellationRatePercent: 250,
    minCustomerRating: 9
  });
  assert.equal(sanitized.revenueDropPercent, 1);
  assert.equal(sanitized.revenueGrowthPercent, 500);
  assert.equal(sanitized.minProfitMarginPercent, 0);
  assert.equal(sanitized.maxCancellationRatePercent, 100);
  assert.equal(sanitized.minCustomerRating, 5);
});

test("evaluateReportAlerts detects critical revenue drop, low margin, high cancellations, and low rating", () => {
  const report = createSampleReport({
    current: {
      periodStart: "2026-11-15",
      periodEnd: "2026-11-15",
      totalRevenue: 500,
      totalOrders: 4,
      totalUnitsSold: 6,
      totalProductLines: 6,
      grossProfit: 40,
      grossProfitMargin: 8,
      totalDiscounts: 100,
      averageOrderValue: 125,
      averageCustomerRating: 3.1,
      statusDistribution: {
        Pending: 0,
        Processing: 0,
        Confirmed: 0,
        Completed: 4,
        Cancelled: 3,
        Returned: 1
      }
    },
    comparisonDailyAverage: {
      totalRevenue: 1200,
      totalOrders: 10,
      totalUnitsSold: 15,
      totalProductLines: 12,
      grossProfit: 360,
      grossProfitMargin: 30,
      totalDiscounts: 40,
      averageOrderValue: 120,
      averageCustomerRating: 4.4
    }
  });

  const alerts = evaluateReportAlerts(report, { ...DEFAULT_ALERT_RULES, highlightTopPerformer: false });
  const byCode = new Map(alerts.map(item => [item.code, item]));

  assert.equal(byCode.get("REVENUE_DROP")?.severity, "critical");
  assert.equal(byCode.get("LOW_MARGIN")?.severity, "warning");
  assert.equal(byCode.get("HIGH_CANCELLATION")?.severity, "critical");
  assert.equal(byCode.get("LOW_RATING")?.severity, "warning");
});

test("evaluateReportAlerts emits positive revenue surge and top performer highlight", () => {
  const report = createSampleReport({
    current: {
      ...createSampleReport().current,
      totalRevenue: 2000
    },
    comparisonDailyAverage: {
      ...createSampleReport().comparisonDailyAverage!,
      totalRevenue: 1000
    }
  });

  const alerts = evaluateReportAlerts(report, DEFAULT_ALERT_RULES);
  assert.ok(alerts.some(item => item.code === "REVENUE_GROWTH" && item.severity === "positive"));
  assert.ok(alerts.some(item => item.code === "TOP_PERFORMER" && item.severity === "info"));
});

test("evaluateReportAlerts respects availableMetrics and avoids false alerts for unmapped columns", () => {
  const report = createSampleReport({
    availableMetrics: ["totalOrders", "totalProductLines"],
    current: {
      ...createSampleReport().current,
      totalRevenue: 0,
      grossProfit: -50,
      grossProfitMargin: 0,
      averageCustomerRating: 2.0
    }
  });

  const alerts = evaluateReportAlerts(report, DEFAULT_ALERT_RULES);
  assert.equal(alerts.some(item => item.code === "ZERO_REVENUE"), false);
  assert.equal(alerts.some(item => item.code === "NEGATIVE_PROFIT"), false);
  assert.equal(alerts.some(item => item.code === "LOW_RATING"), false);
  assert.ok(alerts.some(item => item.code === "HEALTHY_SUMMARY"));
});

test("evaluateReportAlerts returns empty list when notifications are disabled", () => {
  const alerts = evaluateReportAlerts(createSampleReport(), { ...DEFAULT_ALERT_RULES, enabled: false });
  assert.equal(alerts.length, 0);
});

test("mergeAlerts deduplicates by id and preserves existing isRead state", () => {
  const first = evaluateReportAlerts(createSampleReport(), DEFAULT_ALERT_RULES);
  assert.ok(first.length > 0);
  const markedRead = first.map(item => ({ ...item, isRead: true }));
  const merged = mergeAlerts(markedRead, first, 10);
  assert.equal(merged.length, first.length);
  assert.ok(merged.every(item => item.isRead === true));
});

test("buildReportCsv exports KPIs, status distribution, daily performance, and safely escapes cells", () => {
  const report = createSampleReport({
    availableMetrics: ["totalOrders", "totalProductLines", "totalRevenue", "averageOrderValue"],
    productPerformance: [
      {
        label: "=SUM(A1:A2), \"Special\"",
        revenue: 800,
        orders: 4,
        units: 4,
        productLines: 4,
        grossProfit: 240,
        discounts: 40,
        averageRating: null
      }
    ]
  });

  const csv = buildReportCsv(report);
  assert.match(csv, /QueryPilot X - Daily Analysis Report/);
  assert.match(csv, /Total Revenue,1200\.00,1150\.00/);
  assert.match(csv, /Gross Profit,Unavailable,Unavailable/);
  assert.match(csv, /Order Status Distribution/);
  assert.match(csv, /Daily Performance/);
  assert.match(csv, /2026-11-15,1200\.00,10/);
  assert.match(csv, /"'=SUM\(A1:A2\), ""Special"""/);
  assert.equal(csvFilename(report), "querypilot-x-report-automatic-2026-11-15-to-2026-11-15.csv");
});
