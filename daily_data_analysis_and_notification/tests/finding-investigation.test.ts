import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { profileRowsSnapshot, understandTableForDomain } from "../profiler";
import { runDynamicAnalysisFromRows } from "../metrics";
import {
  clearFindingInvestigationCache,
  getFindingInvestigationCacheSize,
  runAutomatedFindingInvestigations,
  runUnifiedDailyAnalysisFromRows,
  type BriefFinding
} from "../intelligence";
import { DEFAULT_ALERT_RULES } from "../notifications";

// Register React global & CSS Module proxy for Node SSR component test under tsx
(globalThis as unknown as { React: typeof React }).React = React;
const requireFromTest = createRequire(import.meta.url);
const ModuleCtor = requireFromTest("node:module") as { _extensions?: Record<string, (mod: { exports: unknown }) => void> };
if (ModuleCtor._extensions) {
  ModuleCtor._extensions[".css"] = (mod: { exports: unknown }) => {
    const classProxy = new Proxy({}, { get: (_target, prop) => String(prop) });
    mod.exports = { __esModule: true, default: classProxy };
  };
}

function profileTestRows(name: string, rows: Array<Record<string, unknown>>) {
  const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const columns = keys.map(col => {
    const sample = rows.map(r => r[col]).find(v => v !== null && v !== undefined && v !== "");
    if (typeof sample === "number") return { name: col, dataType: "numeric" };
    if (typeof sample === "boolean") return { name: col, dataType: "boolean" };
    if (typeof sample === "string" && /^\d{4}-\d{2}-\d{2}/.test(sample)) return { name: col, dataType: "date" };
    return { name: col, dataType: "text" };
  });
  return profileRowsSnapshot({ name, columns }, rows);
}

/**
 * Helper to generate realistic multi-day sales rows with controlled category/channel/date behavior.
 */
function buildSalesMarginDropFixture() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 1;

  // Reference period: 2024-05-01 to 2024-05-07 (strong ~41% gross margin across categories)
  for (let day = 1; day <= 7; day++) {
    const date = `2024-05-0${day}`;
    rows.push(
      {
        order_id: `ORD-${seq++}`,
        product_id: "SKU-APP-01",
        order_date: date,
        category: "Apparel",
        region: "North",
        sales_channel: "Online",
        revenue: 1000,
        cost: 580,
        discount: 20,
        quantity: 10,
        status: "completed"
      },
      {
        order_id: `ORD-${seq++}`,
        product_id: "SKU-ELC-01",
        order_date: date,
        category: "Electronics",
        region: "South",
        sales_channel: "Store",
        revenue: 1200,
        cost: 720,
        discount: 30,
        quantity: 6,
        status: "completed"
      }
    );
  }

  // Current period: 2024-05-08 to 2024-05-14
  // Apparel + Online suffers steep margin compression peaking on 2024-05-12
  for (let day = 8; day <= 14; day++) {
    const date = `2024-05-${String(day).padStart(2, "0")}`;
    const isPeakDrop = day === 12;
    rows.push(
      {
        order_id: `ORD-${seq++}`,
        product_id: "SKU-APP-01",
        order_date: date,
        category: "Apparel",
        region: "North",
        sales_channel: "Online",
        revenue: isPeakDrop ? 1000 : 950,
        cost: isPeakDrop ? 920 : 760,
        discount: isPeakDrop ? 280 : 120,
        quantity: 10,
        status: "completed"
      },
      {
        order_id: `ORD-${seq++}`,
        product_id: "SKU-ELC-01",
        order_date: date,
        category: "Electronics",
        region: "South",
        sales_channel: "Store",
        revenue: 1200,
        cost: 730,
        discount: 30,
        quantity: 6,
        status: "completed"
      }
    );
  }

  return rows;
}

test("1. Automatic investigation after a negative finding (Gross Profit Margin drop)", () => {
  clearFindingInvestigationCache();
  const rows = buildSalesMarginDropFixture();
  const profile = profileTestRows("sales_orders", rows);

  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-08",
    periodEnd: "2024-05-14",
    comparisonPreset: "previous_7_days"
  });

  const brief = result.tools.intelligenceBrief;
  assert.ok(brief, "Daily intelligence brief must be generated");
  assert.ok(brief.findings.length > 0, "Findings must be detected");

  const marginFinding = brief.findings.find(f => f.metricId === "grossProfitMargin" && f.category === "negative");
  assert.ok(marginFinding, "Expected a negative Gross Profit Margin finding");
  assert.ok(marginFinding.investigation, "Investigation must run automatically for the finding");

  const inv = marginFinding.investigation;
  assert.equal(inv.status, "completed");
  assert.equal(inv.investigationType, "metric_deterioration");
  assert.equal(inv.investigatedMetric?.metricId, "grossProfitMargin");
  assert.equal(inv.largestChangeDate, "2024-05-12");
  assert.ok(inv.dailyTrend && inv.dailyTrend.points.length === 7, "Should analyze all 7 reporting days");
  assert.ok(inv.dimensionBreakdowns.length >= 2, "Should automatically inspect multiple safe dimensions");

  const categoryDim = inv.dimensionBreakdowns.find(d => d.sourceColumn === "category");
  assert.ok(categoryDim, "Category dimension must be automatically analyzed");
  assert.equal(categoryDim.topAffectedSegment?.groupLabel, "Apparel");
  assert.equal(categoryDim.topAffectedSegment?.direction, "deteriorated");
  assert.ok(inv.relatedMetricDrivers.some(d => d.metricId === "grossProfit" || d.metricId === "totalDiscounts"));
  assert.ok(inv.supportingEvidence.length > 0);
  assert.ok(inv.suggestedNextSteps.length > 0);
});

test("2. Automatic investigation after a positive finding (Marketing ROAS / revenue improvement)", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [];

  // Reference: 2024-06-01 to 2024-06-05
  for (let d = 1; d <= 5; d++) {
    const date = `2024-06-0${d}`;
    rows.push(
      {
        campaign_id: "CMP-SEARCH",
        campaign_date: date,
        campaign_name: "Summer_Search",
        channel: "Paid Search",
        ad_spend: 500,
        attributed_revenue: 1000,
        impressions: 20000,
        clicks: 600,
        conversions: 25
      },
      {
        campaign_id: "CMP-SOCIAL",
        campaign_date: date,
        campaign_name: "Brand_Social",
        channel: "Social",
        ad_spend: 400,
        attributed_revenue: 800,
        impressions: 18000,
        clicks: 500,
        conversions: 15
      }
    );
  }
  // Current: 2024-06-06 to 2024-06-10 (Summer_Search improves ~24% overall, peaking on 2024-06-09)
  for (let d = 6; d <= 10; d++) {
    const date = `2024-06-${String(d).padStart(2, "0")}`;
    const isPeak = d === 9;
    rows.push(
      {
        campaign_id: "CMP-SEARCH",
        campaign_date: date,
        campaign_name: "Summer_Search",
        channel: "Paid Search",
        ad_spend: 500,
        attributed_revenue: isPeak ? 1750 : 1280,
        impressions: 21500,
        clicks: 680,
        conversions: isPeak ? 38 : 30
      },
      {
        campaign_id: "CMP-SOCIAL",
        campaign_date: date,
        campaign_name: "Brand_Social",
        channel: "Social",
        ad_spend: 400,
        attributed_revenue: 820,
        impressions: 18000,
        clicks: 510,
        conversions: 16
      }
    );
  }

  const profile = profileTestRows("marketing_campaigns", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "marketing_campaigns",
    timezone: "UTC",
    periodStart: "2024-06-06",
    periodEnd: "2024-06-10",
    comparisonPreset: "custom",
    comparisonStart: "2024-06-01",
    comparisonEnd: "2024-06-05"
  });

  const brief = result.tools.intelligenceBrief;
  assert.ok(brief);
  const posFinding = brief.findings.find(f => f.category === "positive");
  assert.ok(posFinding, "Expected a positive finding in Marketing Campaigns");
  assert.ok(posFinding.investigation);
  assert.equal(posFinding.investigation.status, "completed");
  assert.equal(posFinding.investigation.investigationType, "metric_improvement");
  assert.equal(posFinding.investigation.largestChangeDate, "2024-06-09");
  assert.ok(
    posFinding.investigation.topAssociatedSegments.some(s => s.groupLabel === "Summer_Search" || s.groupLabel === "Paid Search"),
    "Top segment should point to the surging campaign/channel"
  );
});

test("3. Investigation of unusual findings (>35% extreme shift)", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    // Reference period: 2024-07-01..03
    { txn_date: "2024-07-01", category: "Hardware", region: "West", revenue: 1000, cost: 600, quantity: 10, status: "completed" },
    { txn_date: "2024-07-02", category: "Hardware", region: "West", revenue: 1050, cost: 620, quantity: 10, status: "completed" },
    { txn_date: "2024-07-03", category: "Software", region: "East", revenue: 950, cost: 300, quantity: 10, status: "completed" },
    // Current period: 2024-07-04..06 (huge +160% revenue spike on 2024-07-05)
    { txn_date: "2024-07-04", category: "Hardware", region: "West", revenue: 1100, cost: 650, quantity: 11, status: "completed" },
    { txn_date: "2024-07-05", category: "Hardware", region: "West", revenue: 6200, cost: 3400, quantity: 60, status: "completed" },
    { txn_date: "2024-07-06", category: "Software", region: "East", revenue: 1000, cost: 310, quantity: 10, status: "completed" }
  ];

  const profile = profileTestRows("sales_ledger", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-07-04",
    periodEnd: "2024-07-06",
    comparisonPreset: "custom",
    comparisonStart: "2024-07-01",
    comparisonEnd: "2024-07-03"
  });

  const unusualFinding = result.tools.intelligenceBrief?.unusualActivities.find(f => f.metricId === "totalRevenue");
  assert.ok(unusualFinding, "Expected totalRevenue (>35% swing) to be tracked in unusualActivities");
  assert.equal(
    result.tools.intelligenceBrief?.findings.filter(f => f.metricId === "totalRevenue").length,
    1,
    "Should not emit a duplicate Possible Explanation finding card for the same metric"
  );
  assert.ok(unusualFinding.investigation);
  assert.equal(unusualFinding.investigation.status, "completed");
  assert.ok(unusualFinding.investigation.dailyTrend);
  assert.ok(unusualFinding.investigation.dailyTrend.unusualDates.some(u => u.date === "2024-07-05"));
  assert.ok(unusualFinding.possibleExplanation && /35%/.test(unusualFinding.possibleExplanation));
});

test("4. Daily time-series analysis detects continuous downward trend & exact largest shift", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    // Reference 2024-08-01..04
    { order_date: "2024-08-01", category: "Home", revenue: 2000, cost: 1000, quantity: 20, status: "completed" },
    { order_date: "2024-08-02", category: "Home", revenue: 2000, cost: 1000, quantity: 20, status: "completed" },
    { order_date: "2024-08-03", category: "Home", revenue: 2000, cost: 1000, quantity: 20, status: "completed" },
    { order_date: "2024-08-04", category: "Home", revenue: 2000, cost: 1000, quantity: 20, status: "completed" },
    // Current 2024-08-05..08 (continuous daily decline)
    { order_date: "2024-08-05", category: "Home", revenue: 1800, cost: 900, quantity: 18, status: "completed" },
    { order_date: "2024-08-06", category: "Home", revenue: 1500, cost: 750, quantity: 15, status: "completed" },
    { order_date: "2024-08-07", category: "Home", revenue: 900, cost: 450, quantity: 9, status: "completed" },
    { order_date: "2024-08-08", category: "Home", revenue: 700, cost: 350, quantity: 7, status: "completed" }
  ];

  const profile = profileTestRows("daily_sales", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-08-05",
    periodEnd: "2024-08-08",
    comparisonPreset: "custom",
    comparisonStart: "2024-08-01",
    comparisonEnd: "2024-08-04"
  });

  const revFinding = result.tools.intelligenceBrief?.findings.find(f => f.metricId === "totalRevenue");
  assert.ok(revFinding?.investigation?.dailyTrend);
  const trend = revFinding.investigation.dailyTrend;
  assert.equal(trend.points.length, 4);
  assert.equal(trend.trendPattern, "continuous_downward");
  assert.equal(trend.largestDeteriorationDate, "2024-08-07");
  assert.equal(trend.largestDayOverDayChange?.date, "2024-08-07");
  assert.equal(trend.largestDayOverDayChange?.delta, -600);
});

test("5. Segment breakdown ranks relevant dimensions and excludes unsafe/ID/high-cardinality columns", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 40; i++) {
    const isCurrent = i > 20;
    const day = isCurrent ? i - 20 : i;
    const date = `2024-09-${String(day <= 5 ? (isCurrent ? day + 5 : day) : (isCurrent ? 10 : 5)).padStart(2, "0")}`;
    const region = i % 2 === 0 ? "East" : "West";
    const channel = i % 3 === 0 ? "Marketplace" : "Direct";
    rows.push({
      order_id: `ORD-${i}`,
      customer_email: `user${i}@example.com`,
      unique_tracking_note: `TRACK-UNIQUE-${i}`,
      order_date: date,
      region,
      sales_channel: channel,
      revenue: isCurrent && region === "East" ? 400 : 1000,
      cost: 300,
      quantity: 5,
      status: "completed"
    });
  }

  const profile = profileTestRows("channel_orders", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-09-06",
    periodEnd: "2024-09-10",
    comparisonPreset: "custom",
    comparisonStart: "2024-09-01",
    comparisonEnd: "2024-09-05"
  });

  const finding = result.tools.intelligenceBrief?.findings.find(f => f.metricId === "totalRevenue");
  assert.ok(finding?.investigation);
  const analyzedCols = finding.investigation.dimensionBreakdowns.map(d => d.sourceColumn);
  assert.ok(analyzedCols.includes("region"), "Safe categorical column region must be included");
  assert.ok(analyzedCols.includes("sales_channel"), "Safe categorical column sales_channel must be included");
  assert.ok(!analyzedCols.includes("customer_email"), "Sensitive email column must be excluded");
  assert.ok(!analyzedCols.includes("order_id"), "Identifier column must be excluded");
  assert.ok(!analyzedCols.includes("unique_tracking_note"), "High-cardinality note column must be excluded");

  const regionBreakdown = finding.investigation.dimensionBreakdowns.find(d => d.sourceColumn === "region");
  assert.equal(regionBreakdown?.topAffectedSegment?.groupLabel, "East");
});

test("6. Metric-specific calculations: Gross Profit Margin uses exact aggregated SUM(GP)/SUM(Rev), NOT averaged row percentages", () => {
  clearFindingInvestigationCache();
  // On 2024-10-02, two Apparel transactions (cost is unit cost * quantity):
  //   Row A: Revenue 100, Unit Cost 10 * Qty 1 = 10 -> GP 90 (row margin 90%)
  //   Row B: Revenue 900, Unit Cost 90 * Qty 9 = 810 -> GP 90 (row margin 10%)
  //   Naive average of row margins = (90% + 10%) / 2 = 50% (WRONG!)
  //   True aggregated margin = (90 + 90) / (100 + 900) = 180 / 1000 = 18.0% (CORRECT!)
  const rows: Array<Record<string, unknown>> = [
    // Reference: 2024-10-01 (50% margin: Rev 1000, Unit Cost 50 * Qty 10 = 500 -> GP 500)
    { order_id: "R1", order_date: "2024-10-01", category: "Apparel", revenue: 1000, cost: 50, discount: 10, quantity: 10, status: "completed" },
    // Current: 2024-10-02 (18% aggregated margin, 50% naive row average)
    { order_id: "C1", order_date: "2024-10-02", category: "Apparel", revenue: 100, cost: 10, discount: 5, quantity: 1, status: "completed" },
    { order_id: "C2", order_date: "2024-10-02", category: "Apparel", revenue: 900, cost: 90, discount: 150, quantity: 9, status: "completed" }
  ];

  const profile = profileTestRows("margin_math_orders", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-10-02",
    periodEnd: "2024-10-02",
    comparisonPreset: "previous_day"
  });

  const marginMetric = result.analysis.metrics.find(m => m.metricId === "grossProfitMargin");
  assert.equal(marginMetric?.value, 18, "Top-level Gross Profit Margin must be exact 18%");

  const marginFinding = result.tools.intelligenceBrief?.findings.find(f => f.metricId === "grossProfitMargin");
  assert.ok(marginFinding?.investigation);
  const dailyPt = marginFinding.investigation.dailyTrend?.points.find(p => p.date === "2024-10-02");
  assert.equal(dailyPt?.value, 18, "Daily Gross Profit Margin must be exact aggregated 18%, NOT 50%");

  // Also verify ASP, Gross Profit, Total Revenue, Discounts are available as related drivers
  const driverIds = marginFinding.investigation.relatedMetricDrivers.map(d => d.metricId);
  assert.ok(driverIds.includes("grossProfit"));
  assert.ok(driverIds.includes("totalRevenue"));
  assert.ok(driverIds.includes("totalDiscounts"));
});

test("7. Missing date column degrades gracefully without crashing or inventing daily trends", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    { category: "Books", revenue: 500, cost: 300, quantity: 5 },
    { category: "Games", revenue: 700, cost: 400, quantity: 7 }
  ];
  const profile = profileTestRows("dateless_sales", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-11-01",
    periodEnd: "2024-11-01",
    includeAllDatasetColumns: true
  });

  const brief = result.tools.intelligenceBrief;
  assert.ok(brief);
  assert.ok(brief.findings.length > 0);
  for (const f of brief.findings) {
    assert.ok(f.investigation, "Every finding should receive a graceful investigation status");
    assert.ok(
      ["completed", "partially_completed", "insufficient_data", "unsupported"].includes(f.investigation.status)
    );
    if (f.investigation.dailyTrend) {
      assert.equal(f.investigation.dailyTrend.available, false);
    }
  }
});

test("8. Missing segment columns still produces daily time-series investigation and notes segment limitation", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    { order_date: "2024-11-01", revenue: 2000, cost: 1000, quantity: 10 },
    { order_date: "2024-11-02", revenue: 2000, cost: 1000, quantity: 10 },
    { order_date: "2024-11-03", revenue: 1100, cost: 900, quantity: 8 },
    { order_date: "2024-11-04", revenue: 900, cost: 800, quantity: 7 }
  ];
  const profile = profileTestRows("numeric_only_sales", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-11-03",
    periodEnd: "2024-11-04",
    comparisonPreset: "custom",
    comparisonStart: "2024-11-01",
    comparisonEnd: "2024-11-02"
  });

  const revFinding = result.tools.intelligenceBrief?.findings.find(f => f.metricId === "totalRevenue");
  assert.ok(revFinding?.investigation);
  assert.equal(revFinding.investigation.status, "partially_completed");
  assert.equal(revFinding.investigation.dailyTrend?.available, true);
  assert.equal(revFinding.investigation.dimensionBreakdowns.length, 0);
  assert.ok(
    revFinding.investigation.dataLimitations.some(l => /categorical segment/i.test(l)),
    "Must explicitly report missing categorical segment columns"
  );
});

test("9. Insufficient records (0 rows in reporting period) triggers honest missing_data investigation", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    { order_date: "2024-01-05", category: "Audio", revenue: 500, cost: 250, quantity: 5 }
  ];
  const profile = profileTestRows("sparse_orders", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-12-01",
    periodEnd: "2024-12-01",
    comparisonPreset: "previous_day"
  });

  const gapFinding = result.tools.intelligenceBrief?.findings.find(f => f.category === "data_gap");
  assert.ok(gapFinding?.investigation);
  assert.equal(gapFinding.investigation.investigationType, "missing_data");
  assert.equal(gapFinding.investigation.status, "insufficient_data");
  assert.ok(gapFinding.investigation.missingDataDetails);
});

test("10. Duplicate Product_ID across distinct transactions is recognized as legitimate, NOT duplicate rows", () => {
  clearFindingInvestigationCache();
  // Same product_id ("PROD-100") sold on 6 distinct transactions/orders/customers -> NOT duplicate records!
  const rows: Array<Record<string, unknown>> = [
    { order_id: "ORD-1", product_id: "PROD-100", customer_id: "C-1", order_date: "2024-11-10", category: "Shoes", revenue: 120, cost: 60, quantity: 1 },
    { order_id: "ORD-2", product_id: "PROD-100", customer_id: "C-2", order_date: "2024-11-10", category: "Shoes", revenue: 120, cost: 60, quantity: 1 },
    { order_id: "ORD-3", product_id: "PROD-100", customer_id: "C-3", order_date: "2024-11-11", category: "Shoes", revenue: 120, cost: 60, quantity: 1 },
    { order_id: "ORD-4", product_id: "PROD-100", customer_id: "C-4", order_date: "2024-11-11", category: "Shoes", revenue: 120, cost: 60, quantity: 1 },
    { order_id: "ORD-5", product_id: "PROD-100", customer_id: "C-5", order_date: "2024-11-12", category: "Shoes", revenue: 120, cost: 60, quantity: 1 },
    { order_id: "ORD-6", product_id: "PROD-100", customer_id: "C-6", order_date: "2024-11-12", category: "Shoes", revenue: 120, cost: 60, quantity: 1 }
  ];

  const profile = profileTestRows("sales_items", rows);
  const understanding = understandTableForDomain(profile, "sales_ecommerce");
  const analysis = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-11-10",
    periodEnd: "2024-11-12"
  });

  // Simulate a duplicate-data finding pointing at product_id
  const duplicateFinding: BriefFinding = {
    id: "health-duplicate-product-id",
    category: "data_gap",
    certainty: "confirmed",
    headline: "Duplicate values detected in product_id",
    whatHappened: "Repeated product_id values observed across 6 rows.",
    whatChanged: null,
    affectedArea: "sales_items",
    whyItMatters: "Repeated identifiers may indicate duplicates or normal transactional granularity.",
    investigateNext: "Check composite transaction keys.",
    metricId: null,
    metricValue: null,
    changePercent: null
  };

  const [inv] = runAutomatedFindingInvestigations({
    findings: [duplicateFinding],
    tableProfile: profile,
    understanding,
    analysis,
    periodRows: rows,
    comparisonRows: []
  });

  assert.equal(inv.investigationType, "duplicate_data");
  assert.equal(inv.status, "completed");
  assert.ok(inv.duplicateDetails);
  assert.equal(
    inv.duplicateDetails.repeatedIdentifierAssessment,
    "likely_legitimate_transactions",
    "Distinct orders with repeated product_id must be recognized as legitimate transactions, NOT duplicate rows"
  );
  assert.ok(
    inv.duplicateDetails.candidateCompositeKeys.length > 0,
    "Should identify candidate composite transaction keys"
  );
  assert.match(inv.duplicateDetails.assessmentNote, /legitimate|distinct|transaction/i);
});

test("11 & 12. Zero/negative revenue and zero denominator in margin calculations produce safe finite/null values", () => {
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    // Reference: normal positive revenue
    { order_date: "2024-11-01", category: "Promo", revenue: 500, cost: 250, quantity: 5, status: "completed" },
    // Current: zero revenue & negative adjustment
    { order_date: "2024-11-02", category: "Promo", revenue: 0, cost: 120, quantity: 2, status: "completed" },
    { order_date: "2024-11-02", category: "RefundAdj", revenue: -50, cost: 0, quantity: 1, status: "completed" }
  ];

  const profile = profileTestRows("edge_revenue", rows);
  const result = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-11-02",
    periodEnd: "2024-11-02",
    comparisonPreset: "previous_day"
  });

  // Verify no NaN or Infinity anywhere in serialized output
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("NaN"), "Output must never contain NaN");
  assert.ok(!serialized.includes("Infinity"), "Output must never contain Infinity");

  // Also test pure zero revenue denominator for Gross Profit Margin
  const zeroRevRows: Array<Record<string, unknown>> = [
    { order_date: "2024-11-01", category: "FreeTier", revenue: 100, cost: 50, quantity: 2, status: "completed" },
    { order_date: "2024-11-02", category: "FreeTier", revenue: 0, cost: 40, quantity: 2, status: "completed" }
  ];
  const zeroProfile = profileTestRows("zero_denom_sales", zeroRevRows);
  const zeroRes = runUnifiedDailyAnalysisFromRows(zeroProfile, zeroRevRows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-11-02",
    periodEnd: "2024-11-02",
    comparisonPreset: "previous_day"
  });
  const margin = zeroRes.analysis.metrics.find(m => m.metricId === "grossProfitMargin");
  assert.equal(margin?.value, null, "Zero revenue denominator must produce null margin, never Infinity/NaN");
});

test("13. SQL safety: strictly read-only module with zero DML/DDL statements and sensitive columns blocked", () => {
  const sourcePath = path.join(
    process.cwd(),
    "daily_data_analysis_and_notification",
    "intelligence",
    "finding-investigation.ts"
  );
  const src = readFileSync(sourcePath, "utf8");
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE)\b/i.test(src));

  // Verify invalid identifier & sensitive column names are rejected in segment breakdown
  clearFindingInvestigationCache();
  const rows: Array<Record<string, unknown>> = [
    { order_date: "2024-11-01", "bad; DROP TABLE users": "X", password_hash: "h1", credit_card_number: "4111", category: "A", revenue: 1000, cost: 400, quantity: 5 },
    { order_date: "2024-11-01", "bad; DROP TABLE users": "Y", password_hash: "h2", credit_card_number: "4222", category: "B", revenue: 900, cost: 400, quantity: 5 },
    { order_date: "2024-11-02", "bad; DROP TABLE users": "X", password_hash: "h1", credit_card_number: "4111", category: "A", revenue: 300, cost: 250, quantity: 2 },
    { order_date: "2024-11-02", "bad; DROP TABLE users": "Y", password_hash: "h2", credit_card_number: "4222", category: "B", revenue: 850, cost: 400, quantity: 5 }
  ];
  const profile = profileTestRows("safe_check", rows);
  const res = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-11-02",
    periodEnd: "2024-11-02",
    comparisonPreset: "previous_day"
  });

  for (const inv of res.tools.intelligenceBrief?.investigations || []) {
    const cols = inv.dimensionBreakdowns.map(d => d.sourceColumn);
    assert.ok(!cols.includes("bad; DROP TABLE users"));
    assert.ok(!cols.includes("password_hash"));
    assert.ok(!cols.includes("credit_card_number"));
  }
});

test("14 & 15. Multiple findings investigated independently & partial failure isolated safely", () => {
  clearFindingInvestigationCache();
  const rows = buildSalesMarginDropFixture();
  const profile = profileTestRows("multi_finding_sales", rows);

  // First run cleanly to verify multiple findings are each investigated independently
  const cleanResult = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-08",
    periodEnd: "2024-05-14",
    comparisonPreset: "previous_7_days",
    useInvestigationCache: false
  });
  const findings = cleanResult.tools.intelligenceBrief?.findings || [];
  assert.ok(findings.length >= 2, "Expected at least 2 findings to test independent investigation");
  for (const f of findings) {
    assert.ok(f.investigation, `Finding ${f.id} must have an attached investigation`);
    assert.equal(f.investigation.findingId, f.id);
  }

  // Inject an error into the FIRST finding only -> remaining findings MUST still complete!
  const failingFindingId = findings[0].id;
  const faultIsolatedResult = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-08",
    periodEnd: "2024-05-14",
    comparisonPreset: "previous_7_days",
    useInvestigationCache: false,
    investigationOverrides: {
      [failingFindingId]: () => {
        throw new Error("Simulated single-finding crash");
      }
    }
  });

  const faultedFindings = faultIsolatedResult.tools.intelligenceBrief?.findings || [];
  const failedOne = faultedFindings.find(f => f.id === failingFindingId);
  const unaffected = faultedFindings.filter(f => f.id !== failingFindingId);

  assert.equal(failedOne?.investigation?.status, "insufficient_data");
  assert.match(failedOne?.investigation?.statusReason || "", /Simulated single-finding crash/);
  assert.ok(unaffected.length >= 1);
  assert.ok(
    unaffected.every(f => f.investigation && f.investigation.status === "completed"),
    "All other findings must complete unaffected when one investigation throws"
  );
});

test("16. Executive Summary UI integration renders automatic investigation & collapsible details with dynamic data", async () => {
  clearFindingInvestigationCache();
  const rows = buildSalesMarginDropFixture();
  const profile = profileTestRows("ui_sales_orders", rows);
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-08",
    periodEnd: "2024-05-14",
    comparisonPreset: "previous_7_days"
  });

  const { default: DailyToolsSection } = await import("../components/DailyToolsSection");
  const html = renderToStaticMarkup(
    React.createElement(DailyToolsSection, {
      intelligence: unified,
      loadingIntelligence: false,
      intelligenceError: null,
      comparisonPreset: "previous_7_days",
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

  assert.match(html, /Automatic Investigation/);
  assert.match(html, /Automatic Investigation Details/);
  assert.match(html, /Completed/);
  assert.match(html, /2024-05-12/, "UI must display dynamically computed largest change date");
  assert.match(html, /Apparel/, "UI must display dynamically computed top segment");
  assert.match(html, /Daily Trend/);
  assert.match(html, /Segment Breakdown/);
  assert.match(html, /Key Evidence/);
  assert.match(html, /Suggested Actions/);
  assert.doesNotMatch(html, /2023-12-18|33\.1%/, "UI must never render hardcoded example values");

  // Dashboard layout & Findings presentation requirements:
  // 1. Smart Comparison appears BEFORE Findings
  const smartComparisonIdx = html.indexOf('aria-label="Smart Comparison"');
  const findingsIdx = html.indexOf('aria-label="Findings and Intelligence Brief"');
  assert.ok(smartComparisonIdx !== -1 && findingsIdx !== -1);
  assert.ok(smartComparisonIdx < findingsIdx, "Smart Comparison must render before Findings");

  // 2. Highlighted Current & Reference period cards show dataset, dynamic date ranges, and day counts
  assert.match(html, /Current Analysis Period/);
  assert.match(html, /Reference Comparison Period/);
  assert.match(html, /ui_sales_orders/);
  assert.match(html, /2024-05-08 to 2024-05-14/);
  assert.match(html, /2024-05-01 to 2024-05-07/);
  assert.match(html, /7 Days/);

  // 3. No Calendar caution message
  assert.doesNotMatch(html, /Calendar caution/i);

  // 4 & 5. Integrated Possible Explanation inside Confirmed Findings; no "Why it matters" or "Next check"
  assert.match(html, /Confirmed Finding:/);
  assert.match(html, /Possible Explanation:/);
  assert.doesNotMatch(html, /Why it matters/i);
  assert.doesNotMatch(html, /Next check:/i);

  // 6. General comparison period range is NOT repeated inside individual Finding cards
  const findingsSectionHtml = html.slice(findingsIdx, html.indexOf('aria-label="Alerts and Notifications"'));
  assert.doesNotMatch(findingsSectionHtml, /2024-05-08 to 2024-05-14/, "Current period date range must not repeat inside individual Findings");
  assert.doesNotMatch(findingsSectionHtml, /2024-05-01 to 2024-05-07/, "Reference period date range must not repeat inside individual Findings");
});

test("18. Weekday vs weekend Smart Comparison never emits Calendar caution and shows 1 Day duration dynamically", async () => {
  clearFindingInvestigationCache();
  // 2024-01-01 is Monday (weekday), 2023-12-31 is Sunday (weekend)
  const rows: Array<Record<string, unknown>> = [
    { order_date: "2023-12-31", category: "Retail", revenue: 1000, cost: 500, quantity: 10, status: "completed" },
    { order_date: "2024-01-01", category: "Retail", revenue: 700, cost: 450, quantity: 8, status: "completed" }
  ];
  const profile = profileTestRows("monday_vs_sunday", rows);
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-01-01",
    periodEnd: "2024-01-01",
    comparisonPreset: "previous_day"
  });

  assert.equal(unified.tools.smartComparison?.weekdayNote, null, "Weekday vs weekend must not generate Calendar caution");
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

  assert.doesNotMatch(html, /Calendar caution/i);
  assert.match(html, /monday_vs_sunday/);
  assert.match(html, /2024-01-01 to 2024-01-01/);
  assert.match(html, /2023-12-31 to 2023-12-31/);
  assert.match(html, /1 Day/);
});

test("17. Caching & memoization prevent unnecessary repeated calculations across and within runs", () => {
  clearFindingInvestigationCache();
  assert.equal(getFindingInvestigationCacheSize(), 0);

  const rows = buildSalesMarginDropFixture();
  const profile = profileTestRows("cache_sales", rows);

  // Run 1: populates cache
  const firstRun = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-08",
    periodEnd: "2024-05-14",
    comparisonPreset: "previous_7_days",
    useInvestigationCache: true
  });
  const firstInvs = firstRun.tools.intelligenceBrief?.investigations || [];
  assert.ok(firstInvs.length > 0);
  assert.ok(getFindingInvestigationCacheSize() >= firstInvs.length);

  // Run 2 (identical dataset & window): all investigations should be served from cache
  const secondRun = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-08",
    periodEnd: "2024-05-14",
    comparisonPreset: "previous_7_days",
    useInvestigationCache: true
  });
  const secondInvs = secondRun.tools.intelligenceBrief?.investigations || [];
  assert.equal(secondInvs.length, firstInvs.length);
  assert.ok(secondInvs.every(inv => inv.reusedFromCache === true), "Identical re-run should reuse cached investigation results");
});
