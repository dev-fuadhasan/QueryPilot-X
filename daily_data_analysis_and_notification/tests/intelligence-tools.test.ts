import assert from "node:assert/strict";
import test from "node:test";
import { profileRowsSnapshot, understandTableForDomain, type ReadOnlyQueryExecutor } from "../profiler";
import { runDynamicAnalysisFromRows } from "../metrics";
import {
  DEFAULT_ALERT_RULES,
  evaluateDynamicAnalysisAlerts,
  mergeAlerts
} from "../notifications";
import {
  buildActionableRecommendations,
  buildDailyIntelligenceBrief,
  buildDataHealthReport,
  buildRootCauseAnalysis,
  buildSmartDayComparison,
  compareArchivedReports,
  filterArchivedReports,
  runUnifiedDailyAnalysisFromRows,
  runUnifiedDailyAnalysisWithExecutor,
  toArchivedReportFromDynamic
} from "../intelligence";

const salesColumns = [
  { name: "order_id", dataType: "text", isPrimaryKey: true },
  { name: "order_date", dataType: "date" },
  { name: "product_name", dataType: "text" },
  { name: "category", dataType: "text" },
  { name: "region", dataType: "text" },
  { name: "sales_channel", dataType: "text" },
  { name: "quantity", dataType: "integer" },
  { name: "total_revenue", dataType: "numeric" },
  { name: "unit_cost", dataType: "numeric" },
  { name: "order_status", dataType: "text" }
];

test("Daily Intelligence Brief: produces verified findings, distinguishes certainty, and handles insufficient data honestly", () => {
  const rows = [
    // Comparison day: 2026-11-20 (1000 revenue)
    { order_id: "O-1", order_date: "2026-11-20", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 800, unit_cost: 500, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-20", product_name: "Mouse", category: "Electronics", region: "Chattogram", sales_channel: "POS", quantity: 2, total_revenue: 200, unit_cost: 50, order_status: "Completed" },
    // Current day: 2026-11-21 (500 revenue -> -50% drop, unusual swing!)
    { order_id: "O-3", order_date: "2026-11-21", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 300, unit_cost: 280, order_status: "Completed" },
    { order_id: "O-4", order_date: "2026-11-21", product_name: "Mouse", category: "Electronics", region: "Chattogram", sales_channel: "POS", quantity: 2, total_revenue: 200, unit_cost: 50, order_status: "Completed" }
  ];

  const profile = profileRowsSnapshot({ name: "sales_orders", columns: salesColumns }, rows);
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  const brief = unified.tools.intelligenceBrief!;
  assert.equal(brief.status, "ready");
  const revFinding = brief.negativeHighlights.find(f => f.metricId === "totalRevenue" && f.certainty === "confirmed");
  assert.ok(revFinding);
  assert.ok(brief.unusualActivities.some(f => f.metricId === "totalRevenue" && f.certainty === "possible_explanation"));
  assert.ok(revFinding.whatHappened.includes("500"));
  assert.ok(revFinding.investigateNext.length > 0);

  // Insufficient data (empty period) MUST NOT invent trends
  const emptyBrief = buildDailyIntelligenceBrief(
    runDynamicAnalysisFromRows(profile, [], {
      domainId: "sales_ecommerce",
      periodStart: "2026-11-21",
      periodEnd: "2026-11-21",
      comparisonPreset: "previous_day"
    })
  );
  assert.equal(emptyBrief.status, "insufficient_data");
  assert.equal(emptyBrief.positiveHighlights.length, 0);
  assert.equal(emptyBrief.negativeHighlights.length, 0);
  assert.ok(emptyBrief.executiveSummary.includes("No unsupported business trends"));
});

test("Smart Day Comparison: supports same-weekday, missing historical period, and zero-baseline safeguards", () => {
  const rows = [
    // Previous Saturday (2026-11-14) and current Saturday (2026-11-21)
    { order_id: "O-1", order_date: "2026-11-14", product_name: "Desk", category: "Furniture", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 400, unit_cost: 200, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-21", product_name: "Desk", category: "Furniture", region: "Dhaka", sales_channel: "Web", quantity: 2, total_revenue: 600, unit_cost: 200, order_status: "Completed" }
  ];
  const profile = profileRowsSnapshot({ name: "sales_orders", columns: salesColumns }, rows);

  // Same-weekday comparison
  const sameWeekdayAnalysis = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "same_weekday_previous_weeks"
  });
  const smartWeekday = buildSmartDayComparison(sameWeekdayAnalysis);
  assert.equal(smartWeekday.comparable, true);
  assert.equal(smartWeekday.mode, "same_weekday_previous_weeks");
  assert.ok(smartWeekday.weekdayNote?.includes("Saturday"));

  // Missing historical comparison period
  const noHistoryAnalysis = runDynamicAnalysisFromRows(profile, [rows[1]], {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  const smartNoHistory = buildSmartDayComparison(noHistoryAnalysis);
  assert.equal(smartNoHistory.comparable, false);
  assert.ok(smartNoHistory.statusReason?.includes("Insufficient historical data"));

  // Zero baseline
  const zeroBaseRows = [
    { order_id: "O-0", order_date: "2026-11-20", product_name: "Desk", category: "Furniture", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 0, unit_cost: 0, order_status: "Completed" },
    rows[1]
  ];
  const zeroAnalysis = runDynamicAnalysisFromRows(profile, zeroBaseRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  const smartZero = buildSmartDayComparison(zeroAnalysis);
  const revRow = smartZero.metrics.find(m => m.metricId === "totalRevenue");
  assert.equal(revRow?.baselineStatus, "zero_baseline");
  assert.equal(revRow?.changePercent, null);
});

test("Existing Alerts upgraded for all domains: triggers domain-specific alerts, prevents duplicates, ignores unavailable metrics, preserves read status", () => {
  // Marketing domain alerts: spend spike + ROAS deterioration + conversion decline
  const mktRows = [
    { campaign_id: "C-1", campaign_date: "2026-11-20", campaign_name: "Promo", channel: "Meta", ad_spend: 100, clicks: 100, conversions: 20, attributed_revenue: 400 },
    { campaign_id: "C-1", campaign_date: "2026-11-21", campaign_name: "Promo", channel: "Meta", ad_spend: 300, clicks: 80, conversions: 5, attributed_revenue: 250 }
  ];
  const mktProfile = profileRowsSnapshot({
    name: "marketing_campaigns",
    columns: [
      { name: "campaign_id", dataType: "text" },
      { name: "campaign_date", dataType: "date" },
      { name: "campaign_name", dataType: "text" },
      { name: "channel", dataType: "text" },
      { name: "ad_spend", dataType: "numeric" },
      { name: "clicks", dataType: "integer" },
      { name: "conversions", dataType: "integer" },
      { name: "attributed_revenue", dataType: "numeric" }
    ]
  }, mktRows);
  const mktAnalysis = runDynamicAnalysisFromRows(mktProfile, mktRows, {
    domainId: "marketing_campaigns",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  const mktAlerts = evaluateDynamicAnalysisAlerts(mktAnalysis, DEFAULT_ALERT_RULES);
  assert.ok(mktAlerts.some(a => a.code === "SPEND_SPIKE"));
  assert.ok(mktAlerts.some(a => a.code === "CONVERSION_DECLINE"));
  assert.ok(mktAlerts.some(a => a.code === "ROAS_DETERIORATION" && a.severity === "critical"));
  // Unavailable metric (leads, impressions) MUST NOT generate alerts
  assert.equal(mktAlerts.some(a => a.metricId === "leads" || a.metricId === "impressions"), false);

  // Deduplication and read-status preservation via existing mergeAlerts
  const readAlerts = mktAlerts.map(a => ({ ...a, isRead: true, acknowledgedAt: "2026-11-21T12:00:00Z" }));
  const merged = mergeAlerts(readAlerts, mktAlerts);
  assert.equal(merged.length, mktAlerts.length);
  assert.ok(merged.every(a => a.isRead === true && a.acknowledgedAt === "2026-11-21T12:00:00Z"));
});

test("Root Cause Analysis: computes additive group contributions, handles single-period groups, includes causality disclaimer, handles missing dimensions", () => {
  const rows = [
    // Comparison day (2026-11-20): Dhaka 700, Chattogram 300 (total 1000)
    { order_id: "O-1", order_date: "2026-11-20", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 700, unit_cost: 400, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-20", product_name: "Desk", category: "Furniture", region: "Chattogram", sales_channel: "POS", quantity: 1, total_revenue: 300, unit_cost: 150, order_status: "Completed" },
    // Current day (2026-11-21): Dhaka 200 (-500), Sylhet 100 (+100 new), Chattogram 0 (-300 disappeared) => total 300 (-700)
    { order_id: "O-3", order_date: "2026-11-21", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 200, unit_cost: 120, order_status: "Completed" },
    { order_id: "O-4", order_date: "2026-11-21", product_name: "Chair", category: "Furniture", region: "Sylhet", sales_channel: "Web", quantity: 1, total_revenue: 100, unit_cost: 50, order_status: "Completed" }
  ];

  const profile = profileRowsSnapshot({ name: "sales_orders", columns: salesColumns }, rows);
  const understanding = understandTableForDomain(profile, "sales_ecommerce", { isSelectedDomain: true });
  const analysis = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  const rc = buildRootCauseAnalysis({
    analysis,
    understanding,
    periodRows: rows.slice(2),
    comparisonRows: rows.slice(0, 2),
    period: analysis.reportingPeriod,
    comparison: analysis.comparisonPeriod
  });

  assert.equal(rc.available, true);
  assert.ok(rc.causalityDisclaimer.includes("does not prove underlying causation"));
  const revRc = rc.analyses.find(a => a.metricId === "totalRevenue")!;
  assert.equal(revRc.totalDelta, -700);
  // Dhaka (-500) is largest negative regional contributor; Sylhet (+100) is current_only positive contributor; Chattogram (-300) is comparison_only
  const dhaka = revRc.negativeContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Dhaka");
  const chattogram = revRc.negativeContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Chattogram");
  const sylhet = revRc.positiveContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Sylhet");
  assert.equal(dhaka?.absoluteDelta, -500);
  assert.equal(chattogram?.appearance, "comparison_only");
  assert.equal(sylhet?.appearance, "current_only");

  // Missing breakdown dimensions => available: false with explanation
  const noDimProfile = profileRowsSnapshot({
    name: "orders_bare",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "total_revenue", dataType: "numeric" }
    ]
  }, rows);
  const noDimUnderstanding = understandTableForDomain(noDimProfile, "sales_ecommerce", { isSelectedDomain: true });
  const noDimAnalysis = runDynamicAnalysisFromRows(noDimProfile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  const noDimRc = buildRootCauseAnalysis({
    analysis: noDimAnalysis,
    understanding: noDimUnderstanding,
    periodRows: rows.slice(2),
    comparisonRows: rows.slice(0, 2),
    period: noDimAnalysis.reportingPeriod,
    comparison: noDimAnalysis.comparisonPeriod
  });
  assert.equal(noDimRc.available, false);
  assert.ok(noDimRc.unavailableReason?.includes("categorical breakdown columns"));
});

test("Actionable Recommendations: links recommendations to evidence, ranks priority, deduplicates, and returns empty when no issues exist", () => {
  const healthyRows = [
    { order_id: "O-1", order_date: "2026-11-20", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 500, unit_cost: 300, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-21", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 510, unit_cost: 300, order_status: "Completed" }
  ];
  const profile = profileRowsSnapshot({ name: "sales_orders", columns: salesColumns }, healthyRows, { now: new Date("2026-11-21T12:00:00Z") });
  const healthyUnified = runUnifiedDailyAnalysisFromRows(profile, healthyRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  // No evidence of problems => no generic filler recommendations!
  assert.equal(healthyUnified.tools.recommendations.length, 0);

  // Adverse scenario: sharp revenue drop + negative profit => prioritized, deduplicated, evidence-linked recommendations
  const badRows = [
    { order_id: "O-1", order_date: "2026-11-20", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 1000, unit_cost: 500, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-21", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 300, unit_cost: 450, order_status: "Completed" }
  ];
  const badProfile = profileRowsSnapshot({ name: "sales_orders", columns: salesColumns }, badRows, { now: new Date("2026-11-21T12:00:00Z") });
  const badUnified = runUnifiedDailyAnalysisFromRows(badProfile, badRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  const recs = badUnified.tools.recommendations;
  assert.ok(recs.length >= 2);
  assert.equal(recs[0].priority, "critical");
  // Revenue drop should appear ONCE (deduplicated across alert + root cause + comparison) and cite its top contributor
  assert.equal(recs.filter(r => r.metricId === "totalRevenue").length, 1);
  const revRec = recs.find(r => r.metricId === "totalRevenue");
  assert.ok(revRec?.affectedDimension?.includes("Laptop") || revRec?.affectedDimension?.includes("Dhaka"));
});

test("Data Health Monitor: checks nulls, duplicates, invalid dates, freshness, missing expected dates by cadence, and empty tables", () => {
  const dirtyRows = [
    { order_id: "O-1", order_date: "2026-11-10", total_revenue: 100 },
    { order_id: "O-1", order_date: "2026-11-10", total_revenue: null }, // duplicate key + 50% null revenue
    { order_id: "O-2", order_date: "bad-date", total_revenue: null }
  ];
  const dirtyProfile = profileRowsSnapshot({
    name: "orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "text" },
      { name: "total_revenue", dataType: "numeric" }
    ]
  }, dirtyRows, { now: new Date("2026-11-22T12:00:00Z") });

  const understanding = understandTableForDomain(dirtyProfile, "sales_ecommerce", { isSelectedDomain: true });
  const analysis = runDynamicAnalysisFromRows(dirtyProfile, dirtyRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-10",
    periodEnd: "2026-11-12",
    comparisonPreset: "none"
  });

  // Under "daily" cadence, missing dates 2026-11-11 & 2026-11-12 are flagged
  const healthDaily = buildDataHealthReport({ tableProfile: dirtyProfile, understanding, analysis, expectedCadence: "daily" });
  assert.ok(healthDaily.checks.some(c => c.id === "duplicate_records"));
  assert.ok(healthDaily.checks.some(c => c.id === "null_values"));
  assert.ok(healthDaily.checks.some(c => c.id === "invalid_values"));
  assert.ok(healthDaily.checks.some(c => c.id === "missing_expected_dates"));
  assert.deepEqual(healthDaily.historicalCoverage.expectedDatesMissing, ["2026-11-11", "2026-11-12"]);

  // Under "irregular" cadence, missing reporting dates are NOT falsely flagged
  const healthIrregular = buildDataHealthReport({ tableProfile: dirtyProfile, understanding, analysis, expectedCadence: "irregular" });
  assert.equal(healthIrregular.checks.some(c => c.id === "missing_expected_dates"), false);

  // Empty table
  const emptyProfile = profileRowsSnapshot({ name: "empty_orders", columns: salesColumns }, []);
  const emptyHealth = buildDataHealthReport({
    tableProfile: emptyProfile,
    understanding: understandTableForDomain(emptyProfile, "sales_ecommerce"),
    analysis: runDynamicAnalysisFromRows(emptyProfile, [], { domainId: "sales_ecommerce", periodStart: "2026-11-21", periodEnd: "2026-11-21", comparisonPreset: "none" })
  });
  assert.equal(emptyHealth.overallStatus, "critical");
  assert.ok(emptyHealth.checks.some(c => c.id === "empty_table"));
});

test("Report Archive & Comparison: compares two reports, detects newly available/unavailable metrics, rejects incompatible domains, and filters 30-day archive", () => {
  const rows1 = [{ order_id: "O-1", order_date: "2026-11-10", total_revenue: 500, order_status: "Completed" }];
  const rows2 = [{ order_id: "O-2", order_date: "2026-11-21", total_revenue: 750, unit_cost: 400, order_status: "Completed" }];

  const p1 = profileRowsSnapshot({
    name: "orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "total_revenue", dataType: "numeric" },
      { name: "order_status", dataType: "text" }
    ]
  }, rows1);
  const p2 = profileRowsSnapshot({
    name: "orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "total_revenue", dataType: "numeric" },
      { name: "unit_cost", dataType: "numeric" },
      { name: "order_status", dataType: "text" }
    ]
  }, rows2);

  const r1 = toArchivedReportFromDynamic(runDynamicAnalysisFromRows(p1, rows1, { domainId: "sales_ecommerce", periodStart: "2026-11-10", periodEnd: "2026-11-10", comparisonPreset: "none" }));
  const r2 = toArchivedReportFromDynamic(runDynamicAnalysisFromRows(p2, rows2, { domainId: "sales_ecommerce", periodStart: "2026-11-21", periodEnd: "2026-11-21", comparisonPreset: "none" }));

  const cmp = compareArchivedReports(r1, r2);
  assert.equal(cmp.compatible, true);
  assert.equal(cmp.periodDeltaDays, 11);
  const revDiff = cmp.metrics.find(m => m.metricId === "totalRevenue");
  assert.equal(revDiff?.absoluteDelta, 250);
  assert.equal(revDiff?.changePercent, 50);
  assert.ok(cmp.newlyAvailableMetrics.includes("Gross Profit"));

  // Incompatible domains rejected cleanly
  const invProfile = profileRowsSnapshot({
    name: "inventory",
    columns: [{ name: "sku_id", dataType: "text", isPrimaryKey: true }, { name: "snapshot_date", dataType: "date" }, { name: "stock_on_hand", dataType: "integer" }]
  }, [{ sku_id: "SKU-1", snapshot_date: "2026-11-21", stock_on_hand: 20 }]);
  const invReport = toArchivedReportFromDynamic(runDynamicAnalysisFromRows(invProfile, [{ sku_id: "SKU-1", snapshot_date: "2026-11-21", stock_on_hand: 20 }], { domainId: "inventory_supply_chain", periodStart: "2026-11-21", periodEnd: "2026-11-21", comparisonPreset: "none" }));

  const incompatible = compareArchivedReports(r1, invReport);
  assert.equal(incompatible.compatible, false);
  assert.ok(incompatible.incompatibilityReason?.includes("different business domains"));

  // Default 30-day archive window filter
  const oldReport = { ...r1, id: "old", reportingDate: "2026-09-01" };
  const filtered = filterArchivedReports([oldReport, r1, r2], { referenceDate: "2026-11-21", defaultDays: 30 });
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].reportingDate, "2026-11-21");
});

test("Unified Daily Analysis Service: isolates partial tool failures and runs in a single read-only database pass", async () => {
  const rows = [
    { order_id: "O-1", order_date: "2026-11-20", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 1000, unit_cost: 500, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-21", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 600, unit_cost: 300, order_status: "Completed" }
  ];
  const profile = profileRowsSnapshot({ name: "sales_orders", columns: salesColumns }, rows);

  // Fault isolation: if rootCause throws, all other 6 tools still succeed cleanly!
  const faulted = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day",
    toolOverrides: {
      rootCause: () => { throw new Error("Simulated root cause failure"); }
    }
  });
  assert.equal(faulted.partialFailures.length, 1);
  assert.equal(faulted.partialFailures[0].tool, "rootCause");
  assert.equal(faulted.tools.rootCause, null);
  assert.ok(faulted.tools.intelligenceBrief !== null);
  assert.ok(faulted.tools.smartComparison !== null);
  assert.ok(faulted.tools.alerts.length > 0);
  assert.ok(faulted.tools.dataHealth !== null);
  assert.ok(faulted.tools.reportArchive !== null);

  // Single-pass read-only DB executor test
  const executedSql: string[] = [];
  const mockExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
    executedSql.push(sql);
    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "region", data_type: "text", udt_name: "text", is_nullable: "YES" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) {
      return [{ table_schema: "public", table_name: "orders", constraint_name: "orders_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id" }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) return [{ row_count: 2 }];
    if (sql.includes("c0_non_null")) {
      return [{ c0_non_null: 2, c0_distinct: 2, c1_non_null: 2, c1_distinct: 2, c1_min: "2026-11-20", c1_max: "2026-11-21", c2_non_null: 2, c2_distinct: 2, c2_min: 600, c2_max: 1000, c2_avg: 800, c2_neg: 0, c2_zero: 0, c2_int_only: true, c3_non_null: 2, c3_distinct: 1 }];
    }
    if (sql.includes("SELECT DISTINCT LOWER")) return [{ token: "dhaka" }];
    if (sql.includes("AS dup_check")) return [{ duplicate_groups: 0, duplicate_rows: 0 }];
    if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) return [{ row_count: 2 }];
    if (sql.includes("ORDER BY \"order_date\" ASC LIMIT")) {
      return [
        { order_id: "O-1", order_date: "2026-11-20", total_revenue: 1000, region: "Dhaka" },
        { order_id: "O-2", order_date: "2026-11-21", total_revenue: 600, region: "Dhaka" }
      ];
    }
    return [];
  };

  const liveResult = await runUnifiedDailyAnalysisWithExecutor(mockExecutor, "orders", {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  // Verify ONLY ONE data fetch query executed for all 7 tools combined, and ZERO SELECT *
  assert.equal(executedSql.filter(q => q.includes("ORDER BY \"order_date\" ASC LIMIT")).length, 1);
  assert.ok(executedSql.every(q => !/SELECT\s+\*/i.test(q)));
  assert.equal(liveResult.partialFailures.length, 0);
  assert.equal(liveResult.tools.rootCause?.available, true);
  assert.ok(liveResult.tools.recommendations.length > 0);
});
