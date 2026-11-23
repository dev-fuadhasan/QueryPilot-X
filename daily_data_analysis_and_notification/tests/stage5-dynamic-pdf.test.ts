import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { profileRowsSnapshot, type BusinessDomainId, type ReadOnlyQueryExecutor } from "../profiler";
import {
  compareArchivedReports,
  runUnifiedDailyAnalysisFromRows,
  runUnifiedDailyAnalysisWithExecutor,
  toArchivedReportFromDynamic
} from "../intelligence";
import {
  renderDynamicAnalysisPdf,
  type DynamicPdfReportInput,
  type HistoricalContextBundle,
  type PdfReportMetadata
} from "../pdf/report-pdf";
import {
  assertValidPdfBuffer,
  evaluateVercelCronCompatibility,
  generateAndPersistManualReport,
  getDefaultDailySettings,
  LocalPrivatePdfStorage,
  runScheduledReports,
  SqliteReportRepository,
  UnconfiguredProductionPdfStorage
} from "../storage";

const migrationDir = path.join(process.cwd(), "daily_data_analysis_and_notification", "database", "migrations");

function makeMeta(overrides: Partial<PdfReportMetadata> = {}): PdfReportMetadata {
  return {
    reportId: "rep-stage5-001",
    organizationLabel: "Acme Global Commerce & Logistics Holdings International Ltd",
    domainId: "sales_ecommerce",
    domainName: "Sales & E-commerce",
    datasetTable: "daily_sales_orders",
    generationType: "automatic",
    frequency: "daily",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    periodLabel: "2026-11-21",
    comparisonStart: "2026-11-20",
    comparisonEnd: "2026-11-20",
    comparisonLabel: "Previous day (2026-11-20)",
    timezone: "Asia/Dhaka",
    generatedAt: "2026-11-22T00:15:00.000Z",
    ...overrides
  };
}

function pdfPageCount(buffer: Buffer): number {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

test("Daily Sales PDF includes cover, 7 tools, vector charts, and separately labelled 30-day Historical Context", async () => {
  const salesRows = [
    { order_id: "O-1", order_date: "2026-11-10", product_name: "Enterprise Ultra-Wide Curved Monitor 49-Inch Series X", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 1200, unit_cost: 700, discount_amount: 50, order_status: "Completed" },
    { order_id: "O-2", order_date: "2026-11-20", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 2, total_revenue: 1800, unit_cost: 1000, discount_amount: 100, order_status: "Completed" },
    { order_id: "O-3", order_date: "2026-11-21", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 700, unit_cost: 650, discount_amount: 20, order_status: "Completed" },
    { order_id: "O-4", order_date: "2026-11-21", product_name: "Chair", category: "Furniture", region: "Chattogram", sales_channel: "POS", quantity: 1, total_revenue: 300, unit_cost: 150, discount_amount: 0, order_status: "Cancelled" }
  ];
  const profile = profileRowsSnapshot({
    name: "daily_sales_orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "product_name", dataType: "text" },
      { name: "category", dataType: "text" },
      { name: "region", dataType: "text" },
      { name: "sales_channel", dataType: "text" },
      { name: "quantity", dataType: "integer" },
      { name: "total_revenue", dataType: "numeric" },
      { name: "unit_cost", dataType: "numeric" },
      { name: "discount_amount", dataType: "numeric" },
      { name: "order_status", dataType: "text" }
    ]
  }, salesRows);

  const dailyUnified = runUnifiedDailyAnalysisFromRows(profile, salesRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  const ctx30Unified = runUnifiedDailyAnalysisFromRows(profile, salesRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-10-23",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });

  const historicalContext: HistoricalContextBundle = {
    label: "Previous 30-Day Context",
    periodStart: "2026-10-23",
    periodEnd: "2026-11-21",
    dayCount: 30,
    rowCount: ctx30Unified.analysis.source.rowCountInPeriod,
    metrics: ctx30Unified.analysis.availableMetrics,
    timeSeries: ctx30Unified.analysis.timeSeries,
    breakdowns: ctx30Unified.analysis.breakdowns,
    sourceNote: "Separate 30-day historical dashboard context alongside the primary daily period (2026-11-21)."
  };

  // Optional archived report comparison
  const baselineArchive = toArchivedReportFromDynamic(
    runUnifiedDailyAnalysisFromRows(profile, salesRows, {
      domainId: "sales_ecommerce",
      periodStart: "2026-11-20",
      periodEnd: "2026-11-20",
      comparisonPreset: "none"
    }).analysis
  );
  const archivedComparison = compareArchivedReports(baselineArchive, toArchivedReportFromDynamic(dailyUnified.analysis));

  const pdfInput: DynamicPdfReportInput = {
    metadata: makeMeta(),
    unified: dailyUnified,
    historicalContext,
    archivedComparison
  };

  const buffer = await renderDynamicAnalysisPdf(pdfInput);
  assertValidPdfBuffer(buffer);
  // Multi-page structured PDF (cover + sections + historical charts + archive comparison)
  assert.ok(pdfPageCount(buffer) >= 3, `Expected multi-page PDF, got ${pdfPageCount(buffer)} page(s)`);
});

test("Generates valid dynamic PDFs across Weekly, Monthly, and Manual Custom ranges for all 7 business domains", async () => {
  const domainCases: Array<{
    domainId: BusinessDomainId;
    domainName: string;
    frequency: PdfReportMetadata["frequency"];
    generationType: PdfReportMetadata["generationType"];
    periodStart: string;
    periodEnd: string;
    tableName: string;
    columns: Array<{ name: string; dataType: string; isPrimaryKey?: boolean }>;
    rows: Array<Record<string, unknown>>;
  }> = [
    {
      domainId: "sales_ecommerce",
      domainName: "Sales & E-commerce",
      frequency: "weekly",
      generationType: "automatic",
      periodStart: "2026-11-16",
      periodEnd: "2026-11-22",
      tableName: "orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "total_revenue", dataType: "numeric" },
        { name: "category", dataType: "text" }
      ],
      rows: [
        { order_id: "W1", order_date: "2026-11-16", total_revenue: 400, category: "Electronics" },
        { order_id: "W2", order_date: "2026-11-22", total_revenue: 650, category: "Furniture" }
      ]
    },
    {
      domainId: "sales_ecommerce",
      domainName: "Sales & E-commerce",
      frequency: "monthly",
      generationType: "automatic",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      tableName: "orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "total_revenue", dataType: "numeric" }
      ],
      rows: [
        { order_id: "M1", order_date: "2026-10-05", total_revenue: 1200 },
        { order_id: "M2", order_date: "2026-10-25", total_revenue: 1900 }
      ]
    },
    {
      domainId: "inventory_supply_chain",
      domainName: "Inventory & Supply Chain",
      frequency: "manual",
      generationType: "manual",
      periodStart: "2026-11-15",
      periodEnd: "2026-11-21",
      tableName: "warehouse_inventory",
      columns: [
        { name: "sku_id", dataType: "text" },
        { name: "snapshot_date", dataType: "date" },
        { name: "stock_on_hand", dataType: "integer" },
        { name: "reorder_point", dataType: "integer" },
        { name: "quantity_sold", dataType: "integer" },
        { name: "warehouse_name", dataType: "text" },
        { name: "supplier_name", dataType: "text" }
      ],
      rows: [
        { sku_id: "SKU-1", snapshot_date: "2026-11-15", stock_on_hand: 50, reorder_point: 20, quantity_sold: 10, warehouse_name: "Dhaka Hub", supplier_name: "Apex" },
        { sku_id: "SKU-1", snapshot_date: "2026-11-21", stock_on_hand: 15, reorder_point: 20, quantity_sold: 25, warehouse_name: "Dhaka Hub", supplier_name: "Apex" }
      ]
    },
    {
      domainId: "marketing_campaigns",
      domainName: "Marketing & Campaigns",
      frequency: "daily",
      generationType: "automatic",
      periodStart: "2026-11-21",
      periodEnd: "2026-11-21",
      tableName: "marketing_campaigns",
      columns: [
        { name: "campaign_id", dataType: "text" },
        { name: "campaign_date", dataType: "date" },
        { name: "campaign_name", dataType: "text" },
        { name: "channel", dataType: "text" },
        { name: "ad_spend", dataType: "numeric" },
        { name: "impressions", dataType: "integer" },
        { name: "clicks", dataType: "integer" },
        { name: "conversions", dataType: "integer" },
        { name: "attributed_revenue", dataType: "numeric" }
      ],
      rows: [
        { campaign_id: "C1", campaign_date: "2026-11-20", campaign_name: "Search Ads", channel: "Google", ad_spend: 200, impressions: 5000, clicks: 150, conversions: 15, attributed_revenue: 800 },
        { campaign_id: "C1", campaign_date: "2026-11-21", campaign_name: "Search Ads", channel: "Google", ad_spend: 350, impressions: 6000, clicks: 140, conversions: 8, attributed_revenue: 300 }
      ]
    },
    {
      domainId: "finance_expenses",
      domainName: "Finance & Expenses",
      frequency: "monthly",
      generationType: "automatic",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-21",
      tableName: "finance_ledger",
      columns: [
        { name: "ledger_id", dataType: "text", isPrimaryKey: true },
        { name: "posting_date", dataType: "date" },
        { name: "amount", dataType: "numeric" },
        { name: "transaction_type", dataType: "text" },
        { name: "expense_category", dataType: "text" },
        { name: "department", dataType: "text" },
        { name: "payment_status", dataType: "text" },
        { name: "due_date", dataType: "date" },
        { name: "budget_amount", dataType: "numeric" }
      ],
      rows: [
        { ledger_id: "L1", posting_date: "2026-11-10", amount: 5000, transaction_type: "income", expense_category: "Subscription", department: "Sales", payment_status: "paid", due_date: "2026-11-10", budget_amount: 0 },
        { ledger_id: "L2", posting_date: "2026-11-18", amount: 2200, transaction_type: "expense", expense_category: "Cloud Infrastructure", department: "Engineering", payment_status: "unpaid", due_date: "2026-11-12", budget_amount: 1800 }
      ]
    },
    {
      domainId: "customers_crm",
      domainName: "Customers & CRM",
      frequency: "weekly",
      generationType: "automatic",
      periodStart: "2026-11-16",
      periodEnd: "2026-11-22",
      tableName: "customers_crm",
      columns: [
        { name: "customer_id", dataType: "text", isPrimaryKey: true },
        { name: "signup_date", dataType: "date" },
        { name: "last_activity_at", dataType: "date" },
        { name: "customer_segment", dataType: "text" },
        { name: "customer_status", dataType: "text" },
        { name: "total_spent", dataType: "numeric" }
      ],
      rows: [
        { customer_id: "U1", signup_date: "2026-11-01", last_activity_at: "2026-11-20", customer_segment: "Enterprise", customer_status: "Active", total_spent: 1500 },
        { customer_id: "U2", signup_date: "2026-11-18", last_activity_at: "2026-11-21", customer_segment: "SMB", customer_status: "Churned", total_spent: 200 }
      ]
    },
    {
      domainId: "operations_fulfillment",
      domainName: "Operations & Fulfillment",
      frequency: "daily",
      generationType: "automatic",
      periodStart: "2026-11-21",
      periodEnd: "2026-11-21",
      tableName: "fulfillment_shipments",
      columns: [
        { name: "shipment_id", dataType: "text", isPrimaryKey: true },
        { name: "order_created_at", dataType: "timestamptz" },
        { name: "shipped_at", dataType: "timestamptz" },
        { name: "delivered_at", dataType: "timestamptz" },
        { name: "promised_date", dataType: "timestamptz" },
        { name: "fulfillment_status", dataType: "text" },
        { name: "carrier", dataType: "text" },
        { name: "region", dataType: "text" }
      ],
      rows: [
        { shipment_id: "S1", order_created_at: "2026-11-21T08:00:00Z", shipped_at: "2026-11-21T10:00:00Z", delivered_at: "2026-11-23T10:00:00Z", promised_date: "2026-11-22T10:00:00Z", fulfillment_status: "Delivered", carrier: "DHL", region: "Dhaka" },
        { shipment_id: "S2", order_created_at: "2026-11-21T09:00:00Z", shipped_at: "2026-11-21T11:00:00Z", delivered_at: null, promised_date: "2026-11-24T10:00:00Z", fulfillment_status: "Pending", carrier: "FedEx", region: "Chattogram" }
      ]
    },
    {
      domainId: "product_usage_saas",
      domainName: "Product Usage & SaaS Analytics",
      frequency: "daily",
      generationType: "automatic",
      periodStart: "2026-11-21",
      periodEnd: "2026-11-21",
      tableName: "product_events",
      columns: [
        { name: "user_id", dataType: "text" },
        { name: "event_timestamp", dataType: "timestamptz" },
        { name: "feature_name", dataType: "text" },
        { name: "event_name", dataType: "text" },
        { name: "subscription_id", dataType: "text" },
        { name: "subscription_status", dataType: "text" },
        { name: "billing_interval", dataType: "text" },
        { name: "mrr", dataType: "numeric" },
        { name: "plan_tier", dataType: "text" }
      ],
      rows: [
        { user_id: "P1", event_timestamp: "2026-11-18T10:00:00Z", feature_name: "Daily Reports", event_name: "onboarding_complete", subscription_id: "SUB1", subscription_status: "active", billing_interval: "monthly", mrr: 99, plan_tier: "Pro" },
        { user_id: "P1", event_timestamp: "2026-11-21T10:00:00Z", feature_name: "Daily Alerts", event_name: "onboarding_complete", subscription_id: "SUB1", subscription_status: "active", billing_interval: "monthly", mrr: 99, plan_tier: "Pro" },
        { user_id: "P2", event_timestamp: "2026-11-21T11:00:00Z", feature_name: "PDF Export", event_name: "export_pdf", subscription_id: "SUB2", subscription_status: "cancelled", billing_interval: "monthly", mrr: 49, plan_tier: "Starter" }
      ]
    }
  ];

  for (const c of domainCases) {
    const profile = profileRowsSnapshot({ name: c.tableName, columns: c.columns }, c.rows);
    const unified = runUnifiedDailyAnalysisFromRows(profile, c.rows, {
      domainId: c.domainId,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      comparisonPreset: "previous_day",
      activationEventName: c.domainId === "product_usage_saas" ? "onboarding_complete" : undefined
    });

    const buffer = await renderDynamicAnalysisPdf({
      metadata: makeMeta({
        domainId: c.domainId,
        domainName: c.domainName,
        datasetTable: c.tableName,
        frequency: c.frequency,
        generationType: c.generationType,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
        periodLabel: c.periodStart === c.periodEnd ? c.periodStart : `${c.periodStart} to ${c.periodEnd}`
      }),
      unified
    });

    assertValidPdfBuffer(buffer);
    assert.ok(pdfPageCount(buffer) >= 2, `${c.domainId} PDF should have at least 2 pages`);
  }
});

test("Handles empty datasets, missing required fields, and long labels cleanly without fabricating metrics or crashing", async () => {
  const emptyProfile = profileRowsSnapshot({
    name: "minimal_orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true }
    ]
  }, []);
  const unified = runUnifiedDailyAnalysisFromRows(emptyProfile, [], {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  const buffer = await renderDynamicAnalysisPdf({
    metadata: makeMeta({
      organizationLabel: "Very Long International Multi-Regional Enterprise Commerce & Supply Chain Organisation Holdings Group PLC (Dhaka HQ)",
      datasetTable: "minimal_orders"
    }),
    unified
  });
  assertValidPdfBuffer(buffer);
  assert.equal(unified.analysis.availableMetrics.length, 0);
});

test("Scheduled Daily report automatically embeds 30-day Historical Context and saves validated private PDF", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "querypilot-stage5-"));
  const db = new Database(path.join(dir, "app.sqlite"));
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(migrationDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(path.join(migrationDir, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(Number(name.split("_", 1)[0]), name);
  }
  const repository = new SqliteReportRepository(db);
  const pdfStorage = new LocalPrivatePdfStorage(path.join(dir, "private-pdfs"));

  try {
    await repository.saveSettings({
      ...getDefaultDailySettings("org_stage5"),
      selectedDomain: "sales_ecommerce",
      selectedDataset: "orders",
      autoReportEnabled: true,
      frequency: "daily",
      scheduledTime: "00:15",
      timezone: "Asia/Dhaka"
    });

    const mockExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
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
      if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) return [{ row_count: 3 }];
      if (sql.includes("c0_non_null")) {
        return [{ c0_non_null: 3, c0_distinct: 3, c1_non_null: 3, c1_distinct: 3, c1_min: "2026-11-01", c1_max: "2026-11-21", c2_non_null: 3, c2_distinct: 3, c2_min: 100, c2_max: 500, c2_avg: 300, c2_neg: 0, c2_zero: 0, c2_int_only: true, c3_non_null: 3, c3_distinct: 2 }];
      }
      if (sql.includes("SELECT DISTINCT LOWER")) return [{ token: "dhaka" }, { token: "sylhet" }];
      if (sql.includes("AS dup_check")) return [{ duplicate_groups: 0, duplicate_rows: 0 }];
      if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) return [{ row_count: 3 }];
      if (sql.includes("ORDER BY \"order_date\" ASC LIMIT")) {
        return [
          { order_id: "O-1", order_date: "2026-11-05", total_revenue: 400, region: "Dhaka" },
          { order_id: "O-2", order_date: "2026-11-20", total_revenue: 500, region: "Dhaka" },
          { order_id: "O-3", order_date: "2026-11-21", total_revenue: 300, region: "Sylhet" }
        ];
      }
      return [];
    };

    const runResult = await runScheduledReports({
      repository,
      pdfStorage,
      resolveSourceExecutor: async () => mockExecutor,
      now: new Date("2026-11-22T02:00:00.000Z")
    });
    assert.equal(runResult.outcomes[0]?.status, "generated");
    const saved = await repository.getReportById("org_stage5", runResult.outcomes[0].reportId!);
    assert.ok(saved);
    // Primary period stays 2026-11-21 (NOT silently changed to 30 days!)
    assert.equal(saved.periodStart, "2026-11-21");
    assert.equal(saved.periodEnd, "2026-11-21");
    // Separate 30-day Historical Context preserved inside trusted server payload
    const histCtx = saved.reportPayload.historicalContext as HistoricalContextBundle;
    assert.ok(histCtx);
    assert.equal(histCtx.dayCount, 30);
    assert.equal(histCtx.periodStart, "2026-10-23");
    assert.equal(histCtx.periodEnd, "2026-11-21");

    // Private PDF verified on disk
    assert.equal(saved.pdfStatus, "generated");
    const bytes = await pdfStorage.readPdf(saved.pdfStorageKey!);
    assert.ok(bytes);
    assertValidPdfBuffer(bytes);
    assert.ok(pdfPageCount(bytes) >= 3);

    // Manual report with missing production storage fails clearly (never fakes permanent save)
    const unconfiguredManual = await generateAndPersistManualReport({
      organizationId: "org_stage5",
      executor: mockExecutor,
      repository,
      pdfStorage: new UnconfiguredProductionPdfStorage(),
      tableName: "orders",
      domainId: "sales_ecommerce",
      quickRange: "custom",
      startDate: "2026-11-20",
      endDate: "2026-11-21",
      now: new Date("2026-11-22T02:00:00.000Z")
    });
    assert.equal(unconfiguredManual.record.pdfStatus, "failed");
    assert.match(unconfiguredManual.record.pdfError || "", /not configured for production/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Vercel Cron configuration & Hobby scheduling limitation validation", () => {
  const vercelRaw = readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");
  const vercelConfig = JSON.parse(vercelRaw) as {
    services?: Record<string, unknown>;
    rewrites?: unknown[];
    crons?: Array<{ path: string; schedule: string }>;
  };

  // Preserves existing services and rewrites
  assert.ok(vercelConfig.services?.web);
  assert.ok(vercelConfig.services?.plots);
  assert.ok(Array.isArray(vercelConfig.rewrites) && vercelConfig.rewrites.length >= 2);

  // Valid Hobby-compatible once-per-day cron expression configured
  assert.ok(Array.isArray(vercelConfig.crons) && vercelConfig.crons.length === 1);
  assert.equal(vercelConfig.crons[0].path, "/api/daily-analysis/scheduler/run");
  assert.equal(vercelConfig.crons[0].schedule, "15 18 * * *");

  const dailyCheck = evaluateVercelCronCompatibility(vercelConfig.crons[0].schedule);
  assert.equal(dailyCheck.valid, true);
  assert.equal(dailyCheck.hobbyCompatible, true);
  assert.equal(dailyCheck.runsPerDayEstimate, 1);
  assert.match(dailyCheck.precisionLimitation, /within the scheduled UTC hour/);

  // Hourly expression is properly flagged as Hobby-incompatible
  const hourlyCheck = evaluateVercelCronCompatibility("0 * * * *");
  assert.equal(hourlyCheck.valid, true);
  assert.equal(hourlyCheck.hobbyCompatible, false);
  assert.equal(hourlyCheck.runsPerDayEstimate, 24);
});

test("High-volume (>25,000 rows) database-aggregated Root Cause Analysis renders valid PDF with causality disclaimer", async () => {
  const highVolumeExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "large_orders", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "large_orders", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
        { table_schema: "public", table_name: "large_orders", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
        { table_schema: "public", table_name: "large_orders", table_type: "BASE TABLE", column_name: "category", data_type: "text", udt_name: "text", is_nullable: "YES" },
        { table_schema: "public", table_name: "large_orders", table_type: "BASE TABLE", column_name: "region", data_type: "text", udt_name: "text", is_nullable: "YES" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) {
      return [{ table_schema: "public", table_name: "large_orders", constraint_name: "large_orders_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id" }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) return [{ row_count: 60000 }];
    if (sql.includes("c0_non_null")) {
      return [{ c0_non_null: 60000, c0_distinct: 60000, c1_non_null: 60000, c1_distinct: 30, c1_min: "2026-10-25", c1_max: "2026-11-21", c2_non_null: 60000, c2_distinct: 500, c2_min: 10, c2_max: 2000, c2_avg: 120, c2_neg: 0, c2_zero: 0, c2_int_only: false, c3_non_null: 60000, c3_distinct: 3, c4_non_null: 60000, c4_distinct: 2 }];
    }
    if (sql.includes("SELECT DISTINCT LOWER")) return [{ token: "electronics" }, { token: "apparel" }];
    if (sql.includes("AS dup_check")) return [{ duplicate_groups: 0, duplicate_rows: 0 }];
    if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) return [{ row_count: 30000 }];
    if (sql.includes("AS _agg_row_count")) {
      return [
        { order_date: "2026-11-20", _agg_row_count: 15000, _agg_distinct_entities: 15000, total_revenue: 150000 },
        { order_date: "2026-11-21", _agg_row_count: 15000, _agg_distinct_entities: 15000, total_revenue: 90000 }
      ];
    }
    if (sql.includes("AS dim_value")) {
      if (sql.includes("\"category\"")) {
        return [
          { period_bucket: "comparison", dim_value: "Electronics", row_count: 10000, metric_sum: 110000 },
          { period_bucket: "current", dim_value: "Electronics", row_count: 8000, metric_sum: 55000 },
          { period_bucket: "comparison", dim_value: "Apparel", row_count: 5000, metric_sum: 40000 },
          { period_bucket: "current", dim_value: "Apparel", row_count: 7000, metric_sum: 35000 }
        ];
      }
      if (sql.includes("\"region\"")) {
        return [
          { period_bucket: "comparison", dim_value: "Dhaka", row_count: 9000, metric_sum: 100000 },
          { period_bucket: "current", dim_value: "Dhaka", row_count: 7000, metric_sum: 50000 },
          { period_bucket: "comparison", dim_value: "Chattogram", row_count: 6000, metric_sum: 50000 },
          { period_bucket: "current", dim_value: "Chattogram", row_count: 8000, metric_sum: 40000 }
        ];
      }
    }
    return [];
  };

  const unified = await runUnifiedDailyAnalysisWithExecutor(highVolumeExecutor, "large_orders", {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  assert.equal(unified.analysis.source.executionMode, "database_aggregate");
  assert.equal(unified.tools.rootCause?.available, true);
  assert.ok((unified.tools.rootCause?.analyses.length ?? 0) >= 1);
  assert.ok((unified.tools.rootCause?.causalityDisclaimer.length ?? 0) > 10);

  const buffer = await renderDynamicAnalysisPdf({
    metadata: makeMeta({ datasetTable: "large_orders" }),
    unified
  });
  assertValidPdfBuffer(buffer);
  assert.ok(pdfPageCount(buffer) >= 2);
});
