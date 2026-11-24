import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Database from "better-sqlite3";
import { profileRowsSnapshot, type BusinessDomainId, type ReadOnlyQueryExecutor } from "../profiler";
import { runDynamicAnalysisFromRows, runDynamicAnalysisWithExecutor } from "../metrics";
import { compareArchivedReports, runUnifiedDailyAnalysisFromRows } from "../intelligence";
import {
  assertValidPdfBuffer,
  buildPdfMetadataFromRecord,
  renderValidatedPdfForPayload,
  resolveManualReportPeriod,
  SqliteReportRepository,
  toArchivedReportFromPersistent,
  type PersistentReportRecord
} from "../storage";
import {
  buildReportHistoryQueryString,
  canCompareArchivedReports,
  computeHistoricalCoverageSummary,
  DEFAULT_REPORT_HISTORY_FILTERS,
  extractHistoricalSeriesOptions,
  extractSignificantHistoricalChanges,
  isReportPdfDownloadable,
  MANUAL_QUICK_RANGE_OPTIONS,
  validateManualRangeSelection
} from "../components/dashboard-helpers";

// Register test-only React global and CSS Module stub for Node SSR component tests under tsx
(globalThis as unknown as { React: typeof React }).React = React;
const requireFromTest = createRequire(import.meta.url);
const ModuleCtor = requireFromTest("node:module") as { _extensions?: Record<string, (mod: { exports: unknown }) => void> };
if (ModuleCtor._extensions) {
  ModuleCtor._extensions[".css"] = (mod: { exports: unknown }) => {
    const classProxy = new Proxy({}, { get: (_target, prop) => String(prop) });
    mod.exports = { __esModule: true, default: classProxy };
  };
}

const migrationDir = path.join(process.cwd(), "daily_data_analysis_and_notification", "database", "migrations");

function openTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "querypilot-stage7-"));
  const db = new Database(path.join(dir, "app.sqlite"));
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(migrationDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(path.join(migrationDir, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(Number(name.split("_", 1)[0]), name);
  }
  return {
    repository: new SqliteReportRepository(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("Historical Dashboard adapts to all 7 business domains over default 30-day window without leaking Sales KPIs", async () => {
  const { default: HistoricalDashboardPanel } = await import("../components/HistoricalDashboardPanel");

  const cases: Array<{
    domainId: BusinessDomainId;
    tableName: string;
    columns: Array<{ name: string; dataType: string; isPrimaryKey?: boolean }>;
    rows: Array<Record<string, unknown>>;
    forbiddenMetricIds: string[];
  }> = [
    {
      domainId: "sales_ecommerce",
      tableName: "sales_orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "total_revenue", dataType: "numeric" },
        { name: "category", dataType: "text" }
      ],
      rows: [
        { order_id: "S1", order_date: "2026-10-10", total_revenue: 900, category: "Electronics" },
        { order_id: "S2", order_date: "2026-11-10", total_revenue: 1500, category: "Electronics" },
        { order_id: "S3", order_date: "2026-11-20", total_revenue: 700, category: "Home" }
      ],
      forbiddenMetricIds: []
    },
    {
      domainId: "inventory_supply_chain",
      tableName: "warehouse_stock",
      columns: [
        { name: "sku_id", dataType: "text" },
        { name: "snapshot_date", dataType: "date" },
        { name: "stock_on_hand", dataType: "integer" },
        { name: "reorder_point", dataType: "integer" },
        { name: "warehouse_name", dataType: "text" }
      ],
      rows: [
        { sku_id: "SKU-1", snapshot_date: "2026-11-01", stock_on_hand: 40, reorder_point: 20, warehouse_name: "Dhaka" },
        { sku_id: "SKU-1", snapshot_date: "2026-11-20", stock_on_hand: 10, reorder_point: 20, warehouse_name: "Dhaka" }
      ],
      forbiddenMetricIds: ["totalRevenue", "averageOrderValue"]
    },
    {
      domainId: "marketing_campaigns",
      tableName: "ad_campaigns",
      columns: [
        { name: "campaign_id", dataType: "text" },
        { name: "campaign_date", dataType: "date" },
        { name: "ad_spend", dataType: "numeric" },
        { name: "impressions", dataType: "integer" },
        { name: "clicks", dataType: "integer" },
        { name: "conversions", dataType: "integer" },
        { name: "channel", dataType: "text" }
      ],
      rows: [
        { campaign_id: "M1", campaign_date: "2026-11-05", ad_spend: 300, impressions: 10000, clicks: 400, conversions: 20, channel: "Search" },
        { campaign_id: "M2", campaign_date: "2026-11-18", ad_spend: 500, impressions: 15000, clicks: 650, conversions: 35, channel: "Social" }
      ],
      forbiddenMetricIds: ["totalRevenue", "cancellationRate"]
    },
    {
      domainId: "finance_expenses",
      tableName: "ledger_entries",
      columns: [
        { name: "ledger_id", dataType: "text", isPrimaryKey: true },
        { name: "posting_date", dataType: "date" },
        { name: "amount", dataType: "numeric" },
        { name: "transaction_type", dataType: "text" },
        { name: "department", dataType: "text" }
      ],
      rows: [
        { ledger_id: "F1", posting_date: "2026-11-04", amount: 8000, transaction_type: "income", department: "Sales" },
        { ledger_id: "F2", posting_date: "2026-11-19", amount: 3200, transaction_type: "expense", department: "Engineering" }
      ],
      forbiddenMetricIds: ["averageOrderValue", "cancellationRate"]
    },
    {
      domainId: "customers_crm",
      tableName: "crm_accounts",
      columns: [
        { name: "customer_id", dataType: "text", isPrimaryKey: true },
        { name: "signup_date", dataType: "date" },
        { name: "last_activity_at", dataType: "date" },
        { name: "customer_segment", dataType: "text" },
        { name: "customer_status", dataType: "text" },
        { name: "total_spent", dataType: "numeric" }
      ],
      rows: [
        { customer_id: "C1", signup_date: "2026-11-02", last_activity_at: "2026-11-20", customer_segment: "Enterprise", customer_status: "Active", total_spent: 4500 },
        { customer_id: "C2", signup_date: "2026-11-12", last_activity_at: "2026-11-19", customer_segment: "SMB", customer_status: "Churned", total_spent: 500 }
      ],
      forbiddenMetricIds: ["averageOrderValue", "cancellationRate"]
    },
    {
      domainId: "operations_fulfillment",
      tableName: "shipments",
      columns: [
        { name: "shipment_id", dataType: "text", isPrimaryKey: true },
        { name: "order_created_at", dataType: "timestamptz" },
        { name: "shipped_at", dataType: "timestamptz" },
        { name: "delivered_at", dataType: "timestamptz" },
        { name: "promised_date", dataType: "timestamptz" },
        { name: "fulfillment_status", dataType: "text" },
        { name: "carrier", dataType: "text" }
      ],
      rows: [
        { shipment_id: "OP1", order_created_at: "2026-11-10T08:00:00Z", shipped_at: "2026-11-10T12:00:00Z", delivered_at: "2026-11-12T10:00:00Z", promised_date: "2026-11-13T10:00:00Z", fulfillment_status: "Delivered", carrier: "DHL" },
        { shipment_id: "OP2", order_created_at: "2026-11-18T08:00:00Z", shipped_at: "2026-11-18T14:00:00Z", delivered_at: "2026-11-21T18:00:00Z", promised_date: "2026-11-20T10:00:00Z", fulfillment_status: "Delivered", carrier: "FedEx" }
      ],
      forbiddenMetricIds: ["totalRevenue", "averageOrderValue"]
    },
    {
      domainId: "product_usage_saas",
      tableName: "saas_events",
      columns: [
        { name: "user_id", dataType: "text" },
        { name: "event_timestamp", dataType: "timestamptz" },
        { name: "feature_name", dataType: "text" },
        { name: "subscription_id", dataType: "text" },
        { name: "subscription_status", dataType: "text" },
        { name: "billing_interval", dataType: "text" },
        { name: "mrr", dataType: "numeric" }
      ],
      rows: [
        { user_id: "U1", event_timestamp: "2026-11-05T10:00:00Z", feature_name: "Reports", subscription_id: "SUB1", subscription_status: "active", billing_interval: "monthly", mrr: 199 },
        { user_id: "U2", event_timestamp: "2026-11-20T12:00:00Z", feature_name: "Alerts", subscription_id: "SUB2", subscription_status: "active", billing_interval: "monthly", mrr: 99 }
      ],
      forbiddenMetricIds: ["totalRevenue", "cancellationRate"]
    }
  ];

  for (const item of cases) {
    const profile = profileRowsSnapshot({ name: item.tableName, columns: item.columns }, item.rows);
    const analysis = runDynamicAnalysisFromRows(profile, item.rows, {
      domainId: item.domainId,
      periodStart: "2026-10-25",
      periodEnd: "2026-11-23",
      comparisonPreset: "previous_30_days"
    });

    assert.equal(analysis.domainId, item.domainId);
    assert.ok(analysis.availableMetrics.length >= 1, `${item.domainId} should compute at least 1 metric`);
    const ids = new Set(analysis.availableMetrics.map(m => m.metricId));
    for (const forbidden of item.forbiddenMetricIds) {
      assert.ok(!ids.has(forbidden), `${item.domainId} must not include irrelevant Sales metric ${forbidden}`);
    }

    // Verify SSR rendering of HistoricalDashboardPanel for each domain
    const html = renderToStaticMarkup(React.createElement(HistoricalDashboardPanel, {
      selectedDomain: item.domainId,
      selectedDataset: item.tableName,
      timezone: "Asia/Dhaka",
      earliestAvailableDate: "2026-10-01",
      latestAvailableDate: "2026-11-23",
      quickRange: "last_30_days",
      customStart: "",
      customEnd: "",
      analysis,
      loading: false,
      error: null,
      lastAnalyzedAt: analysis.generatedAt,
      onRangeChange: () => undefined,
      onRefresh: () => undefined
    }));
    assert.match(html, /Dynamic Historical Dashboard/);
    assert.match(html, /Last 30 Days/);
    assert.match(html, /Refresh/);
  }
});

test("Historical Dashboard handles empty/incomplete datasets, all 6 ranges, coverage summary, and large DB aggregation", async () => {
  const { default: HistoricalDashboardPanel } = await import("../components/HistoricalDashboardPanel");

  // All 6 historical ranges resolve cleanly
  const now = new Date("2026-11-24T04:00:00.000Z");
  assert.deepEqual(
    MANUAL_QUICK_RANGE_OPTIONS.map(o => o.value),
    ["last_7_days", "last_30_days", "last_90_days", "last_365_days", "all_history", "custom"]
  );
  const last30 = resolveManualReportPeriod({ quickRange: "last_30_days", timezone: "Asia/Dhaka", now });
  assert.equal(last30.periodStart, "2026-10-26");
  assert.equal(last30.periodEnd, "2026-11-24");
  const allHist = resolveManualReportPeriod({
    quickRange: "all_history",
    timezone: "Asia/Dhaka",
    earliestAvailableDate: "2025-03-01",
    latestAvailableDate: "2026-11-23",
    now
  });
  assert.equal(allHist.periodStart, "2025-03-01");
  assert.equal(allHist.periodEnd, "2026-11-23");

  // Invalid custom date range rejected
  const badCustom = validateManualRangeSelection({
    quickRange: "custom",
    startDate: "2026-11-20",
    endDate: "2026-11-10",
    timezone: "Asia/Dhaka",
    now
  });
  assert.equal(badCustom.valid, false);

  // Empty dataset renders honest empty-period notice without fabricating zeros
  const emptyProfile = profileRowsSnapshot({
    name: "empty_orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" }
    ]
  }, []);
  const emptyAnalysis = runDynamicAnalysisFromRows(emptyProfile, [], {
    domainId: "sales_ecommerce",
    periodStart: "2026-10-25",
    periodEnd: "2026-11-23",
    comparisonPreset: "previous_30_days"
  });
  const coverage = computeHistoricalCoverageSummary(emptyAnalysis);
  assert.equal(coverage.isEmpty, true);
  assert.equal(coverage.observedDays, 0);
  assert.equal(coverage.missingDays, 30);
  assert.equal(extractHistoricalSeriesOptions(emptyAnalysis).length, 0);
  assert.equal(extractSignificantHistoricalChanges(emptyAnalysis).length, 0);

  const emptyHtml = renderToStaticMarkup(React.createElement(HistoricalDashboardPanel, {
    selectedDomain: "sales_ecommerce",
    selectedDataset: "empty_orders",
    timezone: "Asia/Dhaka",
    earliestAvailableDate: null,
    latestAvailableDate: null,
    quickRange: "last_30_days",
    customStart: "",
    customEnd: "",
    analysis: emptyAnalysis,
    loading: false,
    error: null,
    lastAnalyzedAt: emptyAnalysis.generatedAt,
    onRangeChange: () => undefined,
    onRefresh: () => undefined
  }));
  assert.match(emptyHtml, /No source records found/);

  // High-volume >25k-row historical aggregation uses database_aggregate without loading raw rows
  const highVolExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "big_orders", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "big_orders", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
        { table_schema: "public", table_name: "big_orders", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) {
      return [{ table_schema: "public", table_name: "big_orders", constraint_name: "big_orders_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id" }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) return [{ row_count: 80000 }];
    if (sql.includes("c0_non_null")) {
      return [{ c0_non_null: 80000, c0_distinct: 80000, c1_non_null: 80000, c1_distinct: 60, c1_min: "2026-09-25", c1_max: "2026-11-23", c2_non_null: 80000, c2_distinct: 1000, c2_min: 5, c2_max: 900, c2_avg: 80, c2_neg: 0, c2_zero: 0, c2_int_only: false }];
    }
    if (sql.includes("AS dup_check")) return [{ duplicate_groups: 0, duplicate_rows: 0 }];
    if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) return [{ row_count: 40000 }];
    if (sql.includes("AS _agg_row_count")) {
      return [
        { order_date: "2026-10-15", _agg_row_count: 20000, _agg_distinct_entities: 20000, total_revenue: 500000 },
        { order_date: "2026-11-15", _agg_row_count: 20000, _agg_distinct_entities: 20000, total_revenue: 650000 }
      ];
    }
    return [];
  };
  const { analysis: aggAnalysis } = await runDynamicAnalysisWithExecutor(highVolExecutor, "big_orders", {
    domainId: "sales_ecommerce",
    periodStart: "2026-10-25",
    periodEnd: "2026-11-23",
    comparisonPreset: "previous_30_days"
  });
  assert.equal(aggAnalysis.source.executionMode, "database_aggregate");
  assert.ok(aggAnalysis.availableMetrics.some(m => m.metricId === "totalRevenue" && m.value === 650000));
});

test("Report History supports search, date/type/domain/status filtering, pagination, PDF gating, and tenant isolation", async () => {
  const { repository, cleanup } = openTempRepo();
  const { default: ReportHistoryPanel } = await import("../components/ReportHistoryPanel");

  try {
    const makeRecord = (overrides: Partial<Omit<PersistentReportRecord, "createdAt">>): Omit<PersistentReportRecord, "createdAt"> => ({
      id: "rep-default",
      organizationId: "org_one",
      ownerRef: "user_1",
      domainId: "sales_ecommerce",
      domainName: "Sales & E-commerce",
      datasetTable: "daily_sales",
      reportingDate: "2026-11-22",
      periodStart: "2026-11-22",
      periodEnd: "2026-11-22",
      comparisonStart: "2026-11-21",
      comparisonEnd: "2026-11-21",
      comparisonPreset: "previous_day",
      frequency: "daily",
      generationType: "automatic",
      executionKey: null,
      status: "generated",
      summaryText: "Revenue up 12% in Dhaka region",
      reportPayload: {},
      pdfStatus: "generated",
      pdfStorageKey: "org_one/rep-default/report.pdf",
      pdfFilename: "report.pdf",
      pdfGeneratedAt: "2026-11-23T00:15:00Z",
      pdfSizeBytes: 24500,
      pdfError: null,
      errorMessage: null,
      generatedAt: "2026-11-23T00:15:00Z",
      ...overrides
    });

    await repository.saveReport(makeRecord({ id: "rep-1", reportingDate: "2026-11-23", frequency: "daily", summaryText: "Dhaka revenue surge" }));
    await repository.saveReport(makeRecord({ id: "rep-2", reportingDate: "2026-11-22", frequency: "weekly", domainId: "inventory_supply_chain", domainName: "Inventory & Supply Chain", datasetTable: "warehouse_stock", summaryText: "Low stock alert in Chattogram" }));
    await repository.saveReport(makeRecord({ id: "rep-3", reportingDate: "2026-11-20", frequency: "monthly", domainId: "marketing_campaigns", domainName: "Marketing & Campaigns", datasetTable: "ad_campaigns", pdfStatus: "not_generated", pdfStorageKey: null, summaryText: "Pending monthly campaign PDF" }));
    await repository.saveReport(makeRecord({ id: "rep-4", reportingDate: "2026-11-18", frequency: "manual", generationType: "manual", status: "failed", pdfStatus: "failed", pdfStorageKey: null, errorMessage: "Source timeout", summaryText: "Manual report failed" }));
    await repository.saveReport(makeRecord({ id: "rep-5", reportingDate: "2026-09-01", frequency: "monthly", summaryText: "Older September archive" }));
    // Tenant 2 report must NEVER leak to org_one
    await repository.saveReport(makeRecord({ id: "rep-org2", organizationId: "org_two", reportingDate: "2026-11-23", summaryText: "Dhaka confidential tenant two" }));

    // Tenant isolation & default 30-day window
    const defaultList = await repository.listReports({ organizationId: "org_one", referenceDate: "2026-11-24" });
    assert.equal(defaultList.total, 4);
    assert.ok(defaultList.items.every(i => i.organizationId === "org_one"));
    assert.equal(await repository.getReportById("org_two", "rep-1"), null);

    // Search across summary/table/domain with tenant isolation
    const searchRes = await repository.listReports({ organizationId: "org_one", defaultDays: 0, search: "Dhaka" });
    assert.equal(searchRes.total, 1);
    assert.equal(searchRes.items[0].id, "rep-1");

    // Status filters: generated / pending / failed
    const pendingRes = await repository.listReports({ organizationId: "org_one", defaultDays: 0, status: "pending" });
    assert.equal(pendingRes.total, 1);
    assert.equal(pendingRes.items[0].id, "rep-3");

    const failedRes = await repository.listReports({ organizationId: "org_one", defaultDays: 0, status: "failed" });
    assert.equal(failedRes.total, 1);
    assert.equal(failedRes.items[0].id, "rep-4");

    // Frequency & domain filters
    const weeklyInv = await repository.listReports({ organizationId: "org_one", defaultDays: 0, frequency: "weekly", domainId: "inventory_supply_chain" });
    assert.equal(weeklyInv.total, 1);
    assert.equal(weeklyInv.items[0].id, "rep-2");

    // Pagination (pageSize=2 across 5 total records -> 3 pages)
    const page1 = await repository.listReports({ organizationId: "org_one", defaultDays: 0, page: 1, pageSize: 2 });
    const page3 = await repository.listReports({ organizationId: "org_one", defaultDays: 0, page: 3, pageSize: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.totalPages, 3);
    assert.equal(page1.items.length, 2);
    assert.equal(page3.items.length, 1);
    assert.equal(page3.items[0].id, "rep-5");

    // Query string helper
    const qs = buildReportHistoryQueryString({
      ...DEFAULT_REPORT_HISTORY_FILTERS,
      search: "Dhaka",
      frequency: "daily",
      domainId: "sales_ecommerce",
      status: "generated",
      includeAllDates: true,
      page: 2,
      pageSize: 20
    });
    assert.match(qs, /search=Dhaka/);
    assert.match(qs, /frequency=daily/);
    assert.match(qs, /all=true/);
    assert.match(qs, /page=2/);

    // PDF download gating: ONLY genuinely generated PDFs are downloadable
    assert.equal(isReportPdfDownloadable(defaultList.items.find(i => i.id === "rep-1")), true);
    assert.equal(isReportPdfDownloadable(defaultList.items.find(i => i.id === "rep-3")), false);
    assert.equal(isReportPdfDownloadable(defaultList.items.find(i => i.id === "rep-4")), false);

    // SSR rendering of ReportHistoryPanel reflects PDF gating cleanly
    const html = renderToStaticMarkup(React.createElement(ReportHistoryPanel, {
      reports: defaultList.items,
      pagination: { total: defaultList.total, page: 1, pageSize: 10, totalPages: 1, appliedStartDate: defaultList.appliedStartDate, appliedEndDate: defaultList.appliedEndDate },
      filters: DEFAULT_REPORT_HISTORY_FILTERS,
      loading: false,
      error: null,
      warning: null,
      timezone: "Asia/Dhaka",
      downloadingReportId: null,
      comparison: null,
      comparing: false,
      compareError: null,
      inspectedReport: null,
      loadingInspect: false,
      onFiltersChange: () => undefined,
      onRefresh: () => undefined,
      onInspectReport: async () => undefined,
      onCloseInspect: () => undefined,
      onCompareReports: async () => undefined,
      onClearComparison: () => undefined,
      onDownloadPdf: async () => undefined
    }));
    assert.match(html, /Report History/);
    assert.match(html, /No PDF/);
    assert.match(html, /Pending PDF/);
    assert.match(html, /PDF Failed/);
  } finally {
    cleanup();
  }
});

test("Archived report comparison computes deltas, renders side-by-side UI, and generates valid comparison PDF", async () => {
  const { repository, cleanup } = openTempRepo();
  const { default: ReportHistoryPanel } = await import("../components/ReportHistoryPanel");

  try {
    const rows = [
      { order_id: "O1", order_date: "2026-11-10", total_revenue: 1000, unit_cost: 600, category: "Electronics" },
      { order_id: "O2", order_date: "2026-11-20", total_revenue: 1600, unit_cost: 900, category: "Electronics" }
    ];
    const profile = profileRowsSnapshot({
      name: "orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "total_revenue", dataType: "numeric" },
        { name: "unit_cost", dataType: "numeric" },
        { name: "category", dataType: "text" }
      ]
    }, rows);

    const u1 = runUnifiedDailyAnalysisFromRows(profile, rows, { domainId: "sales_ecommerce", periodStart: "2026-11-10", periodEnd: "2026-11-10", comparisonPreset: "none" });
    const u2 = runUnifiedDailyAnalysisFromRows(profile, rows, { domainId: "sales_ecommerce", periodStart: "2026-11-20", periodEnd: "2026-11-20", comparisonPreset: "none" });

    const r1 = await repository.saveReport({
      id: "cmp-left",
      organizationId: "org_cmp",
      ownerRef: "u1",
      domainId: "sales_ecommerce",
      domainName: "Sales & E-commerce",
      datasetTable: "orders",
      reportingDate: "2026-11-10",
      periodStart: "2026-11-10",
      periodEnd: "2026-11-10",
      comparisonStart: null,
      comparisonEnd: null,
      comparisonPreset: "none",
      frequency: "daily",
      generationType: "automatic",
      executionKey: null,
      status: "generated",
      summaryText: "Nov 10 report",
      reportPayload: u1 as unknown as Record<string, unknown>,
      pdfStatus: "generated",
      pdfStorageKey: "org_cmp/cmp-left/r1.pdf",
      pdfFilename: "r1.pdf",
      pdfGeneratedAt: "2026-11-11T00:15:00Z",
      pdfSizeBytes: 15000,
      pdfError: null,
      errorMessage: null,
      generatedAt: "2026-11-11T00:15:00Z"
    });
    const r2 = await repository.saveReport({
      id: "cmp-right",
      organizationId: "org_cmp",
      ownerRef: "u1",
      domainId: "sales_ecommerce",
      domainName: "Sales & E-commerce",
      datasetTable: "orders",
      reportingDate: "2026-11-20",
      periodStart: "2026-11-20",
      periodEnd: "2026-11-20",
      comparisonStart: null,
      comparisonEnd: null,
      comparisonPreset: "none",
      frequency: "daily",
      generationType: "automatic",
      executionKey: null,
      status: "generated",
      summaryText: "Nov 20 report",
      reportPayload: u2 as unknown as Record<string, unknown>,
      pdfStatus: "generated",
      pdfStorageKey: "org_cmp/cmp-right/r2.pdf",
      pdfFilename: "r2.pdf",
      pdfGeneratedAt: "2026-11-21T00:15:00Z",
      pdfSizeBytes: 16000,
      pdfError: null,
      errorMessage: null,
      generatedAt: "2026-11-21T00:15:00Z"
    });

    assert.equal(canCompareArchivedReports(r1, r2).allowed, true);
    assert.equal(canCompareArchivedReports(r1, r1).allowed, false);

    const comparison = compareArchivedReports(
      toArchivedReportFromPersistent(r1),
      toArchivedReportFromPersistent(r2)
    );
    assert.equal(comparison.compatible, true);
    const revRow = comparison.metrics.find(m => m.metricId === "totalRevenue");
    assert.ok(revRow);
    assert.equal(revRow.leftValue, 1000);
    assert.equal(revRow.rightValue, 1600);
    assert.equal(revRow.absoluteDelta, 600);
    assert.equal(revRow.changePercent, 60);

    // Generate valid Comparison PDF via Stage 5 dynamic PDF builder
    const pdfBytes = await renderValidatedPdfForPayload(r2.reportPayload, "automatic", {
      metadata: buildPdfMetadataFromRecord(r2, "Org Cmp"),
      archivedComparison: comparison
    });
    assertValidPdfBuffer(pdfBytes);

    // Side-by-side comparison renders cleanly in ReportHistoryPanel
    const list = await repository.listReports({ organizationId: "org_cmp", defaultDays: 0 });
    const html = renderToStaticMarkup(React.createElement(ReportHistoryPanel, {
      reports: list.items,
      pagination: { total: 2, page: 1, pageSize: 10, totalPages: 1, appliedStartDate: null, appliedEndDate: null },
      filters: DEFAULT_REPORT_HISTORY_FILTERS,
      loading: false,
      error: null,
      warning: null,
      timezone: "Asia/Dhaka",
      downloadingReportId: null,
      comparison,
      comparing: false,
      compareError: null,
      inspectedReport: r2,
      loadingInspect: false,
      onFiltersChange: () => undefined,
      onRefresh: () => undefined,
      onInspectReport: async () => undefined,
      onCloseInspect: () => undefined,
      onCompareReports: async () => undefined,
      onClearComparison: () => undefined,
      onDownloadPdf: async () => undefined
    }));
    assert.match(html, /Compatible Comparison/);
    assert.match(html, /Download Comparison PDF/);
    assert.match(html, /Persisted Report Details/);
    assert.match(html, /\+60\.0%/);
  } finally {
    cleanup();
  }
});
