import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { profileRowsSnapshot } from "../profiler";
import {
  evaluateMetricComparisonStatus,
  runDynamicAnalysisFromRows,
  safeChangePercent,
  safeRound
} from "../metrics";
import { clearFindingInvestigationCache, runUnifiedDailyAnalysisFromRows } from "../intelligence";
import { DEFAULT_ALERT_RULES } from "../notifications";

// Register React global & CSS Module proxy for SSR component tests under tsx
(globalThis as unknown as { React: typeof React }).React = React;
const requireFromTest = createRequire(import.meta.url);
const ModuleCtor = requireFromTest("node:module") as { _extensions?: Record<string, (mod: { exports: unknown }) => void> };
if (ModuleCtor._extensions) {
  ModuleCtor._extensions[".css"] = (mod: { exports: unknown }) => {
    const classProxy = new Proxy({}, { get: (_target, prop) => String(prop) });
    mod.exports = { __esModule: true, default: classProxy };
  };
}

function profileFromRows(name: string, rows: Array<Record<string, unknown>>) {
  const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const columns = keys.map(col => {
    const sample = rows.map(r => r[col]).find(v => v !== null && v !== undefined && v !== "");
    if (typeof sample === "number") return { name: col, dataType: "numeric" };
    if (typeof sample === "string" && /^\d{4}-\d{2}-\d{2}/.test(sample)) return { name: col, dataType: "date" };
    return { name: col, dataType: "text" };
  });
  return profileRowsSnapshot({ name, columns }, rows);
}

test("1. Negative Current & negative Reference where loss decreases -> Improved — Loss Reduced & Still Negative (Loss)", () => {
  // Example A: -18,389.44 vs -570,273.07 => +96.78%
  const exA = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: -18389.44,
    referenceValue: -570273.07
  });
  assert.equal(exA.absoluteChange, 551883.63);
  assert.equal(exA.changePercent, 96.78);
  assert.equal(exA.trendDirection, "up");
  assert.equal(exA.performanceDirection, "improved");
  assert.equal(exA.performanceLabel, "Improved — Loss Reduced");
  assert.equal(exA.financialPosition, "negative");
  assert.equal(exA.financialPositionLabel, "Still Negative (Loss)");
  assert.equal(exA.isLossPosition, true);

  // Example B: -18,389.44 vs -24,127.00 => +23.78% (NOT -32.4%!)
  const exB = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: -18389.44,
    referenceValue: -24127.00
  });
  assert.equal(exB.absoluteChange, 5737.56);
  assert.equal(exB.changePercent, 23.78);
  assert.equal(exB.performanceDirection, "improved");
  assert.equal(exB.performanceLabel, "Improved — Loss Reduced");
  assert.equal(exB.financialPosition, "negative");
  assert.equal(exB.financialPositionLabel, "Still Negative (Loss)");
  assert.equal(exB.isLossPosition, true);
});

test("2. Negative Current & negative Reference where loss increases -> Declined — Loss Increased & Still Negative (Loss)", () => {
  const res = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: -24127.00,
    referenceValue: -18389.44
  });
  assert.equal(res.absoluteChange, -5737.56);
  assert.equal(res.changePercent, -31.2);
  assert.equal(res.trendDirection, "down");
  assert.equal(res.performanceDirection, "declined");
  assert.equal(res.performanceLabel, "Declined — Loss Increased");
  assert.equal(res.financialPosition, "negative");
  assert.equal(res.financialPositionLabel, "Still Negative (Loss)");
  assert.equal(res.isLossPosition, true);
});

test("3. Negative Reference to positive Current -> Turned Profitable & Positive Gross Profit", () => {
  const res = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: 12000,
    referenceValue: -8000
  });
  assert.equal(res.absoluteChange, 20000);
  assert.equal(res.changePercent, 250);
  assert.equal(res.performanceDirection, "improved");
  assert.equal(res.performanceLabel, "Turned Profitable");
  assert.equal(res.financialPosition, "positive");
  assert.equal(res.financialPositionLabel, "Positive Gross Profit");
  assert.equal(res.isLossPosition, false);
});

test("4. Positive Reference to negative Current -> Moved Into Loss & Negative Gross Profit (Loss)", () => {
  const res = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: -5000,
    referenceValue: 10000
  });
  assert.equal(res.absoluteChange, -15000);
  assert.equal(res.changePercent, -150);
  assert.equal(res.performanceDirection, "declined");
  assert.equal(res.performanceLabel, "Moved Into Loss");
  assert.equal(res.financialPosition, "negative");
  assert.equal(res.financialPositionLabel, "Negative Gross Profit (Loss)");
  assert.equal(res.isLossPosition, true);
});

test("5. Both values positive -> standard higher-is-better interpretation preserved", () => {
  const up = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: 15000,
    referenceValue: 10000
  });
  assert.equal(up.changePercent, 50);
  assert.equal(up.performanceDirection, "improved");
  assert.equal(up.performanceLabel, "Improved");
  assert.equal(up.financialPosition, "positive");
  assert.equal(up.financialPositionLabel, "Positive Gross Profit");
  assert.equal(up.isLossPosition, false);

  const down = evaluateMetricComparisonStatus({
    metricId: "grossProfitMargin",
    metricName: "Gross Profit Margin",
    polarity: "higher_is_better",
    currentValue: 20,
    referenceValue: 30
  });
  assert.equal(down.changePercent, -33.33);
  assert.equal(down.performanceDirection, "declined");
  assert.equal(down.performanceLabel, "Declined");
  assert.equal(down.financialPosition, "positive");
  assert.equal(down.isLossPosition, false);
});

test("6. Zero comparison baseline guards percentage while accurately reporting current financial position", () => {
  const lossFromZero = evaluateMetricComparisonStatus({
    metricId: "grossProfit",
    metricName: "Gross Profit",
    polarity: "higher_is_better",
    currentValue: -4200,
    referenceValue: 0
  });
  assert.equal(lossFromZero.absoluteChange, -4200);
  assert.equal(lossFromZero.changePercent, null);
  assert.equal(lossFromZero.performanceDirection, "unavailable");
  assert.equal(lossFromZero.performanceLabel, "Unavailable (Zero Baseline)");
  assert.equal(lossFromZero.financialPosition, "negative");
  assert.equal(lossFromZero.financialPositionLabel, "Negative Gross Profit (Loss)");
  assert.equal(lossFromZero.isLossPosition, true);
});

test("7 & 8. Different period durations normalize consistently so displayed values ALWAYS match changePercent", () => {
  clearFindingInvestigationCache();
  // Reference: 30 days (2023-12-02 .. 2023-12-31), daily loss = -24,127.00 (total -723,810.00)
  // Current: 1 day (2024-01-01), daily loss = -18,389.44
  // After 1-day normalization: Current = -18,389.44, Reference = -24,127.00, Change = +23.78% (NEVER -32.4%!)
  const rows: Array<Record<string, unknown>> = [];
  for (let day = 2; day <= 31; day++) {
    rows.push({
      Sale_Date: `2023-12-${String(day).padStart(2, "0")}`,
      Category: "Hardware",
      Sales_Amount: 5000,
      Quantity_Sold: 10,
      Unit_Cost: 2912.7, // 5000 - 29127 = -24,127.00
      Discount: 100
    });
  }
  rows.push({
    Sale_Date: "2024-01-01",
    Category: "Hardware",
    Sales_Amount: 5000,
    Quantity_Sold: 10,
    Unit_Cost: 2338.944, // 5000 - 23389.44 = -18,389.44
    Discount: 150
  });

  const profile = profileFromRows("loss_dataset", rows);
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-01-01",
    periodEnd: "2024-01-01",
    comparisonPreset: "previous_30_days",
    includeAllDatasetColumns: true
  });

  // Verify mathematical consistency across EVERY Smart Comparison metric row
  const smart = unified.tools.smartComparison!;
  assert.ok(smart);
  for (const row of smart.metrics) {
    if (row.currentValue !== null && row.comparisonValue !== null && row.baselineStatus === "valid") {
      const expectedAbs = safeRound(row.currentValue - row.comparisonValue, 2);
      const expectedPct = safeChangePercent(row.currentValue, row.comparisonValue);
      assert.equal(row.absoluteChange, expectedAbs, `${row.name} absoluteChange must match displayed values`);
      assert.equal(row.changePercent, expectedPct, `${row.name} changePercent must match displayed values`);
    }
  }

  const gpRow = smart.metrics.find(m => m.metricId === "grossProfit")!;
  assert.equal(gpRow.currentValue, -18389.44);
  assert.equal(gpRow.comparisonValue, -24127);
  assert.equal(gpRow.changePercent, 23.78);
  assert.equal(gpRow.outcome, "improved");
  assert.equal(gpRow.performanceLabel, "Improved — Loss Reduced");
  assert.equal(gpRow.financialPosition, "negative");
  assert.equal(gpRow.financialPositionLabel, "Still Negative (Loss)");
  assert.equal(gpRow.isLossPosition, true);

  // Verify lower-is-better metric (Discounts: 150 vs 100 -> +50% -> Declined, NO financial loss label!)
  const discRow = smart.metrics.find(m => m.metricId === "totalDiscounts")!;
  assert.equal(discRow.currentValue, 150);
  assert.equal(discRow.comparisonValue, 100);
  assert.equal(discRow.changePercent, 50);
  assert.equal(discRow.outcome, "declined");
  assert.equal(discRow.performanceLabel, "Declined");
  assert.equal(discRow.financialPosition, null);
  assert.equal(discRow.isLossPosition, false);
});

test("9. Consistent status interpretation across Smart Comparison, Executive Summary Findings, and rendered UI", async () => {
  clearFindingInvestigationCache();
  // Reference day: -570,273.07; Current day: -18,389.44 => +96.78% loss reduction, STILL NEGATIVE
  const rows: Array<Record<string, unknown>> = [
    {
      Sale_Date: "2023-12-31",
      Category: "Wholesale",
      Sales_Amount: 10000,
      Quantity_Sold: 100,
      Unit_Cost: 5802.7307, // 10000 - 580273.07 = -570,273.07
      Discount: 200
    },
    {
      Sale_Date: "2024-01-01",
      Category: "Wholesale",
      Sales_Amount: 10000,
      Quantity_Sold: 10,
      Unit_Cost: 2838.944, // 10000 - 28389.44 = -18,389.44
      Discount: 100
    }
  ];

  const profile = profileFromRows("consistent_loss_ui", rows);
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-01-01",
    periodEnd: "2024-01-01",
    comparisonPreset: "previous_day"
  });

  const smartGp = unified.tools.smartComparison!.metrics.find(m => m.metricId === "grossProfit")!;
  const briefGp = unified.tools.intelligenceBrief!.findings.find(f => f.metricId === "grossProfit")!;
  assert.ok(smartGp && briefGp);

  // Exact same values, changePercent, performanceLabel, and financialPositionLabel!
  assert.equal(smartGp.changePercent, 96.78);
  assert.equal(briefGp.changePercent, 96.78);
  assert.equal(smartGp.performanceLabel, "Improved — Loss Reduced");
  assert.equal(briefGp.performanceLabel, "Improved — Loss Reduced");
  assert.equal(smartGp.financialPositionLabel, "Still Negative (Loss)");
  assert.equal(briefGp.financialPositionLabel, "Still Negative (Loss)");
  assert.notEqual(briefGp.category, "positive", "Loss-making metric must NOT be categorized as a healthy positive highlight");

  // Render Dashboard UI and verify both Performance and Current Financial Position appear clearly
  const { default: DailyToolsSection } = await import("../components/DailyToolsSection");
  const html = renderToStaticMarkup(
    React.createElement(DailyToolsSection, {
      intelligence: unified,
      loadingIntelligence: false,
      intelligenceError: null,
      comparisonPreset: "previous_day",
      onComparisonPresetChange: () => {},
      alerts: unified.tools.alerts,
      alertRules: DEFAULT_ALERT_RULES,
      savingAlertRules: false,
      onToggleAlertRead: () => {},
      onMarkAllAlertsRead: () => {},
      onSaveAlertRules: async () => {},
      archivedReports: [],
      loadingArchive: false,
      archiveComparison: null,
      comparingArchive: false,
      archiveCompareError: null,
      downloadingReportId: null,
      timezone: "UTC",
      onCompareArchivedReports: async () => {},
      onDownloadReportPdf: async () => {}
    })
  );

  assert.match(html, /Improved — Loss Reduced/);
  assert.match(html, /Still Negative \(Loss\)/);
  assert.match(html, /Current Financial Position:/);
  assert.match(html, /Performance:/);
  assert.match(html, /\+96\.8%/);
});

test("10. Gross Profit semantic validation: explicit profit, total COGS vs unit cost, no double discount, cancelled excluded", () => {
  // 10a. Explicit Profit column is used directly without recomputing from cost
  const explicitRows = [
    { order_id: "1", order_date: "2024-02-01", revenue: 500, cost: 999, profit: -120, quantity: 5, status: "completed" },
    { order_id: "2", order_date: "2024-02-01", revenue: 500, cost: 100, profit: 200, quantity: 5, status: "cancelled" }
  ];
  const explicitRes = runDynamicAnalysisFromRows(profileFromRows("explicit_profit", explicitRows), explicitRows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-02-01",
    periodEnd: "2024-02-01",
    comparisonPreset: "none"
  });
  const expGp = explicitRes.metrics.find(m => m.metricId === "grossProfit")!;
  assert.equal(expGp.value, -120, "Explicit profit must be preserved as negative without Math.abs() and exclude cancelled orders");

  // 10b. cost_of_goods_sold (total line COGS) must NOT be multiplied by quantity, and discounts must NOT be deducted twice
  const cogsRows = [
    { order_id: "1", order_date: "2024-02-01", sales_amount: 1000, cost_of_goods_sold: 600, discount: 50, quantity: 4, status: "completed" }
  ];
  const cogsRes = runDynamicAnalysisFromRows(profileFromRows("total_cogs_sales", cogsRows), cogsRows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-02-01",
    periodEnd: "2024-02-01",
    comparisonPreset: "none"
  });
  assert.equal(cogsRes.metrics.find(m => m.metricId === "totalRevenue")?.value, 1000, "Net sales_amount must not deduct discount a second time");
  assert.equal(cogsRes.metrics.find(m => m.metricId === "grossProfit")?.value, 400, "Total COGS must not be multiplied by quantity");
});
