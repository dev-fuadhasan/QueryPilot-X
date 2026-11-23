import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ReadOnlyQueryExecutor } from "../profiler";
import { compareArchivedReports, runUnifiedDailyAnalysisWithExecutor } from "../intelligence";
import {
  assertValidPdfBuffer,
  buildScheduledExecutionKey,
  enumerateDuePeriods,
  generateAndPersistManualReport,
  getDefaultDailySettings,
  getPreviousCompletedPeriod,
  isScheduleDueNow,
  LocalPrivatePdfStorage,
  resolveManualReportPeriod,
  runScheduledReports,
  SqliteReportRepository,
  toArchivedReportFromPersistent,
  UnconfiguredProductionPdfStorage,
  validateAndMergeSettings,
  type PdfStorageAdapter
} from "../storage";

const migrationDir = path.join(process.cwd(), "daily_data_analysis_and_notification", "database", "migrations");

function createStorageFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "querypilot-stage4-"));
  const dbPath = path.join(dir, "app.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(migrationDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(path.join(migrationDir, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(Number(name.split("_", 1)[0]), name);
  }
  const repository = new SqliteReportRepository(db);
  const pdfStorage = new LocalPrivatePdfStorage(path.join(dir, "private-pdfs"));
  return {
    dir,
    db,
    repository,
    pdfStorage,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createSalesMockExecutor(options: { highVolume?: boolean } = {}): { executor: ReadOnlyQueryExecutor; executedSql: string[] } {
  const executedSql: string[] = [];
  const executor: ReadOnlyQueryExecutor = async (sql: string) => {
    executedSql.push(sql);

    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "region", data_type: "text", udt_name: "text", is_nullable: "YES" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "product_name", data_type: "text", udt_name: "text", is_nullable: "YES" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_status", data_type: "text", udt_name: "text", is_nullable: "YES" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) {
      return [{ table_schema: "public", table_name: "orders", constraint_name: "orders_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id" }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) {
      return [{ row_count: options.highVolume ? 42000 : 4 }];
    }
    if (sql.includes("c0_non_null")) {
      return [{
        c0_non_null: options.highVolume ? 42000 : 4, c0_distinct: options.highVolume ? 42000 : 4,
        c1_non_null: options.highVolume ? 42000 : 4, c1_distinct: 10, c1_min: "2026-10-01", c1_max: "2026-11-22",
        c2_non_null: options.highVolume ? 42000 : 4, c2_distinct: 500, c2_min: 10, c2_max: 2500, c2_avg: 300, c2_neg: 0, c2_zero: 0, c2_int_only: false,
        c3_non_null: options.highVolume ? 42000 : 4, c3_distinct: 3,
        c4_non_null: options.highVolume ? 42000 : 4, c4_distinct: 5,
        c5_non_null: options.highVolume ? 42000 : 4, c5_distinct: 2
      }];
    }
    if (sql.includes("SELECT DISTINCT LOWER(TRIM(CAST(\"order_status\"")) {
      return [{ token: "completed" }, { token: "cancelled" }];
    }
    if (sql.includes("SELECT DISTINCT LOWER(TRIM(CAST(\"region\"")) {
      return [{ token: "dhaka" }, { token: "chattogram" }, { token: "sylhet" }];
    }
    if (sql.includes("SELECT DISTINCT LOWER(TRIM(CAST(\"product_name\"")) {
      return [{ token: "laptop" }, { token: "mouse" }];
    }
    if (sql.includes("AS dup_check")) {
      return [{ duplicate_groups: 0, duplicate_rows: 0 }];
    }

    // Window count check
    if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) {
      return [{ row_count: options.highVolume ? 42000 : 4 }];
    }

    // High-volume daily aggregate rollup
    if (sql.includes("GROUP BY CAST(\"order_date\" AS DATE)")) {
      return [
        { order_date: "2026-11-20", _agg_row_count: 22000, total_revenue: 100000 },
        { order_date: "2026-11-21", _agg_row_count: 20000, total_revenue: 70000 }
      ];
    }

    // High-volume per-dimension GROUP BY queries for Root Cause Analysis
    if (sql.includes("AS group_label") && sql.includes("\"region\"")) {
      if (sql.includes("2026-11-21")) {
        return [
          { group_label: "Dhaka", metric_value: 40000, row_count: 11000 },
          { group_label: "Sylhet", metric_value: 15000, row_count: 5000 },
          { group_label: "Unspecified", metric_value: 15000, row_count: 4000 }
        ];
      }
      return [
        { group_label: "Dhaka", metric_value: 75000, row_count: 15000 },
        { group_label: "Chattogram", metric_value: 25000, row_count: 7000 }
      ];
    }
    if (sql.includes("AS group_label") && sql.includes("\"product_name\"")) {
      if (sql.includes("2026-11-21")) {
        return [
          { group_label: "Laptop", metric_value: 50000, row_count: 10000 },
          { group_label: "Mouse", metric_value: 20000, row_count: 10000 }
        ];
      }
      return [
        { group_label: "Laptop", metric_value: 85000, row_count: 15000 },
        { group_label: "Mouse", metric_value: 15000, row_count: 7000 }
      ];
    }

    // Standard scoped rows
    if (sql.includes("ORDER BY \"order_date\" ASC LIMIT")) {
      return [
        { order_id: "O-1", order_date: "2026-11-20", total_revenue: 800, region: "Dhaka", product_name: "Laptop", order_status: "Completed" },
        { order_id: "O-2", order_date: "2026-11-20", total_revenue: 200, region: "Chattogram", product_name: "Mouse", order_status: "Completed" },
        { order_id: "O-3", order_date: "2026-11-21", total_revenue: 600, region: "Dhaka", product_name: "Laptop", order_status: "Completed" },
        { order_id: "O-4", order_date: "2026-11-21", total_revenue: 300, region: "Sylhet", product_name: "Mouse", order_status: "Completed" }
      ];
    }

    return [];
  };
  return { executor, executedSql };
}

test("High-volume Root Cause (>25,000 rows): runs independent database-side GROUP BY per dimension without loading raw rows", async () => {
  const { executor, executedSql } = createSalesMockExecutor({ highVolume: true });

  const result = await runUnifiedDailyAnalysisWithExecutor(executor, "orders", {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  // Confirmed high-volume mode triggered (>25,000 rows) and ZERO SELECT * executed
  assert.equal(result.analysis.source.executionMode, "database_aggregate");
  assert.ok(executedSql.every(q => !/SELECT\s+\*/i.test(q)));
  assert.equal(executedSql.some(q => q.includes("ORDER BY \"order_date\" ASC LIMIT")), false);

  // Database-side GROUP BY queries ran independently for region and product_name
  const dimQueries = executedSql.filter(q => q.includes("AS group_label"));
  assert.ok(dimQueries.some(q => q.includes("\"region\"")));
  assert.ok(dimQueries.some(q => q.includes("\"product_name\"")));

  const rc = result.tools.rootCause!;
  assert.equal(rc.available, true);
  assert.ok(rc.causalityDisclaimer.includes("does not prove underlying causation"));
  const revRc = rc.analyses.find(a => a.metricId === "totalRevenue")!;
  assert.equal(revRc.totalDelta, -30000);
  assert.ok(revRc.investigatedDimensions.includes("Region / Branch"));
  assert.ok(revRc.investigatedDimensions.includes("Product"));

  // Verifies negative, comparison_only, current_only, and null ('Unspecified') groups
  const dhaka = revRc.negativeContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Dhaka");
  const chattogram = revRc.negativeContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Chattogram");
  const sylhet = revRc.positiveContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Sylhet");
  const unspecified = revRc.positiveContributors.find(c => c.dimensionId === "region" && c.groupLabel === "Unspecified");
  assert.equal(dhaka?.absoluteDelta, -35000);
  assert.equal(chattogram?.appearance, "comparison_only");
  assert.equal(sylhet?.appearance, "current_only");
  assert.equal(unspecified?.appearance, "current_only");
});

test("Scheduling periods: Daily, Weekly (Monday-Sunday), Monthly calendar boundaries & Asia/Dhaka timezone", () => {
  // 2026-11-22T18:15:00Z is 2026-11-23 00:15 in Asia/Dhaka (Monday!)
  const dhakaMondayMidnight = new Date("2026-11-22T18:15:00.000Z");

  const daily = getPreviousCompletedPeriod("daily", "Asia/Dhaka", dhakaMondayMidnight);
  assert.equal(daily.periodStart, "2026-11-22");
  assert.equal(daily.periodEnd, "2026-11-22");

  // Previous completed week before Monday 2026-11-23 is Monday 2026-11-16 .. Sunday 2026-11-22
  const weekly = getPreviousCompletedPeriod("weekly", "Asia/Dhaka", dhakaMondayMidnight);
  assert.equal(weekly.periodStart, "2026-11-16");
  assert.equal(weekly.periodEnd, "2026-11-22");

  // Monthly across year boundary: 2026-01-05 -> 2025-12-01..2025-12-31
  const janRun = getPreviousCompletedPeriod("monthly", "Asia/Dhaka", new Date("2026-01-05T02:00:00Z"));
  assert.equal(janRun.periodStart, "2025-12-01");
  assert.equal(janRun.periodEnd, "2025-12-31");

  // Monthly leap-year boundary: 2024-03-02 -> 2024-02-01..2024-02-29
  const leapRun = getPreviousCompletedPeriod("monthly", "Asia/Dhaka", new Date("2024-03-02T02:00:00Z"));
  assert.equal(leapRun.periodStart, "2024-02-01");
  assert.equal(leapRun.periodEnd, "2024-02-29");

  // Missed runs enumeration in chronological order
  const missed = enumerateDuePeriods("daily", "2026-11-19", "Asia/Dhaka", dhakaMondayMidnight);
  assert.deepEqual(missed.map(p => p.periodEnd), ["2026-11-20", "2026-11-21", "2026-11-22"]);

  // Schedule due check respects configured HH:mm in Asia/Dhaka
  assert.equal(
    isScheduleDueNow(
      { autoReportEnabled: true, frequency: "daily", scheduledTime: "00:15", timezone: "Asia/Dhaka" },
      "2026-11-21",
      new Date("2026-11-22T18:10:00.000Z") // 00:10 Dhaka -> NOT due yet
    ),
    false
  );
  assert.equal(
    isScheduleDueNow(
      { autoReportEnabled: true, frequency: "daily", scheduledTime: "00:15", timezone: "Asia/Dhaka" },
      "2026-11-21",
      new Date("2026-11-22T18:15:00.000Z") // 00:15 Dhaka -> DUE now
    ),
    true
  );
});

test("Persistent Storage, Settings, Tenant Isolation, Pagination, 30-day History & Report Comparison", async () => {
  const fixture = createStorageFixture();
  try {
    // Settings persistence & validation
    const orgADefault = getDefaultDailySettings("org_alpha");
    const validated = validateAndMergeSettings("org_alpha", {
      selectedDomain: "sales_ecommerce",
      selectedDataset: "orders",
      autoReportEnabled: true,
      frequency: "weekly",
      scheduledTime: "02:30",
      timezone: "Asia/Dhaka"
    }, orgADefault);
    const savedSettings = await fixture.repository.saveSettings(validated);
    assert.equal(savedSettings.frequency, "weekly");
    assert.equal(savedSettings.scheduledTime, "02:30");
    assert.equal((await fixture.repository.getSettings("org_alpha"))?.selectedDataset, "orders");
    assert.equal(await fixture.repository.getSettings("org_beta"), null);

    // Save reports across two tenants + an older (>30 days) report
    const { executor } = createSalesMockExecutor();
    const recentA = await generateAndPersistManualReport({
      organizationId: "org_alpha",
      executor,
      repository: fixture.repository,
      pdfStorage: fixture.pdfStorage,
      tableName: "orders",
      domainId: "sales_ecommerce",
      quickRange: "custom",
      startDate: "2026-11-21",
      endDate: "2026-11-21",
      now: new Date("2026-11-22T06:00:00Z")
    });
    const prevA = await generateAndPersistManualReport({
      organizationId: "org_alpha",
      executor,
      repository: fixture.repository,
      pdfStorage: fixture.pdfStorage,
      tableName: "orders",
      domainId: "sales_ecommerce",
      quickRange: "custom",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      now: new Date("2026-11-22T06:00:00Z")
    });
    const oldA = await generateAndPersistManualReport({
      organizationId: "org_alpha",
      executor,
      repository: fixture.repository,
      pdfStorage: fixture.pdfStorage,
      tableName: "orders",
      domainId: "sales_ecommerce",
      quickRange: "custom",
      startDate: "2026-09-15",
      endDate: "2026-09-15",
      now: new Date("2026-11-22T06:00:00Z")
    });
    const orgBReport = await generateAndPersistManualReport({
      organizationId: "org_beta",
      executor,
      repository: fixture.repository,
      pdfStorage: fixture.pdfStorage,
      tableName: "orders",
      domainId: "sales_ecommerce",
      quickRange: "custom",
      startDate: "2026-11-21",
      endDate: "2026-11-21",
      now: new Date("2026-11-22T06:00:00Z")
    });

    // Strict tenant isolation
    assert.equal(await fixture.repository.getReportById("org_alpha", orgBReport.record.id), null);
    assert.equal(await fixture.repository.getReportById("org_beta", recentA.record.id), null);

    // Default 30-day window excludes 2026-09-15, returns only 2 recent org_alpha reports
    const default30 = await fixture.repository.listReports({
      organizationId: "org_alpha",
      referenceDate: "2026-11-22"
    });
    assert.equal(default30.total, 2);
    assert.equal(default30.items.some(i => i.id === oldA.record.id), false);

    // Explicit all-dates + pagination retrieves older report cleanly
    const page1 = await fixture.repository.listReports({
      organizationId: "org_alpha",
      defaultDays: 0,
      page: 1,
      pageSize: 2
    });
    const page2 = await fixture.repository.listReports({
      organizationId: "org_alpha",
      defaultDays: 0,
      page: 2,
      pageSize: 2
    });
    assert.equal(page1.total, 3);
    assert.equal(page1.totalPages, 2);
    assert.equal(page1.items.length, 2);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].id, oldA.record.id);

    // PDF persisted privately and verified readable
    assert.equal(recentA.record.pdfStatus, "generated");
    assert.ok(recentA.record.pdfStorageKey);
    const pdfBytes = await fixture.pdfStorage.readPdf(recentA.record.pdfStorageKey!);
    assert.ok(pdfBytes);
    assertValidPdfBuffer(pdfBytes);

    // Persisted report comparison works via Stage 3 archive service
    const cmp = compareArchivedReports(
      toArchivedReportFromPersistent(prevA.record),
      toArchivedReportFromPersistent(recentA.record)
    );
    assert.equal(cmp.compatible, true);
    assert.equal(cmp.periodDeltaDays, 1);
  } finally {
    fixture.cleanup();
  }
});

test("Server-side Scheduler: prevents duplicates, enforces concurrency leases, retries failed PDF without duplicating report", async () => {
  const fixture = createStorageFixture();
  try {
    await fixture.repository.saveSettings({
      ...getDefaultDailySettings("org_sched"),
      selectedDomain: "sales_ecommerce",
      selectedDataset: "orders",
      autoReportEnabled: true,
      frequency: "daily",
      scheduledTime: "00:15",
      timezone: "Asia/Dhaka"
    });

    const { executor } = createSalesMockExecutor();
    const runNow = new Date("2026-11-22T02:00:00.000Z"); // 08:00 Asia/Dhaka on 2026-11-22 -> yesterday 2026-11-21

    // Simulate first run with failing PDF storage -> report saved, execution failed, PDF marked failed
    const failingPdfStorage: PdfStorageAdapter = {
      backendName: "local_private_fs",
      isProductionPersistent: false,
      async savePdf() { throw new Error("Simulated private storage outage"); },
      async readPdf() { return null; }
    };

    const firstAttempt = await runScheduledReports({
      repository: fixture.repository,
      pdfStorage: failingPdfStorage,
      resolveSourceExecutor: async () => executor,
      now: runNow
    });
    assert.equal(firstAttempt.outcomes[0]?.status, "failed");
    const execKey = buildScheduledExecutionKey({
      organizationId: "org_sched",
      frequency: "daily",
      periodStart: "2026-11-21",
      periodEnd: "2026-11-21",
      domainId: "sales_ecommerce",
      datasetTable: "orders"
    });
    assert.equal((await fixture.repository.getExecution(execKey))?.attemptCount, 1);
    assert.equal((await fixture.repository.getReportByExecutionKey("org_sched", execKey))?.pdfStatus, "failed");

    // Second attempt with healthy storage -> PDF-only retry succeeds WITHOUT duplicating the report!
    const retryAttempt = await runScheduledReports({
      repository: fixture.repository,
      pdfStorage: fixture.pdfStorage,
      resolveSourceExecutor: async () => executor,
      now: new Date("2026-11-22T02:20:00.000Z")
    });
    assert.equal(retryAttempt.outcomes[0]?.status, "retried_pdf");
    assert.equal((await fixture.repository.getExecution(execKey))?.status, "succeeded");
    assert.equal((await fixture.repository.getExecution(execKey))?.attemptCount, 2);

    const allReports = await fixture.repository.listReports({ organizationId: "org_sched", defaultDays: 0 });
    assert.equal(allReports.total, 1);
    assert.equal(allReports.items[0].pdfStatus, "generated");
    assert.equal(allReports.items[0].generationType, "automatic");

    // Third attempt for the same period -> skipped cleanly (idempotent, no duplicates)
    const thirdAttempt = await runScheduledReports({
      repository: fixture.repository,
      pdfStorage: fixture.pdfStorage,
      resolveSourceExecutor: async () => executor,
      now: new Date("2026-11-22T03:00:00.000Z")
    });
    assert.equal(thirdAttempt.outcomes.length, 0);

    // Concurrent lease protection check
    const leaseKey = "sched|org_sched|daily|2026-11-20|2026-11-20|sales_ecommerce|orders";
    const claim1 = await fixture.repository.claimExecution({
      executionKey: leaseKey,
      organizationId: "org_sched",
      scheduleId: "org_sched:daily",
      frequency: "daily",
      periodStart: "2026-11-20",
      periodEnd: "2026-11-20",
      now: runNow
    });
    const claim2 = await fixture.repository.claimExecution({
      executionKey: leaseKey,
      organizationId: "org_sched",
      scheduleId: "org_sched:daily",
      frequency: "daily",
      periodStart: "2026-11-20",
      periodEnd: "2026-11-20",
      now: runNow
    });
    assert.equal(claim1.outcome, "claimed");
    assert.equal(claim2.outcome, "in_progress");
  } finally {
    fixture.cleanup();
  }
});

test("Manual report quick ranges, invalid/future date rejection, and unconfigured production PDF storage fail-loudly", async () => {
  const ref = new Date("2026-11-22T06:00:00.000Z"); // 2026-11-22 Dhaka
  assert.equal(resolveManualReportPeriod({ quickRange: "last_7_days", timezone: "Asia/Dhaka", now: ref }).periodStart, "2026-11-16");
  assert.equal(resolveManualReportPeriod({ quickRange: "last_30_days", timezone: "Asia/Dhaka", now: ref }).periodStart, "2026-10-24");
  assert.equal(resolveManualReportPeriod({ quickRange: "last_90_days", timezone: "Asia/Dhaka", now: ref }).periodStart, "2026-08-25");
  assert.equal(resolveManualReportPeriod({ quickRange: "last_365_days", timezone: "Asia/Dhaka", now: ref }).periodStart, "2025-11-23");
  assert.equal(
    resolveManualReportPeriod({ quickRange: "all_history", earliestAvailableDate: "2025-01-10", latestAvailableDate: "2026-11-21", timezone: "Asia/Dhaka", now: ref }).periodStart,
    "2025-01-10"
  );
  assert.throws(() => resolveManualReportPeriod({ quickRange: "custom", startDate: "2026-11-25", endDate: "2026-11-20", now: ref }), /must not be after/);
  assert.throws(() => resolveManualReportPeriod({ quickRange: "custom", startDate: "2026-11-20", endDate: "2026-12-01", now: ref }), /cannot be in the future/);

  const unconfigured = new UnconfiguredProductionPdfStorage();
  await assert.rejects(
    () => unconfigured.savePdf({ organizationId: "org_1", reportId: "r_1", filename: "r.pdf", bytes: Buffer.from("%PDF-1.4" + "0".repeat(120)) }),
    /not configured for production/
  );
});
